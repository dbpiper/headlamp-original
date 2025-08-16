import * as fs from 'node:fs';
import * as path from 'node:path';

// eslint-disable-next-line import/no-extraneous-dependencies
import JSON5 from 'json5';

import { ansi, osc8 } from '../ansi';
import { Colors, BackgroundColors } from '../colors';
import type { Ctx } from './context';
import { collapseStacks, stripAnsiSimple, isStackLine } from '../stacks';
import {
  drawRule,
  buildPerFileOverview,
  buildFileBadgeLine,
  drawFailLine,
  buildCodeFrameSection,
  buildPrettyDiffSection,
  buildMessageSection,
  linesFromDetails,
  deepestProjectLoc,
  buildConsoleSection,
  colorStackLine,
  buildThrownSection,
} from './fns';
import { preferredEditorHref } from '../paths';

const colorTokens = {
  pass: Colors.Success,
  fail: Colors.Failure,
  skip: Colors.Skip,
  todo: Colors.Todo,
  passPill: (text: string) => BackgroundColors.Success(ansi.white(` ${text} `)),
  failPill: (text: string) => BackgroundColors.Failure(ansi.white(` ${text} `)),
};

// ---- HTTP Crash Card helpers ----

export type HttpEvent = {
  readonly timestampMs: number;
  readonly kind?: 'response' | 'abort';
  readonly method?: string;
  readonly url?: string;
  readonly route?: string;
  readonly statusCode?: number;
  readonly durationMs?: number;
  readonly contentType?: string;
  readonly requestId?: string;
  readonly json?: unknown;
  readonly bodyPreview?: string;
  readonly testPath?: string;
  readonly currentTestName?: string;
};

export type AssertionEvt = {
  readonly timestampMs?: number;
  readonly matcher?: string;
  readonly expectedNumber?: number;
  readonly receivedNumber?: number;
  readonly message?: string;
  readonly stack?: string;
  readonly testPath?: string;
  readonly currentTestName?: string;
  readonly expectedPreview?: string;
  readonly actualPreview?: string;
};

const by =
  <T>(keySelector: (value: T) => number) =>
  (left: T, right: T) =>
    keySelector(left) - keySelector(right);

const isObject = (candidateValue: unknown): candidateValue is Record<string, unknown> =>
  !!candidateValue && typeof candidateValue === 'object';

const asHttpList = (candidateValue: unknown): readonly HttpEvent[] =>
  Array.isArray(candidateValue) ? (candidateValue as readonly HttpEvent[]) : [];

const summarizeUrl = (method?: string, url?: string, route?: string): string => {
  const base = route || url || '';
  const qs = url && url.includes('?') ? ` ? ${url.split('?')[1]}` : '';
  return [method || '', base, qs].filter(Boolean).join(' ').trim();
};

const stripBridgeEventsFromConsole = (maybeConsole: unknown): unknown => {
  if (!Array.isArray(maybeConsole)) {
    return maybeConsole;
  }
  return (maybeConsole as ReadonlyArray<Record<string, unknown>>).filter((entry) => {
    try {
      const raw = Array.isArray(entry.message)
        ? (entry.message as readonly unknown[]).map(String).join(' ')
        : String((entry as Record<string, unknown>).message ?? '');
      return !raw.includes('[JEST-BRIDGE-EVENT]');
    } catch {
      return true;
    }
  });
};

export const extractBridgePath = (raw: string, cwd: string): string | null => {
  const matches = Array.from(
    raw.matchAll(/Test results written to:\s+([^\n\r]+jest-bridge-[^\s'"]+\.json)/g),
  );
  if (!matches.length) {
    return null;
  }
  const jsonPath = (matches[matches.length - 1][1] ?? '').trim().replace(/^["'`]|["'`]$/g, '');
  return path.isAbsolute(jsonPath) ? jsonPath : path.resolve(cwd, jsonPath).replace(/\\/g, '/');
};

// ---- Transport classification and scoring helpers ----

export const isTransportError = (msg?: string): boolean => {
  const lowercaseMessage = (msg ?? '').toLowerCase();
  return /\bsocket hang up\b|\beconnreset\b|\betimedout\b|\beconnrefused\b|\bwrite epipe\b/.test(
    lowercaseMessage,
  );
};

const envNumber = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// normal window for correlation; stricter window when it's a transport error
const HEADLAMP_HTTP_WINDOW_MS = () => envNumber('HEADLAMP_HTTP_WINDOW_MS', 3000);
const HEADLAMP_HTTP_STRICT_WINDOW_MS = () => envNumber('HEADLAMP_HTTP_STRICT_WINDOW_MS', 600);
const HEADLAMP_HTTP_MIN_SCORE = () => envNumber('HEADLAMP_HTTP_MIN_SCORE', 1200);
const HEADLAMP_HTTP_DIFF_LIMIT = (): number => envNumber('HEADLAMP_HTTP_DIFF_LIMIT', 6);
const HEADLAMP_HTTP_SHOW_MISS = (): boolean => process.env.HEADLAMP_HTTP_MISS === '1';

// Nearby events by time window (and optional same testPath)
const eventsNear = (
  http: readonly HttpEvent[],
  ts?: number,
  testPath?: string,
  windowMs = HEADLAMP_HTTP_WINDOW_MS(),
): readonly HttpEvent[] => {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return [];
  }
  return http.filter((e) => {
    const timeOk = typeof e.timestampMs === 'number' && Math.abs(e.timestampMs - ts) <= windowMs;
    const pathOk = !testPath || e.testPath === testPath;
    return timeOk && pathOk;
  });
};

// tiny parser: "POST /api/v1/mobile/schedule/ShiftClockedIn ..."
// -> { method:'POST', path:'/api/...'}
export const parseMethodPathFromTitle = (title?: string): { method?: string; path?: string } => {
  if (!title) {
    return {};
  }
  const matchResult = title.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+([^\s)]+)/i);
  return matchResult ? { method: matchResult[1]?.toUpperCase(), path: matchResult[2] } : {};
};

// ---- HTTP-likeness heuristics ----

const isHttpStatusNumber = (statusNumber?: number): boolean =>
  typeof statusNumber === 'number' && statusNumber >= 100 && statusNumber <= 599;

const hasStatusSemantics = (assertionLike?: {
  readonly matcher?: string;
  readonly message?: string;
  readonly expectedNumber?: number;
  readonly receivedNumber?: number;
}): boolean => {
  if (!assertionLike) {
    return false;
  }
  if (
    isHttpStatusNumber(assertionLike.expectedNumber) ||
    isHttpStatusNumber(assertionLike.receivedNumber)
  ) {
    return true;
  }
  const combinedRaw = `${assertionLike.matcher ?? ''} ${assertionLike.message ?? ''}`;
  const combinedMessage = combinedRaw.toLowerCase();
  return /\bstatus(code)?\b|\btohaves(tatus|tatuscode)\b/.test(combinedMessage);
};

const fileSuggestsHttp = (relPath: string): boolean =>
  /(?:^|\/)(routes?|api|controllers?|e2e|integration)(?:\/|\.test\.)/i.test(relPath);

type HttpRelevanceCtx = {
  readonly assertion?: AssertionEvt;
  readonly title?: string;
  readonly relPath: string;
  readonly httpCountInSameTest: number;
  readonly hasTransportSignal: boolean;
};

const inferHttpNumbersFromText = (
  lines: string[],
): { readonly expectedNumber?: number; readonly receivedNumber?: number } => {
  const text = lines.join('\n');
  const match = text.match(/Expected:\s*(\d{3})[\s\S]*?Received:\s*(\d{3})/i);
  if (match) {
    return { expectedNumber: Number(match[1]), receivedNumber: Number(match[2]) };
  }
  return {};
};

const titleSuggestsHttp = (title?: string): boolean => {
  const { method, path: parsedPath } = parseMethodPathFromTitle(title);
  return Boolean(method || (parsedPath && parsedPath.startsWith('/')));
};

const isHttpRelevant = (ctx: HttpRelevanceCtx): boolean => {
  const assertionCtx = ctx.assertion;
  return (
    ctx.hasTransportSignal ||
    ctx.httpCountInSameTest > 0 ||
    titleSuggestsHttp(ctx.title) ||
    hasStatusSemantics(assertionCtx) ||
    fileSuggestsHttp(ctx.relPath)
  );
};

// similarity: exact route match >> url contains path prefix >> none
export const routeSimilarityScore = (
  hint: { method?: string; path?: string },
  evt: { method?: string; route?: string; url?: string },
): number => {
  if (!hint.path && !hint.method) {
    return 0;
  }
  const methodOk = hint.method && evt.method ? Number(hint.method === evt.method) : 0;
  const route = evt.route || evt.url || '';
  if (!route) {
    return methodOk * 10;
  }
  if (hint.path && route === hint.path) {
    return 500 + methodOk * 50;
  }
  if (hint.path && route.endsWith(hint.path)) {
    return 300 + methodOk * 50;
  }
  if (hint.path && route.includes(hint.path)) {
    return 200 + methodOk * 50;
  }
  return methodOk * 10;
};

export const scoreHttpForAssertion =
  (assertion: AssertionEvt, titleHint: { method?: string; path?: string }) =>
  (candidateEvent: HttpEvent): number => {
    const tsA = assertion.timestampMs;
    const tsH = candidateEvent.timestampMs;
    const window = isTransportError(assertion.message)
      ? HEADLAMP_HTTP_STRICT_WINDOW_MS()
      : HEADLAMP_HTTP_WINDOW_MS();
    const timeScore =
      typeof tsA === 'number' && typeof tsH === 'number'
        ? Math.max(0, window - Math.abs(tsA - tsH))
        : 0;

    const statusScore =
      typeof assertion.receivedNumber === 'number' &&
      candidateEvent.statusCode === assertion.receivedNumber
        ? 1500
        : typeof assertion.expectedNumber === 'number' &&
            candidateEvent.statusCode === assertion.expectedNumber
          ? 1200
          : (candidateEvent.statusCode ?? 0) >= 400
            ? 800
            : 0;

    const routeScore = routeSimilarityScore(titleHint, candidateEvent);
    const specificity = candidateEvent.route ? 80 : candidateEvent.url ? 40 : 0;

    return timeScore + statusScore + routeScore + specificity;
  };

export const pickRelevantHttp = (
  assertion: AssertionEvt,
  http: readonly HttpEvent[],
  ctx: { readonly testPath?: string; readonly currentTestName?: string; readonly title?: string },
): HttpEvent | undefined => {
  const hint = parseMethodPathFromTitle(ctx.title);
  const nameMatches = (leftName?: string, rightName?: string) =>
    !!leftName &&
    !!rightName &&
    (leftName === rightName || leftName.includes(rightName) || rightName.includes(leftName));
  const sameTest = (
    leftCtx?: { testPath?: string; currentTestName?: string },
    rightCtx?: { testPath?: string; currentTestName?: string },
  ) =>
    !!leftCtx &&
    !!rightCtx &&
    leftCtx.testPath === rightCtx.testPath &&
    nameMatches(leftCtx.currentTestName, rightCtx.currentTestName);

  const strictPool = http.filter(
    (httpEvent) => sameTest(assertion as any, httpEvent as any) || sameTest(ctx, httpEvent as any),
  );

  const windowMs = isTransportError(assertion.message)
    ? HEADLAMP_HTTP_STRICT_WINDOW_MS()
    : HEADLAMP_HTTP_WINDOW_MS();

  let pool = strictPool;
  if (!pool.length) {
    pool = http.filter(
      (e) =>
        e.testPath === ctx.testPath &&
        typeof assertion.timestampMs === 'number' &&
        typeof e.timestampMs === 'number' &&
        Math.abs(e.timestampMs - assertion.timestampMs) <= windowMs,
    );
  }
  if (!pool.length) {
    pool = http.filter(
      (e) =>
        typeof assertion.timestampMs === 'number' &&
        typeof e.timestampMs === 'number' &&
        Math.abs(e.timestampMs - assertion.timestampMs) <= windowMs,
    );
  }
  if (!pool.length) {
    return undefined;
  }

  const scored = pool
    .map((httpEvent) => ({ h: httpEvent, s: scoreHttpForAssertion(assertion, hint)(httpEvent) }))
    .sort((leftScore, rightScore) => rightScore.s - leftScore.s);

  const [best] = scored;
  const threshold = isTransportError(assertion.message)
    ? Math.max(HEADLAMP_HTTP_MIN_SCORE(), 1400)
    : HEADLAMP_HTTP_MIN_SCORE();
  return best && best.s >= threshold ? best.h : undefined;
};

export type BridgeJSON = {
  readonly startTime: number;
  readonly testResults: ReadonlyArray<{
    readonly testFilePath: string;
    readonly status: 'passed' | 'failed';
    readonly failureMessage: string;
    readonly failureDetails?: readonly unknown[];
    readonly testExecError?: unknown | null;
    readonly console?: ReadonlyArray<{ message?: string; type?: string; origin?: string }> | null;
    readonly testResults: ReadonlyArray<{
      readonly title: string;
      readonly fullName: string;
      readonly status: string;
      readonly duration: number;
      readonly location: { readonly line: number; readonly column: number } | null;
      readonly failureMessages: string[];
      readonly failureDetails?: readonly unknown[];
    }>;
  }>;
  readonly aggregated: {
    readonly numTotalTestSuites: number;
    readonly numPassedTestSuites: number;
    readonly numFailedTestSuites: number;
    readonly numTotalTests: number;
    readonly numPassedTests: number;
    readonly numFailedTests: number;
    readonly numPendingTests: number;
    readonly numTodoTests: number;
    readonly startTime: number;
    readonly success: boolean;
    readonly runTimeMs?: number;
  };
};

type JestAssertionResult = {
  readonly title: string;
  readonly ancestorTitles: string[];
  readonly status: string;
  readonly location?: { readonly line: number; readonly column: number } | null;
  readonly failureMessages?: string[];
  readonly failureDetails?: readonly unknown[];
  readonly fullName?: string;
  readonly duration?: number;
};

type JestTestResult = {
  readonly testFilePath?: string;
  readonly name?: string;
  readonly status: 'passed' | 'failed';
  readonly failureMessage?: string;
  readonly assertionResults?: readonly JestAssertionResult[];
  readonly failureDetails?: readonly unknown[];
  readonly console?: ReadonlyArray<{ message?: unknown; type?: unknown; origin?: unknown }> | null;
  readonly perfStats?: Readonly<Record<string, unknown>>;
};

type JestAggregatedResult = {
  readonly startTime: number;
  readonly success: boolean;
  readonly numTotalTestSuites: number;
  readonly numPassedTestSuites: number;
  readonly numFailedTestSuites: number;
  readonly numTotalTests: number;
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly numPendingTests: number;
  readonly numTodoTests: number;
  readonly testResults: readonly JestTestResult[];
};

const isBridgeJSONLike = (candidateValue: unknown): candidateValue is BridgeJSON =>
  !!candidateValue &&
  typeof candidateValue === 'object' &&
  'aggregated' in (candidateValue as Record<string, unknown>);

export const coerceJestJsonToBridge = (raw: unknown): BridgeJSON => {
  if (isBridgeJSONLike(raw)) {
    return raw as BridgeJSON;
  }
  const j = raw as JestAggregatedResult;
  if (!j || !Array.isArray(j.testResults)) {
    throw new Error('Unexpected Jest JSON shape');
  }
  return {
    startTime: Number(j.startTime ?? Date.now()),
    testResults: j.testResults.map((tr) => ({
      testFilePath: tr.testFilePath || tr.name || '',
      status: tr.status,
      failureMessage: tr.failureMessage || '',
      failureDetails: tr.failureDetails ?? [],
      testExecError: (tr as any).testExecError ?? null,
      console: tr.console ?? null,
      testResults: (tr.assertionResults || []).map((assertion: JestAssertionResult) => ({
        title: assertion.title,
        fullName:
          assertion.fullName || [...(assertion.ancestorTitles || []), assertion.title].join(' '),
        status: assertion.status,
        duration: assertion.duration || 0,
        location: assertion.location ?? null,
        failureMessages: assertion.failureMessages || [],
        failureDetails: assertion.failureDetails || [],
      })),
    })),
    aggregated: {
      numTotalTestSuites: j.numTotalTestSuites,
      numPassedTestSuites: j.numPassedTestSuites,
      numFailedTestSuites: j.numFailedTestSuites,
      numTotalTests: j.numTotalTests,
      numPassedTests: j.numPassedTests,
      numFailedTests: j.numFailedTests,
      numPendingTests: j.numPendingTests,
      numTodoTests: j.numTodoTests,
      startTime: j.startTime,
      success: j.success,
    },
  };
};

const vitestFooter = (agg: BridgeJSON['aggregated'], durationMs?: number): string => {
  const files = [
    agg.numFailedTestSuites ? colorTokens.fail(`${agg.numFailedTestSuites} failed`) : '',
    agg.numPassedTestSuites ? colorTokens.pass(`${agg.numPassedTestSuites} passed`) : '',
    agg.numPendingTests ? colorTokens.skip(`${agg.numPendingTests} skipped`) : '',
  ]
    .filter(Boolean)
    .join(ansi.dim(' | '));
  const tests = [
    agg.numFailedTests ? colorTokens.fail(`${agg.numFailedTests} failed`) : '',
    agg.numPassedTests ? colorTokens.pass(`${agg.numPassedTests} passed`) : '',
    agg.numPendingTests ? colorTokens.skip(`${agg.numPendingTests} skipped`) : '',
    agg.numTodoTests ? colorTokens.todo(`${agg.numTodoTests} todo`) : '',
  ]
    .filter(Boolean)
    .join(ansi.dim(' | '));
  const time =
    durationMs != null
      ? `${Math.max(0, Math.round(durationMs))}ms`
      : typeof agg.runTimeMs === 'number'
        ? `${Math.max(0, Math.round(agg.runTimeMs))}ms`
        : '';
  const thread = ansi.dim('(in thread 0ms, 0.00%)');
  return [
    `${ansi.bold('Test Files')} ${files} ${ansi.dim(`(${agg.numTotalTestSuites})`)}`,
    `${ansi.bold('Tests')}     ${tests} ${ansi.dim(`(${agg.numTotalTests})`)}`,
    `${ansi.bold('Time')}      ${time} ${thread}`,
  ].join('\n');
};

export const renderVitestFromJestJSON = (
  data: BridgeJSON,
  ctx: Ctx,
  opts?: { readonly onlyFailures?: boolean },
): string => {
  const out: string[] = [];
  const onlyFailures = Boolean(opts?.onlyFailures);
  // Top RUN line (hide when onlyFailures)
  if (!onlyFailures) {
    out.push(`${BackgroundColors.Run(ansi.white(' RUN '))} ${ansi.dim(ctx.cwd)}`, '');
  }
  for (const file of data.testResults) {
    const rel = file.testFilePath.replace(/\\/g, '/').replace(`${ctx.cwd}/`, '');
    const failed = file.testResults.filter((assertion) => assertion.status === 'failed');
    // Per-file overview list (hide when onlyFailures)
    if (!onlyFailures) {
      out.push(...buildPerFileOverview(rel, file.testResults));
    }
    // File header block with PASS/FAIL badge
    if (!(onlyFailures && failed.length === 0)) {
      out.push(buildFileBadgeLine(rel, failed.length));
    }
    // Parse bridge events once per file; use them later per assertion
    let httpSorted: ReadonlyArray<HttpEvent> = [];
    let assertionEvents: ReadonlyArray<AssertionEvt> = [];
    {
      const parseBridge = (
        consoleEntries: unknown,
      ): { http: readonly HttpEvent[]; assertions: readonly AssertionEvt[] } => {
        const http: HttpEvent[] = [];
        const assertions: AssertionEvt[] = [];
        if (!Array.isArray(consoleEntries)) {
          return { http, assertions };
        }
        for (const entry of consoleEntries) {
          const rec = entry as Record<string, unknown>;
          const rawMsgVal = rec && typeof rec.message !== 'undefined' ? rec.message : '';
          const raw = Array.isArray(rawMsgVal)
            ? (rawMsgVal as unknown[]).map(String).join(' ')
            : String(rawMsgVal ?? '');
          if (!raw.includes('[JEST-BRIDGE-EVENT]')) {
            // eslint-disable-next-line no-continue
            continue;
          }
          const jsonText = raw.split('[JEST-BRIDGE-EVENT]').pop()?.trim() ?? '';
          try {
            const evt = JSON5.parse(jsonText) as Record<string, unknown>;
            const type = evt?.type as string | undefined;
            if (type === 'httpResponse') {
              const timestampMs = Number((evt as any).timestampMs ?? Date.now());
              http.push({
                kind: 'response',
                timestampMs,
                method: (evt as any).method,
                url: (evt as any).url,
                route: (evt as any).route,
                statusCode: (evt as any).statusCode,
                durationMs: (evt as any).durationMs,
                contentType: (evt as any).contentType,
                requestId: (evt as any).requestId,
                json: (evt as any).json,
                bodyPreview: (evt as any).bodyPreview,
                testPath: (evt as any).testPath as string | undefined,
                currentTestName: (evt as any).currentTestName as string | undefined,
              });
            } else if (type === 'httpAbort') {
              http.push({
                kind: 'abort',
                timestampMs: Number((evt as any).timestampMs ?? Date.now()),
                method: (evt as any).method,
                url: (evt as any).url,
                route: (evt as any).route,
                durationMs: (evt as any).durationMs,
                testPath: (evt as any).testPath as string | undefined,
                currentTestName: (evt as any).currentTestName as string | undefined,
              });
            } else if (type === 'httpResponseBatch') {
              const list = asHttpList((evt as any)?.events);
              for (const item of list) {
                const anyItem = item as any;
                http.push({
                  timestampMs: Number(anyItem.timestampMs ?? Date.now()),
                  method: anyItem.method,
                  url: anyItem.url,
                  route: anyItem.route,
                  statusCode: anyItem.statusCode,
                  durationMs: anyItem.durationMs,
                  contentType: anyItem.contentType,
                  requestId: anyItem.requestId,
                  json: anyItem.json,
                  bodyPreview: anyItem.bodyPreview,
                  testPath: (evt as any).testPath as string | undefined,
                  currentTestName: (evt as any).currentTestName as string | undefined,
                });
              }
            } else if (type === 'assertionFailure') {
              assertions.push({
                timestampMs:
                  typeof (evt as any).timestampMs === 'number'
                    ? ((evt as any).timestampMs as number)
                    : undefined,
                matcher: (evt as any).matcher,
                expectedNumber:
                  typeof (evt as any).expectedNumber === 'number'
                    ? ((evt as any).expectedNumber as number)
                    : undefined,
                receivedNumber:
                  typeof (evt as any).receivedNumber === 'number'
                    ? ((evt as any).receivedNumber as number)
                    : undefined,
                message:
                  typeof (evt as any).message === 'string'
                    ? ((evt as any).message as string)
                    : undefined,
                stack:
                  typeof (evt as any).stack === 'string'
                    ? ((evt as any).stack as string)
                    : undefined,
                testPath: (evt as any).testPath as string | undefined,
                currentTestName: (evt as any).currentTestName as string | undefined,
                expectedPreview:
                  typeof (evt as any).expectedPreview === 'string'
                    ? ((evt as any).expectedPreview as string)
                    : undefined,
                actualPreview:
                  typeof (evt as any).actualPreview === 'string'
                    ? ((evt as any).actualPreview as string)
                    : undefined,
              });
            }
          } catch {
            /* ignore malformed */
          }
        }
        return { http, assertions };
      };

      const parsed = parseBridge(file.console);
      httpSorted = [...parsed.http].sort(by<HttpEvent>((event) => event.timestampMs));
      assertionEvents = parsed.assertions;
    }
    const inSameCtx = (testPath?: string, testName?: string) =>
      httpSorted.filter(
        (event) => event.testPath === testPath && event.currentTestName === testName,
      );
    // File-level failure when there are NO per-assertion failures
    if (file.failureMessage || file.testExecError) {
      const lines = file.failureMessage.split(/\r?\n/);
      const combinedDetails = (() => {
        const base = linesFromDetails(file.failureDetails);
        const exec = linesFromDetails(
          Array.isArray(file.testExecError)
            ? (file.testExecError as unknown[])
            : [file.testExecError],
        );
        return {
          stacks: [...base.stacks, ...exec.stacks],
          messages: [...base.messages, ...exec.messages],
        };
      })();
      const mergedForStack = collapseStacks([...lines, ...combinedDetails.stacks]);
      const synthLoc = deepestProjectLoc(mergedForStack, ctx.projectHint);
      out.push(...buildCodeFrameSection(lines, ctx, synthLoc));
      const payloadPretty = buildPrettyDiffSection(file.failureDetails, lines);
      out.push(...payloadPretty);
      const hasPretty = payloadPretty.length > 0;
      const stackPreview = ctx.showStacks
        ? mergedForStack
            .filter((ln) => isStackLine(stripAnsiSimple(ln)))
            .filter((ln) => ctx.projectHint.test(stripAnsiSimple(ln)))
            .slice(0, 2)
            .map((ln) => `      ${colorStackLine(String(ln), ctx.projectHint)}`)
        : [];
      out.push(
        ...buildMessageSection(lines, combinedDetails, ctx, {
          suppressDiff: hasPretty,
          stackPreview,
        }),
      );
      out.push(...buildConsoleSection(stripBridgeEventsFromConsole(file.console ?? null)));
      // full stack tail if not inlined
      if (ctx.showStacks && stackPreview.length === 0) {
        const tail = mergedForStack
          .filter((ln) => isStackLine(stripAnsiSimple(ln)))
          .slice(-4)
          .map((ln) => `      ${colorStackLine(String(ln), ctx.projectHint)}`);
        if (tail.length) {
          out.push(ansi.dim('    Stack:'), ...tail, '');
        }
      }
    }
    for (const assertion of failed) {
      out.push(drawFailLine());
      const header = `${rel} > ${assertion.fullName}`;
      const messagesArray: string[] = (() => {
        if (assertion.failureMessages && assertion.failureMessages.length > 0) {
          return assertion.failureMessages;
        }
        if (file.failureMessage && file.failureMessage.trim().length > 0) {
          return file.failureMessage.split(/\r?\n/);
        }
        // Fallbacks: use matcherResult.message from failureDetails if present
        const linesFromMatcher = linesFromDetails(
          assertion.failureDetails || file.failureDetails,
        ).messages;
        if (Array.isArray(linesFromMatcher) && linesFromMatcher.length > 0) {
          return linesFromMatcher;
        }
        return [''];
      })();
      const details = linesFromDetails(assertion.failureDetails || file.failureDetails);
      // Prefer explicit matcher message if present in failureDetails
      const matcherMsg = (() => {
        try {
          const arr = (assertion.failureDetails || file.failureDetails) as
            | readonly unknown[]
            | undefined;
          if (!arr) {
            return [] as string[];
          }
          for (const detailEntry of arr) {
            const obj =
              detailEntry && typeof detailEntry === 'object'
                ? (detailEntry as Record<string, unknown>)
                : null;
            const mr =
              obj && obj.matcherResult && typeof obj.matcherResult === 'object'
                ? (obj.matcherResult as Record<string, unknown>)
                : null;
            if (mr && typeof mr.message === 'string' && mr.message.trim()) {
              const name = typeof mr.matcherName === 'string' ? mr.matcherName : '';
              const matcherHeader = name ? `    ${ansi.bold('Matcher:')} ${ansi.yellow(name)}` : '';
              const bodyHeader = `    ${ansi.bold('Message:')}`;
              const body = String(mr.message)
                .split(/\r?\n/)
                .slice(0, 6)
                .map((ln) => `    ${ansi.yellow(ln)}`);
              return [matcherHeader, bodyHeader, ...body, ''].filter(Boolean) as string[];
            }
          }
        } catch {
          /* ignore */
        }
        return [] as string[];
      })();
      const mergedForStack = collapseStacks([...messagesArray, ...details.stacks]);
      const deepestLoc = deepestProjectLoc(mergedForStack, ctx.projectHint);
      const locLink = deepestLoc
        ? (() => {
            const href = preferredEditorHref(deepestLoc.file, deepestLoc.line, ctx.editorCmd);
            const base = `${deepestLoc.file.split('/').pop()}:${deepestLoc.line}`;
            return osc8(base, href);
          })()
        : undefined;
      const bullet = (text: string) => `${Colors.Failure('×')} ${ansi.white(text)}`;
      const headerLine = `${ansi.white(header)}${locLink ? `  ${ansi.dim(`(${locLink})`)}` : ''}`;
      out.push(bullet(headerLine));
      const msgLines = messagesArray.join('\n').split('\n');
      const assertFallback =
        deepestLoc ||
        (assertion.location && { file: file.testFilePath, line: assertion.location.line });
      out.push('', ...buildCodeFrameSection(msgLines, ctx, assertFallback || undefined), '');
      const pretty = buildPrettyDiffSection(
        assertion.failureDetails || file.failureDetails,
        msgLines,
      );
      out.push(...pretty);
      const hasPretty = pretty.length > 0;
      const stackPreview = ctx.showStacks
        ? mergedForStack
            .filter((ln) => isStackLine(stripAnsiSimple(ln)))
            .filter((ln) => ctx.projectHint.test(stripAnsiSimple(ln)))
            .slice(0, 2)
            .map((ln) => `      ${colorStackLine(String(ln), ctx.projectHint)}`)
        : [];
      if (matcherMsg.length) {
        out.push(...matcherMsg);
      }
      out.push(
        ...buildMessageSection(msgLines, details, ctx, { suppressDiff: hasPretty, stackPreview }),
      );
      // ---- Compact HTTP Cause Card per failed assertion ----
      {
        type JsonPathChange = {
          readonly path: string;
          readonly kind: 'added' | 'removed' | 'changed';
          readonly preview?: string;
        };
        const HEADLAMP_HTTP_DIFF_LIMIT_LOCAL = (): number => HEADLAMP_HTTP_DIFF_LIMIT();
        const safeParseJSON = (text?: string): unknown | undefined => {
          try {
            return text ? JSON5.parse(text) : undefined;
          } catch {
            return undefined;
          }
        };
        const jsonDiff = (
          expected: unknown,
          actual: unknown,
          limit = HEADLAMP_HTTP_DIFF_LIMIT_LOCAL(),
        ): readonly JsonPathChange[] => {
          const outChanges: JsonPathChange[] = [];
          const queue: Array<{ pathSoFar: string; expectedValue: unknown; actualValue: unknown }> =
            [];
          queue.push({
            pathSoFar: '$',
            expectedValue: expected,
            actualValue: actual,
          });
          while (queue.length && outChanges.length < limit) {
            const { pathSoFar, expectedValue, actualValue } = queue.shift()!;
            const expectedIsObj = expectedValue && typeof expectedValue === 'object';
            const actualIsObj = actualValue && typeof actualValue === 'object';
            if (!expectedIsObj && !actualIsObj) {
              if (JSON.stringify(expectedValue) !== JSON.stringify(actualValue)) {
                outChanges.push({
                  kind: 'changed',
                  path: pathSoFar,
                  preview: `${String(expectedValue)} → ${String(actualValue)}`,
                });
              }
            } else if (expectedIsObj && !actualIsObj) {
              outChanges.push({
                kind: 'changed',
                path: pathSoFar,
                preview: '[object] → primitive',
              });
            } else if (!expectedIsObj && actualIsObj) {
              outChanges.push({
                kind: 'changed',
                path: pathSoFar,
                preview: 'primitive → [object]',
              });
            } else {
              const expectedKeys = new Set(Object.keys(expectedValue as Record<string, unknown>));
              const actualKeys = new Set(Object.keys(actualValue as Record<string, unknown>));
              for (const key of expectedKeys) {
                if (!actualKeys.has(key) && outChanges.length < limit) {
                  outChanges.push({ kind: 'removed', path: `${pathSoFar}.${key}` });
                }
              }
              for (const key of actualKeys) {
                if (!expectedKeys.has(key) && outChanges.length < limit) {
                  outChanges.push({ kind: 'added', path: `${pathSoFar}.${key}` });
                }
              }
              for (const key of expectedKeys) {
                if (actualKeys.has(key) && outChanges.length < limit) {
                  queue.push({
                    pathSoFar: `${pathSoFar}.${key}`,
                    expectedValue: (expectedValue as any)[key],
                    actualValue: (actualValue as any)[key],
                  });
                }
              }
            }
          }
          return outChanges;
        };
        const importantMessages = (json: unknown): readonly string[] => {
          const msgs: string[] = [];
          try {
            const obj = isObject(json) ? json : {};
            const pushMaybe = (candidate?: unknown) => {
              if (typeof candidate === 'string' && candidate.trim()) {
                msgs.push(candidate);
              }
            };
            (pushMaybe as any)((obj as any).displayMessage);
            (pushMaybe as any)((obj as any).message);
            if (Array.isArray((obj as any).errors)) {
              for (const element of (obj as any).errors as unknown[]) {
                pushMaybe(isObject(element) ? (element as any).message : undefined);
              }
            }
            if (Array.isArray((obj as any).data)) {
              for (const element of (obj as any).data as unknown[]) {
                pushMaybe(isObject(element) ? (element as any).message : undefined);
              }
            }
          } catch {
            /* ignore */
          }
          return msgs.slice(0, 2);
        };

        const nameMatches = (leftName?: string, rightName?: string) =>
          !!leftName &&
          !!rightName &&
          (leftName === rightName || leftName.includes(rightName) || rightName.includes(leftName));
        const corresponding =
          assertionEvents.find(
            (aevt) =>
              aevt.testPath === file.testFilePath &&
              nameMatches(aevt.currentTestName, assertion.title as string),
          ) ?? (assertion as unknown as AssertionEvt);

        const perTestSlice = inSameCtx(file.testFilePath, assertion.title as string);
        const nearByTime = eventsNear(
          httpSorted,
          (corresponding as any)?.timestampMs as number | undefined,
          file.testFilePath,
        );
        const hasAbort = perTestSlice.some((event) => event.kind === 'abort');
        const hasTransport = isTransportError((corresponding as any)?.message) || hasAbort;

        const httpLikely = isHttpRelevant({
          assertion: corresponding as AssertionEvt,
          title: assertion.fullName,
          relPath: rel,
          httpCountInSameTest: perTestSlice.length || nearByTime.length,
          hasTransportSignal: hasTransport,
        });

        if (!httpLikely) {
          /* no http section */
        } else {
          const expPreview = (corresponding as any)?.expectedPreview as string | undefined;
          const actPreview = (corresponding as any)?.actualPreview as string | undefined;
          const parsedExpected = safeParseJSON(expPreview);
          const parsedActual = safeParseJSON(actPreview);

          let corr = corresponding as AssertionEvt;
          if (
            !isHttpStatusNumber(corr.expectedNumber) &&
            !isHttpStatusNumber(corr.receivedNumber)
          ) {
            const inferred = inferHttpNumbersFromText(msgLines);
            if (
              isHttpStatusNumber(inferred.expectedNumber) ||
              isHttpStatusNumber(inferred.receivedNumber)
            ) {
              corr = { ...corr, ...inferred } as AssertionEvt;
            }
          }

          const relevant = pickRelevantHttp(
            {
              timestampMs: (corr as any)?.timestampMs,
              expectedNumber: (corr as any)?.expectedNumber,
              receivedNumber: (corr as any)?.receivedNumber,
              matcher: (corr as any)?.matcher,
              message: (corr as any)?.message,
              stack: (corr as any)?.stack,
              testPath: file.testFilePath,
              currentTestName: assertion.title,
            },
            httpSorted,
            {
              testPath: file.testFilePath,
              currentTestName: assertion.title as string,
              title: assertion.fullName,
            },
          );

          if (hasTransport) {
            const tsBase = ((corresponding as any)?.timestampMs ?? 0) as number;
            const abortCandidates = perTestSlice
              .filter((event) => event.kind === 'abort')
              .sort((leftEvent, rightEvent) => {
                const deltaLeft = Math.abs(tsBase - (leftEvent.timestampMs ?? 0));
                const deltaRight = Math.abs(tsBase - (rightEvent.timestampMs ?? 0));
                return deltaLeft - deltaRight;
              });
            const [nearestAbort] = abortCandidates;
            if (nearestAbort) {
              out.push(
                '  HTTP:',
                `\n    ${summarizeUrl(nearestAbort.method, nearestAbort.url, nearestAbort.route)} ${ansi.dim('->')} ${ansi.yellow('connection aborted')}`,
                (() => {
                  const ms = nearestAbort.durationMs;
                  return ms != null ? ` ${ansi.dim(`(${ms}ms)`)} ` : '';
                })(),
                '\n',
              );
            } else if (relevant) {
              // fall through to normal rendering below
            } else if (HEADLAMP_HTTP_SHOW_MISS()) {
              out.push(
                '  HTTP:',
                `\n    ${ansi.dim('Transport error; no matching HTTP exchange in window.')}`,
                '\n',
              );
            }
          }

          if (!hasTransport && relevant) {
            const parts: string[] = [];
            const where = summarizeUrl(relevant.method, relevant.url, relevant.route);
            const line1 = [
              '  HTTP:',
              `\n    ${where} ${ansi.dim('->')} ${relevant.statusCode ?? '?'}`,
              (() => {
                const ms = relevant.durationMs;
                return typeof ms === 'number' ? ` ${ansi.dim(`(${ms}ms)`)} ` : ' ';
              })(),
              relevant.contentType ? ansi.dim(`(${relevant.contentType})`) : '',
              relevant.requestId ? ansi.dim(`  reqId=${relevant.requestId}`) : '',
            ].join('');
            const expVsAct = (() => {
              if (
                typeof (corresponding as any)?.expectedNumber === 'number' ||
                typeof (corresponding as any)?.receivedNumber === 'number'
              ) {
                const exp =
                  (corresponding as any)?.expectedNumber != null
                    ? String((corresponding as any).expectedNumber)
                    : '?';
                const got =
                  (corresponding as any)?.receivedNumber != null
                    ? String((corresponding as any).receivedNumber)
                    : String(relevant.statusCode ?? '?');
                return `\n      Expected: ${ansi.yellow(exp)}   Received: ${ansi.yellow(got)}`;
              }
              return '';
            })();
            const whyLines = importantMessages(relevant.json)
              .map((msg) => `\n      Why: ${ansi.white(msg)}`)
              .slice(0, 1)
              .join('');
            const diffLines = (() => {
              const rightActual = parsedActual ?? relevant.json;
              if (!parsedExpected || !rightActual) {
                return '';
              }
              const changes = jsonDiff(parsedExpected, rightActual);
              if (!changes.length) {
                return '';
              }
              const head = '\n      Diff:';
              const body = changes
                .map((change) => {
                  const marker =
                    change.kind === 'added' ? '+' : change.kind === 'removed' ? '-' : '~';
                  const previewText = change.preview ? `: ${ansi.dim(change.preview)}` : '';
                  return `\n        ${marker} ${change.path}${previewText}`;
                })
                .join('');
              return head + body;
            })();
            parts.push(line1, expVsAct, whyLines, diffLines, '\n');
            out.push(...parts.filter(Boolean));
          } else if (!hasTransport && !relevant && HEADLAMP_HTTP_SHOW_MISS()) {
            out.push(
              '  HTTP:',
              `\n    ${ansi.dim('No relevant HTTP exchange found. (HEADLAMP_HTTP_MISS=0 to hide)')}`,
              '\n',
            );
          }
        }
      }
      // If still little context, print a compact thrown object section
      const minimalInfo = msgLines.every((ln) => !ln.trim());
      if (minimalInfo) {
        try {
          out.push(...buildThrownSection(assertion.failureDetails || []));
        } catch {
          /* ignore thrown section errors */
        }
      }
      // include any captured console error output for this file
      out.push(...buildConsoleSection(stripBridgeEventsFromConsole(file.console ?? null)));
      // full stack tail if not inlined
      if (ctx.showStacks && stackPreview.length === 0) {
        const tail = mergedForStack
          .filter((ln) => isStackLine(stripAnsiSimple(ln)))
          .slice(-4)
          .map((ln) => `      ${colorStackLine(String(ln), ctx.projectHint)}`);
        if (tail.length) {
          out.push(ansi.dim('    Stack:'), ...tail, '');
        }
      }
      out.push(drawFailLine(), '');
    }
  }
  // Dashed rule + right-aligned pill (always show final summary)
  const failedCount = data.aggregated.numFailedTests;
  out.push(drawRule(BackgroundColors.Failure(ansi.white(` Failed Tests ${failedCount} `))));
  out.push('');
  out.push(vitestFooter(data.aggregated));
  return out.join('\n');
};

export const tryBridgeFallback = (
  raw: string,
  ctx: Ctx,
  opts?: { readonly onlyFailures?: boolean },
): string | null => {
  const bridgeJsonPath = extractBridgePath(raw, ctx.cwd);
  if (!bridgeJsonPath || !fs.existsSync(bridgeJsonPath)) {
    return null;
  }
  try {
    const json = JSON5.parse(fs.readFileSync(bridgeJsonPath, 'utf8'));
    const bridge = coerceJestJsonToBridge(json);
    return renderVitestFromJestJSON(bridge, ctx, opts);
  } catch {
    return null;
  }
};

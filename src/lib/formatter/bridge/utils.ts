// eslint-disable-next-line import/no-extraneous-dependencies
import JSON5 from 'json5';

import { ansi, osc8 } from '../../ansi';
import { Colors, BackgroundColors } from '../../colors';
import type { Ctx } from '../context';
import { collapseStacks, stripAnsiSimple, isStackLine } from '../../stacks';
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
} from '../fns';
import { preferredEditorHref } from '../../paths';
import type { BridgeJSON, HttpEvent, AssertionEvt } from './types';
import { pipe } from '../../fp';
import {
  isHttpRelevant,
  asHttpList,
  eventsNear,
  isHttpStatusNumber,
  inferHttpNumbersFromText,
  summarizeUrl,
  pickRelevantHttp,
  isTransportError,
  HEADLAMP_HTTP_DIFF_LIMIT,
  HEADLAMP_HTTP_SHOW_MISS,
} from './http';

export type Lines = readonly string[];
export type RenderEnv = { readonly ctx: Ctx; readonly onlyFailures: boolean };

const colorTokens = {
  pass: Colors.Success,
  fail: Colors.Failure,
  skip: Colors.Skip,
  todo: Colors.Todo,
  passPill: (text: string) => BackgroundColors.Success(ansi.white(` ${text} `)),
  failPill: (text: string) => BackgroundColors.Failure(ansi.white(` ${text} `)),
};

export const joinLines = (chunks: Lines): string => chunks.join('\n');
export const empty: Lines = [];
export const concat = (...xs: Lines[]): Lines => xs.flat();
export const when =
  <A>(predicate: (arg: A) => boolean, func: (arg: A) => Lines) =>
  (arg: A): Lines =>
    predicate(arg) ? func(arg) : empty;
const by =
  <T>(keySelector: (value: T) => number) =>
  (left: T, right: T) =>
    keySelector(left) - keySelector(right);

export type JsonObject = Readonly<Record<string, unknown>>;

export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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

export const parseBridgeConsole = (
  consoleEntries: unknown,
): { readonly http: readonly HttpEvent[]; readonly assertions: readonly AssertionEvt[] } => {
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
            typeof (evt as any).message === 'string' ? ((evt as any).message as string) : undefined,
          stack:
            typeof (evt as any).stack === 'string' ? ((evt as any).stack as string) : undefined,
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

export const renderRunHeader = ({ ctx, onlyFailures }: RenderEnv): Lines =>
  onlyFailures ? empty : [`${BackgroundColors.Run(ansi.white(' RUN '))} ${ansi.dim(ctx.cwd)}`, ''];

export const renderPerFileOverviewBlock = (
  rel: string,
  testResults: BridgeJSON['testResults'][number]['testResults'],
  onlyFailures: boolean,
): Lines => (onlyFailures ? empty : buildPerFileOverview(rel, testResults));

export const renderFileBadge = (rel: string, failedCount: number, onlyFailures: boolean): Lines =>
  onlyFailures && failedCount === 0 ? empty : [buildFileBadgeLine(rel, failedCount)];

export const condenseBlankRuns = (lines: readonly string[]): string[] => {
  const out: string[] = [];
  let lastBlank = false;
  for (const ln of lines) {
    const isBlank = !stripAnsiSimple(String(ln ?? '')).trim();
    if (isBlank) {
      if (!lastBlank) {
        out.push('');
      }
      lastBlank = true;
    } else {
      out.push(String(ln));
      lastBlank = false;
    }
  }
  return out;
};

export const mergeMsgLines = (primaryRaw: string, detailMsgs: readonly string[]): string[] => {
  const primary = primaryRaw.trim() ? primaryRaw.split(/\r?\n/) : [];
  const key = (line: string) => stripAnsiSimple(line).trim();
  const seen = new Set(primary.map(key));

  const merged: string[] = [...primary];
  for (const msg of detailMsgs) {
    const msgKey = key(String(msg ?? ''));
    if (!msgKey) {
      // eslint-disable-next-line no-continue
      continue;
    } // ignore extra empties
    if (!seen.has(msgKey)) {
      merged.push(msg);
      seen.add(msgKey);
    }
  }
  return condenseBlankRuns(merged);
};

export const renderFileLevelFailure = (
  file: BridgeJSON['testResults'][number],
  ctx: Ctx,
): Lines => {
  if (!(file.failureMessage || (file as any).testExecError)) {
    return empty;
  }

  const base = linesFromDetails(file.failureDetails);
  const exec = linesFromDetails(
    Array.isArray((file as any).testExecError)
      ? ((file as any).testExecError as unknown[])
      : [(file as any).testExecError],
  );
  const combinedDetails = {
    stacks: [...base.stacks, ...exec.stacks],
    messages: [...base.messages, ...exec.messages],
  };

  const msgLines: string[] = mergeMsgLines(file.failureMessage || '', combinedDetails.messages);

  const mergedForStack = collapseStacks([...msgLines, ...combinedDetails.stacks]);
  const synthLoc = deepestProjectLoc(mergedForStack, ctx.projectHint);

  const stackPreview = ctx.showStacks
    ? mergedForStack
        .filter((ln) => isStackLine(stripAnsiSimple(ln)))
        .filter((ln) => ctx.projectHint.test(stripAnsiSimple(ln)))
        .slice(0, 2)
        .map((ln) => `      ${colorStackLine(String(ln), ctx.projectHint)}`)
    : [];

  const code = buildCodeFrameSection(msgLines, ctx, synthLoc);
  const pretty = buildPrettyDiffSection(file.failureDetails, msgLines);
  const message = buildMessageSection(msgLines, combinedDetails, ctx, {
    suppressDiff: pretty.length > 0,
    stackPreview,
  });
  const consoleBlock = buildConsoleSection(stripBridgeEventsFromConsole(file.console ?? null));

  const stackTail: Lines =
    ctx.showStacks && stackPreview.length === 0
      ? (() => {
          const tail = mergedForStack
            .filter((ln) => isStackLine(stripAnsiSimple(ln)))
            .slice(-4)
            .map((ln) => `      ${colorStackLine(String(ln), ctx.projectHint)}`);
          return tail.length ? [ansi.dim('    Stack:'), ...tail, ''] : empty;
        })()
      : empty;

  return concat(code, pretty, message, consoleBlock, stackTail);
};

export const renderHttpCard = (args: {
  readonly file: BridgeJSON['testResults'][number];
  readonly relPath: string;
  readonly assertion: BridgeJSON['testResults'][number]['testResults'][number];
  readonly assertionEvents: readonly AssertionEvt[];
  readonly httpSorted: readonly HttpEvent[];
}): Lines => {
  const { file, relPath: rel, assertion, assertionEvents, httpSorted } = args;

  const nameMatches = (left?: string, right?: string) =>
    !!left && !!right && (left === right || left.includes(right) || right.includes(left));

  const inSameCtx = (testPath?: string, testName?: string) =>
    httpSorted.filter(
      (event) => event.testPath === testPath && nameMatches(event.currentTestName, testName),
    );

  const perTestSlice = inSameCtx(file.testFilePath, assertion.fullName as string);

  const corresponding =
    assertionEvents.find(
      (event) =>
        event.testPath === file.testFilePath &&
        nameMatches(event.currentTestName, assertion.fullName as string),
    ) ?? (assertion as unknown as AssertionEvt);

  const nearByTime = eventsNear(
    httpSorted,
    (corresponding as any)?.timestampMs as number | undefined,
    file.testFilePath,
  );

  const hasAbort = perTestSlice.some((event) => event.kind === 'abort');
  const hasTransport = isTransportError((corresponding as any)?.message) || hasAbort;

  const httpLikely = isHttpRelevant({
    assertion: corresponding,
    title: assertion.fullName,
    relPath: rel,
    httpCountInSameTest: perTestSlice.length || nearByTime.length,
    hasTransportSignal: hasTransport,
  });

  if (!httpLikely) {
    return empty;
  }

  const HEADLAMP_HTTP_DIFF_LIMIT_LOCAL = (): number => HEADLAMP_HTTP_DIFF_LIMIT();
  const safeParseJSON = (text?: string): unknown | undefined => {
    try {
      return text ? JSON5.parse(text) : undefined;
    } catch {
      return undefined;
    }
  };

  const expPreview = (corresponding as any)?.expectedPreview as string | undefined;
  const actPreview = (corresponding as any)?.actualPreview as string | undefined;
  const parsedExpected = safeParseJSON(expPreview);
  const parsedActual = safeParseJSON(actPreview);

  let corr = corresponding as AssertionEvt;
  if (!isHttpStatusNumber(corr.expectedNumber) && !isHttpStatusNumber(corr.receivedNumber)) {
    const inferred = inferHttpNumbersFromText(
      (assertion.failureMessages?.join('\n') || file.failureMessage || '').split('\n'),
    );
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
      currentTestName: assertion.fullName as string,
      title: assertion.fullName,
    },
  );

  if (hasTransport) {
    const tsBase = ((corr as any)?.timestampMs ?? 0) as number;
    const [nearestAbort] = perTestSlice
      .filter((event) => event.kind === 'abort')
      .sort(
        (left, right) =>
          Math.abs(tsBase - (left.timestampMs ?? 0)) - Math.abs(tsBase - (right.timestampMs ?? 0)),
      );

    if (nearestAbort) {
      const ms = nearestAbort.durationMs;
      return [
        '  HTTP:',
        `\n    ${summarizeUrl(nearestAbort.method, nearestAbort.url, nearestAbort.route)} ${ansi.dim('->')} ${ansi.yellow('connection aborted')}`,
        ms != null ? ` ${ansi.dim(`(${ms}ms)`)} ` : '',
        '\n',
      ];
    }
    return HEADLAMP_HTTP_SHOW_MISS()
      ? [
          '  HTTP:',
          `\n    ${ansi.dim('Transport error; no matching HTTP exchange in window.')}`,
          '\n',
        ]
      : empty;
  }

  if (!relevant) {
    return HEADLAMP_HTTP_SHOW_MISS()
      ? [
          '  HTTP:',
          `\n    ${ansi.dim('No relevant HTTP exchange found. (HEADLAMP_HTTP_MISS=0 to hide)')}`,
          '\n',
        ]
      : empty;
  }

  const jsonDiff = (
    expected: unknown,
    actual: unknown,
    limit = HEADLAMP_HTTP_DIFF_LIMIT_LOCAL(),
  ): readonly {
    readonly path: string;
    readonly kind: 'added' | 'removed' | 'changed';
    readonly preview?: string;
  }[] => {
    const out: Array<{ path: string; kind: 'added' | 'removed' | 'changed'; preview?: string }> =
      [];
    const queue: Array<{ pathSoFar: string; expectedValue: unknown; actualValue: unknown }> = [
      { pathSoFar: '$', expectedValue: expected, actualValue: actual },
    ];
    while (queue.length && out.length < limit) {
      const { pathSoFar, expectedValue, actualValue } = queue.shift()!;
      const expectedIsObject = expectedValue && typeof expectedValue === 'object';
      const actualIsObject = actualValue && typeof actualValue === 'object';
      if (!expectedIsObject && !actualIsObject) {
        if (JSON.stringify(expectedValue) !== JSON.stringify(actualValue)) {
          out.push({
            kind: 'changed',
            path: pathSoFar,
            preview: `${String(expectedValue)} → ${String(actualValue)}`,
          });
        }
      } else if (expectedIsObject && !actualIsObject) {
        out.push({ kind: 'changed', path: pathSoFar, preview: '[object] → primitive' });
      } else if (!expectedIsObject && actualIsObject) {
        out.push({ kind: 'changed', path: pathSoFar, preview: 'primitive → [object]' });
      } else {
        const expectedKeys = new Set(Object.keys(expectedValue as Record<string, unknown>));
        const actualKeys = new Set(Object.keys(actualValue as Record<string, unknown>));
        for (const key of expectedKeys) {
          if (!actualKeys.has(key) && out.length < limit) {
            out.push({ kind: 'removed', path: `${pathSoFar}.${key}` });
          }
        }
        for (const key of actualKeys) {
          if (!expectedKeys.has(key) && out.length < limit) {
            out.push({ kind: 'added', path: `${pathSoFar}.${key}` });
          }
        }
        for (const key of expectedKeys) {
          if (actualKeys.has(key) && out.length < limit) {
            queue.push({
              pathSoFar: `${pathSoFar}.${key}`,
              expectedValue: (expectedValue as any)[key],
              actualValue: (actualValue as any)[key],
            });
          }
        }
      }
    }
    return out;
  };

  const importantMessages = (json: unknown): readonly string[] => {
    const msgs: string[] = [];
    try {
      const obj = isObject(json) ? json : {};
      const push = (msg?: unknown) => {
        if (typeof msg === 'string' && msg.trim()) {
          msgs.push(msg);
        }
      };
      push((obj as any).displayMessage);
      push((obj as any).message);
      if (Array.isArray((obj as any).errors)) {
        for (const event of (obj as any).errors as unknown[]) {
          push(isObject(event) ? (event as any).message : undefined);
        }
      }
      if (Array.isArray((obj as any).data)) {
        for (const event of (obj as any).data as unknown[]) {
          push(isObject(event) ? (event as any).message : undefined);
        }
      }
    } catch {
      /* ignore errors */
    }
    return msgs.slice(0, 2);
  };

  const where = summarizeUrl(relevant.method, relevant.url, relevant.route);
  const header = [
    '  HTTP:',
    `\n    ${where} ${ansi.dim('->')} ${relevant.statusCode ?? '?'}`,
    typeof relevant.durationMs === 'number' ? ` ${ansi.dim(`(${relevant.durationMs}ms)`)} ` : ' ',
    relevant.contentType ? ansi.dim(`(${relevant.contentType})`) : '',
    relevant.requestId ? ansi.dim(`  reqId=${relevant.requestId}`) : '',
  ].join('');

  const expVsAct =
    typeof (corr as any)?.expectedNumber === 'number' ||
    typeof (corr as any)?.receivedNumber === 'number'
      ? (() => {
          const exp =
            (corr as any)?.expectedNumber != null ? String((corr as any).expectedNumber) : '?';
          const got =
            (corr as any)?.receivedNumber != null
              ? String((corr as any).receivedNumber)
              : String(relevant.statusCode ?? '?');
          return `\n      Expected: ${ansi.yellow(exp)}   Received: ${ansi.yellow(got)}`;
        })()
      : '';

  const why =
    importantMessages(parsedActual ?? relevant.json)
      .map((msg) => `\n      Why: ${ansi.white(msg)}`)
      .slice(0, 1)
      .join('') || '';

  const diff = (() => {
    const rightActual = parsedActual ?? relevant.json;
    if (!parsedExpected || !rightActual) {
      return '';
    }
    const changes = jsonDiff(parsedExpected, rightActual);
    if (!changes.length) {
      return '';
    }
    const body = changes
      .map((change) => {
        const marker = change.kind === 'added' ? '+' : change.kind === 'removed' ? '-' : '~';
        const preview = change.preview ? `: ${ansi.dim(change.preview)}` : '';
        return `\n        ${marker} ${change.path}${preview}`;
      })
      .join('');
    return `\n      Diff:${body}`;
  })();

  return [header, expVsAct, why, diff, '\n'].filter(Boolean) as Lines;
};

export const coerceJestJsonToBridge = (raw: unknown): BridgeJSON => {
  if (raw && typeof raw === 'object' && 'aggregated' in (raw as Record<string, unknown>)) {
    return raw as BridgeJSON;
  }
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
    readonly console?: ReadonlyArray<{
      message?: unknown;
      type?: unknown;
      origin?: unknown;
    }> | null;
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
      numTotalTestSuites: (raw as any).numTotalTestSuites,
      numPassedTestSuites: (raw as any).numPassedTestSuites,
      numFailedTestSuites: (raw as any).numFailedTestSuites,
      numTotalTests: (raw as any).numTotalTests,
      numPassedTests: (raw as any).numPassedTests,
      numFailedTests: (raw as any).numFailedTests,
      numPendingTests: (raw as any).numPendingTests,
      numTodoTests: (raw as any).numTodoTests,
      startTime: (raw as any).startTime,
      success: (raw as any).success,
      runTimeMs: (raw as any).aggregated?.runTimeMs,
    },
  };
};

export const renderFailedAssertion = (args: {
  readonly file: BridgeJSON['testResults'][number];
  readonly relPath: string;
  readonly assertion: BridgeJSON['testResults'][number]['testResults'][number];
  readonly ctx: Ctx;
  readonly assertionEvents: readonly AssertionEvt[];
  readonly httpSorted: readonly HttpEvent[];
}): Lines => {
  const { file, relPath: rel, assertion, ctx, assertionEvents, httpSorted } = args;

  const header = `${rel} > ${assertion.fullName}`;
  const bullet = (text: string) => `${Colors.Failure('×')} ${ansi.white(text)}`;

  const failureMessage = file.failureMessage || '';
  const detailMsgs = linesFromDetails(assertion.failureDetails || file.failureDetails).messages;

  const primaryBlock = assertion.failureMessages?.length
    ? assertion.failureMessages.join('\n')
    : failureMessage;

  const messagesArray = mergeMsgLines(primaryBlock, detailMsgs);

  const details = linesFromDetails(assertion.failureDetails || file.failureDetails);
  const mergedForStack = collapseStacks([...messagesArray, ...details.stacks]);
  const deepestLoc = deepestProjectLoc(mergedForStack, ctx.projectHint);
  const locLink = deepestLoc
    ? (() => {
        const href = preferredEditorHref(deepestLoc.file, deepestLoc.line, ctx.editorCmd);
        const base = `${deepestLoc.file.split('/').pop()}:${deepestLoc.line}`;
        return osc8(base, href);
      })()
    : undefined;

  const headerLine = `${ansi.white(header)}${locLink ? `  ${ansi.dim(`(${locLink})`)}` : ''}`;
  const msgLines = messagesArray.join('\n').split('\n');
  const assertFallback =
    deepestLoc ||
    (assertion.location && { file: file.testFilePath, line: assertion.location.line });

  const matcherMsg = (() => {
    try {
      const arr = (assertion.failureDetails || file.failureDetails) as
        | readonly unknown[]
        | undefined;
      if (!arr) {
        return empty;
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
          return [matcherHeader, bodyHeader, ...body, ''].filter(Boolean) as Lines;
        }
      }
    } catch {
      // ignore error
    }
    return empty;
  })();

  const code = concat(
    ['', drawFailLine(), bullet(headerLine), ''],
    buildCodeFrameSection(msgLines, ctx, assertFallback || undefined),
    [''],
  );
  const pretty = buildPrettyDiffSection(assertion.failureDetails || file.failureDetails, msgLines);
  const hasPretty = pretty.length > 0;

  const stackPreview = ctx.showStacks
    ? mergedForStack
        .filter((ln) => isStackLine(stripAnsiSimple(ln)))
        .filter((ln) => ctx.projectHint.test(stripAnsiSimple(ln)))
        .slice(0, 2)
        .map((ln) => `      ${colorStackLine(String(ln), ctx.projectHint)}`)
    : [];

  const message = buildMessageSection(msgLines, details, ctx, {
    suppressDiff: hasPretty,
    stackPreview,
  });
  const httpCard = renderHttpCard({ file, relPath: rel, assertion, assertionEvents, httpSorted });

  const minimalInfo = msgLines.every((ln) => !ln.trim());
  const thrown = minimalInfo
    ? (() => {
        try {
          return buildThrownSection(assertion.failureDetails || []);
        } catch {
          return empty;
        }
      })()
    : empty;

  const consoleBlock = buildConsoleSection(stripBridgeEventsFromConsole(file.console ?? null));

  const stackTail: Lines =
    ctx.showStacks && stackPreview.length === 0
      ? (() => {
          const merged = collapseStacks([...msgLines, ...details.stacks]);
          const tail = collapseStacks(merged)
            .filter((ln) => isStackLine(stripAnsiSimple(ln)))
            .slice(-4)
            .map((ln) => `      ${colorStackLine(String(ln), ctx.projectHint)}`);
          return tail.length ? [ansi.dim('    Stack:'), ...tail, ''] : empty;
        })()
      : empty;

  return concat(code, pretty, matcherMsg, message, httpCard, thrown, consoleBlock, stackTail, [
    drawFailLine(),
    '',
  ]);
};

export const renderFileBlock = (file: BridgeJSON['testResults'][number], env: RenderEnv): Lines => {
  const rel = file.testFilePath.replace(/\\/g, '/').replace(`${env.ctx.cwd}/`, '');
  const failed = file.testResults.filter((assertion) => assertion.status === 'failed');
  const { http, assertions } = parseBridgeConsole(file.console);
  const httpSorted = [...http].sort(by<HttpEvent>((event) => event.timestampMs));

  return concat(
    renderPerFileOverviewBlock(rel, file.testResults, env.onlyFailures),
    renderFileBadge(rel, failed.length, env.onlyFailures),
    renderFileLevelFailure(file, env.ctx),
    ...failed.map((assertion) =>
      renderFailedAssertion({
        file,
        relPath: rel,
        assertion,
        ctx: env.ctx,
        assertionEvents: assertions,
        httpSorted,
      }),
    ),
  );
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

export const renderFooter = (data: BridgeJSON): Lines => {
  const failedCount = data.aggregated.numFailedTests;
  return [
    drawRule(BackgroundColors.Failure(ansi.white(` Failed Tests ${failedCount} `))),
    '',
    vitestFooter(data.aggregated),
  ];
};

export const renderVitestFromJestJSON = (
  data: BridgeJSON,
  ctx: Ctx,
  opts?: { readonly onlyFailures?: boolean },
): string =>
  pipe(
    concat(
      renderRunHeader({ ctx, onlyFailures: Boolean(opts?.onlyFailures) }),
      ...data.testResults.map((file) =>
        renderFileBlock(file, { ctx, onlyFailures: Boolean(opts?.onlyFailures) }),
      ),
      renderFooter(data),
    ),
    joinLines,
  );

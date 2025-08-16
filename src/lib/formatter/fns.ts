import * as fs from 'node:fs';
import * as util from 'node:util';

// eslint-disable-next-line import/no-extraneous-dependencies
import JSON5 from 'json5';

import { ansi, osc8 } from '../ansi';
import { Colors, BackgroundColors } from '../colors';
import { stripAnsiSimple, isStackLine } from '../stacks';
import { preferredEditorHref } from '../paths';
import type { PrettyFns } from './model';

const colorTokens = {
  pass: Colors.Success,
  fail: Colors.Failure,
  run: Colors.Run,
  skip: Colors.Skip,
  todo: Colors.Todo,
  passPill: (text: string) => BackgroundColors.Success(ansi.white(` ${text} `)),
  failPill: (text: string) => BackgroundColors.Failure(ansi.white(` ${text} `)),
  runPill: (text: string) => BackgroundColors.Run(ansi.white(` ${text} `)),
};

export const drawRule = (label?: string): string => {
  const width = Math.max(
    40,
    (process.stdout && (process.stdout as NodeJS.WriteStream).columns) || 80,
  );
  if (!label) {
    return ansi.dim('─'.repeat(width));
  }
  const plain = stripAnsiSimple(label);
  const pad = Math.max(1, width - plain.length - 1);
  return `${ansi.dim('─'.repeat(pad))} ${label}`;
};

export const drawFailLine = (): string => {
  const width = Math.max(
    40,
    (process.stdout && (process.stdout as NodeJS.WriteStream).columns) || 80,
  );
  return colorTokens.fail('─'.repeat(width));
};

export const renderRunLine = (cwd: string): string =>
  `${colorTokens.runPill('RUN')} ${ansi.dim(cwd.replace(/\\/g, '/'))}`;

export const buildFileBadgeLine = (rel: string, failedCount: number): string =>
  failedCount > 0
    ? `${colorTokens.failPill('FAIL')} ${ansi.white(rel)}`
    : `${colorTokens.passPill('PASS')} ${ansi.white(rel)}`;

export const buildPerFileOverview = (
  rel: string,
  assertions: readonly { readonly fullName: string; readonly status: string }[],
): string[] => {
  const out: string[] = [];
  out.push(`${ansi.magenta(rel)} ${ansi.dim(`(${assertions.length})`)}`);
  for (const assertion of assertions) {
    const name = assertion.fullName;
    if (assertion.status === 'passed') {
      out.push(`  ${colorTokens.pass('✓')} ${ansi.dim(name)}`);
    } else if (assertion.status === 'todo') {
      out.push(`  ${colorTokens.todo('☐')} ${ansi.dim(name)} ${colorTokens.todo('[todo]')}`);
    } else if (assertion.status === 'pending') {
      out.push(`  ${colorTokens.skip('↓')} ${ansi.dim(name)} ${colorTokens.skip('[skipped]')}`);
    } else {
      out.push(`  ${colorTokens.fail('×')} ${ansi.white(name)}`);
    }
  }
  out.push('');
  return out;
};

// ---- Rich helpers (ported/simplified to match old behavior) ----

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const colorStackLine = (line: string, projectHint: RegExp): string => {
  const plainLine = stripAnsiSimple(line);
  if (!/\s+at\s+/.test(plainLine)) {
    return plainLine;
  }
  const match = plainLine.match(/\(?([^\s()]+):(\d+):(\d+)\)?$/);
  if (!match) {
    return ansi.dim(plainLine);
  }
  const file = match[1]!.replace(/\\/g, '/');
  const lineNumber = match[2]!;
  const columnNumber = match[3]!;
  const coloredPath = projectHint.test(file) ? ansi.cyan(file) : ansi.dim(file);
  return plainLine.replace(
    match[0]!,
    `(${coloredPath}${ansi.dim(':')}${ansi.white(`${lineNumber}:${columnNumber}`)})`,
  );
};

export const extractBridgePath = (raw: string, cwd: string): string | null => {
  const re = /Test results written to:\s+([^\n\r]+jest-bridge-[^\s'"]+\.json)/g;
  const matches = Array.from(raw.matchAll(re));
  if (matches.length === 0) {
    return null;
  }
  const jsonPath = (matches[matches.length - 1]![1] ?? '').trim().replace(/^["'`]|["'`]$/g, '');
  return /^\//.test(jsonPath) ? jsonPath : `${cwd.replace(/\\/g, '/')}/${jsonPath}`;
};

export const findCodeFrameStart = (lines: readonly string[]): number =>
  lines.findIndex((line) => /^\s*(>?\s*\d+\s*\|)/.test(stripAnsiSimple(line)));

const _sourceCache = new Map<string, readonly string[]>();
const readSource = (file: string): readonly string[] => {
  const normalized = file.replace(/\\/g, '/');
  const hit = _sourceCache.get(normalized);
  if (hit) {
    return hit;
  }
  try {
    const arr = fs.readFileSync(normalized, 'utf8').split(/\r?\n/);
    _sourceCache.set(normalized, arr);
    return arr;
  } catch {
    return [];
  }
};

const renderInlineCodeFrame = (lines: readonly string[], start: number): string[] => {
  const out: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const raw = stripAnsiSimple(lines[i]!);
    if (!raw.trim()) {
      break;
    }
    if (/^\s*\^+\s*$/.test(raw)) {
      out.push(`    ${Colors.Failure(raw.trimEnd())}`);
    } else {
      const ptr = raw.match(/^\s*>(\s*\d+)\s*\|\s?(.*)$/);
      if (ptr) {
        const num = ansi.dim(ptr[1]!.trim());
        const code = ansi.yellow(ptr[2] ?? '');
        out.push(`    ${Colors.Failure('>')} ${num} ${ansi.dim('|')} ${code}`);
      } else {
        const nor = raw.match(/^\s*(\d+)\s*\|\s?(.*)$/);
        if (nor) {
          const num = ansi.dim(nor[1]!);
          const code = ansi.dim(nor[2] ?? '');
          out.push(`      ${num} ${ansi.dim('|')} ${code}`);
        } else {
          out.push(`    ${raw}`);
        }
      }
    }
  }
  return out;
};

const renderSourceCodeFrame = (file: string, line: number, context = 3): string[] => {
  const lines = readSource(file);
  if (lines.length === 0 || !Number.isFinite(line)) {
    return [];
  }
  const idx = Math.max(1, Math.min(line, lines.length));
  const start = Math.max(1, idx - context);
  const end = Math.min(lines.length, idx + context);
  const out: string[] = [];
  for (let current = start; current <= end; current += 1) {
    const num = ansi.dim(String(current));
    const code =
      current === idx ? ansi.yellow(lines[current - 1] ?? '') : ansi.dim(lines[current - 1] ?? '');
    if (current === idx) {
      out.push(`    ${Colors.Failure('>')} ${num} ${ansi.dim('|')} ${code}`);
    } else {
      out.push(`      ${num} ${ansi.dim('|')} ${code}`);
    }
  }
  out.push(`    ${Colors.Failure('^')}`);
  return out;
};

const stackLocation = (line: string): { file: string; line: number } | null => {
  const match = stripAnsiSimple(line).match(/\(?([^\s()]+):(\d+):\d+\)?$/);
  if (!match) {
    return null;
  }
  return { file: match[1]!.replace(/\\/g, '/'), line: Number(match[2]!) };
};

export const deepestProjectLoc: PrettyFns['deepestProjectLoc'] = (stackLines, projectHint) => {
  for (let i = stackLines.length - 1; i >= 0; i -= 1) {
    const simple = stripAnsiSimple(stackLines[i]!);
    if (
      isStackLine(simple) &&
      projectHint.test(simple) &&
      !/node_modules|vitest|jest/.test(simple)
    ) {
      return stackLocation(stackLines[i]!);
    }
  }
  return null;
};

export const buildCodeFrameSection: PrettyFns['buildCodeFrameSection'] = (
  messageLines,
  ctx,
  synthLoc,
): string[] => {
  const out: string[] = [];
  const start = findCodeFrameStart(messageLines);
  if (start >= 0) {
    out.push(...renderInlineCodeFrame(messageLines, start), '');
    return out;
  }
  if (ctx.showStacks && synthLoc) {
    out.push(...renderSourceCodeFrame(synthLoc.file, synthLoc.line), '');
  }
  return out;
};

const normalizeBlock = (raw: string) =>
  raw
    .replace(/^\s*Array\s*\[/, '[')
    .replace(/^\s*Object\s*\{/, '{')
    .replace(/,(\s*[\]}])/g, '$1');

const stringifyPrettierish = (value: unknown): string => {
  if (typeof value === 'string') {
    const text = normalizeBlock(value.trim());
    try {
      const parsed = JSON5.parse(text);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value) || isObjectRecord(value)) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return util.inspect(value, {
        depth: 10,
        breakLength: Infinity,
        compact: false,
        sorted: true,
      });
    }
  }
  return util.inspect(value, {
    depth: 10,
    breakLength: Infinity,
    compact: false,
    sorted: true,
  });
};

const isArrayOfPrimitives = (
  value: unknown,
): value is ReadonlyArray<string | number | boolean | null> =>
  Array.isArray(value) &&
  value.every(
    (element) => ['string', 'number', 'boolean'].includes(typeof element) || element === null,
  );

const extractFromUnifiedDiff = (
  rawLines: readonly string[],
): { expected?: string; received?: string } => {
  const lines = (rawLines ?? []).map((lineText) => stripAnsiSimple(lineText));
  let startIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const lt = lines[i]!;
    if (/^\s*(?:[-+]\s*)?(Array\s*\[|Object\s*\{)/.test(lt)) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) {
    return {};
  }
  const expectedParts: string[] = [];
  const receivedParts: string[] = [];
  let opened = false;
  let expDone = false;
  let recDone = false;
  const canParseJsonish = (input: string): boolean => {
    const text = normalizeBlock(input).trim();
    try {
      JSON5.parse(text);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = startIndex; i < lines.length; i += 1) {
    const lineText = lines[i]!;
    const unsigned = lineText.replace(/^\s*[-+]\s?/, '');
    const isMinus = /^\s*-\s/.test(lineText);
    const isPlus = /^\s*\+\s/.test(lineText);
    if (!opened) {
      const looksLikeStart = /^\s*(Array\s*\[|Object\s*\{)/.test(unsigned);
      if (!looksLikeStart) {
        // eslint-disable-next-line no-continue
        continue;
      }
      opened = true;
    }
    if (isMinus) {
      expectedParts.push(unsigned);
    } else if (isPlus) {
      receivedParts.push(unsigned);
    } else {
      expectedParts.push(unsigned);
      receivedParts.push(unsigned);
    }
    if (!expDone && expectedParts.length > 0) {
      expDone = canParseJsonish(expectedParts.join('\n'));
    }
    if (!recDone && receivedParts.length > 0) {
      recDone = canParseJsonish(receivedParts.join('\n'));
    }
    if (opened && expDone && recDone) {
      break;
    }
  }
  const toJsonLikeString = (joined: string | undefined): string | undefined => {
    if (!joined) {
      return undefined;
    }
    const text = normalizeBlock(joined).trim();
    try {
      const parsed = JSON5.parse(text);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return text;
    }
  };
  const expected = expectedParts.length ? expectedParts.join('\n') : undefined;
  const received = receivedParts.length ? receivedParts.join('\n') : undefined;
  const result: { expected?: string; received?: string } = {};
  const expStr = toJsonLikeString(expected);
  const recStr = toJsonLikeString(received);
  if (expStr !== undefined) {
    result.expected = expStr;
  }
  if (recStr !== undefined) {
    result.received = recStr;
  }
  return result;
};

const extractExpectedReceived = (
  details?: readonly unknown[],
  lines?: readonly string[],
): { expected?: unknown; received?: unknown } => {
  if (details) {
    for (const detail of details) {
      const dict = isObjectRecord(detail) ? (detail as Record<string, unknown>) : undefined;
      const matcher =
        dict && isObjectRecord(dict.matcherResult)
          ? (dict.matcherResult as Record<string, unknown>)
          : undefined;
      if (matcher) {
        const expectedValue = (matcher as Record<string, unknown>).expected;
        const receivedValue = (matcher as Record<string, unknown>).received;
        // Special-case common Jest matchers to recover clearer numbers/labels
        const matcherName = String(
          ((matcher as Record<string, unknown>).matcherName as unknown) || '',
        );
        if (matcherName === 'toHaveBeenCalledTimes' || matcherName === 'toBeCalledTimes') {
          const getCallsCount = (actual: unknown): number | undefined => {
            if (
              isObjectRecord(actual) &&
              Array.isArray((actual as Record<string, unknown>).calls)
            ) {
              return ((actual as Record<string, unknown>).calls as unknown[]).length;
            }
            if (typeof actual === 'number') {
              return actual;
            }
            if (Array.isArray(actual)) {
              return actual.length;
            }
            return undefined;
          };
          const expectedNumber = getCallsCount(expectedValue);
          const actualValue = (matcher as Record<string, unknown>).actual ?? receivedValue;
          const receivedNumber = getCallsCount(actualValue);
          if (expectedNumber !== undefined || receivedNumber !== undefined) {
            return { expected: expectedNumber, received: receivedNumber };
          }
        }
        // Only trust failureDetails when both sides are provided; otherwise
        // prefer parsing the message lines to avoid showing "undefined".
        if (expectedValue !== undefined && receivedValue !== undefined) {
          return { expected: expectedValue, received: receivedValue };
        }
      }
    }
  }
  if (lines && lines.length) {
    const expectedLines: string[] = [];
    const receivedLines: string[] = [];
    let mode: 'none' | 'exp' | 'rec' = 'none';
    for (const rawLine of lines) {
      const simple = stripAnsiSimple(rawLine);
      if (/^\s*Expected:/.test(simple)) {
        mode = 'exp';
        expectedLines.push(simple.replace(/^\s*Expected:\s*/, ''));
        // eslint-disable-next-line no-continue
        continue;
      }
      if (/^\s*Received:/.test(simple)) {
        mode = 'rec';
        receivedLines.push(simple.replace(/^\s*Received:\s*/, ''));
        // eslint-disable-next-line no-continue
        continue;
      }
      if (/^\s*[-+]\s/.test(simple)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      if (!simple.trim()) {
        mode = 'none';
      } else if (mode === 'exp') {
        expectedLines.push(simple);
      } else if (mode === 'rec') {
        receivedLines.push(simple);
      }
    }
    if (expectedLines.length || receivedLines.length) {
      return { expected: expectedLines.join('\n'), received: receivedLines.join('\n') };
    }
    const unified = extractFromUnifiedDiff(lines);
    if (unified.expected !== undefined || unified.received !== undefined) {
      return unified;
    }
  }
  return {};
};

export const buildPrettyDiffSection = (
  details?: readonly unknown[],
  messageLines?: readonly string[],
): string[] => {
  const payload = extractExpectedReceived(details, messageLines);
  if (payload.expected === undefined && payload.received === undefined) {
    return [];
  }
  const expectedString = stringifyPrettierish(payload.expected);
  const receivedString = stringifyPrettierish(payload.received);
  const out: string[] = [];
  const expectedLenLabel = Array.isArray(payload.expected)
    ? ansi.dim(` (len ${(payload.expected as readonly unknown[]).length})`)
    : '';
  out.push(`    ${ansi.bold('Expected')}${expectedLenLabel}`);
  out.push(
    expectedString
      .split('\n')
      .map((expectedLine) => `      ${Colors.Success(expectedLine)}`)
      .join('\n'),
  );
  const receivedLenLabel = Array.isArray(payload.received)
    ? ansi.dim(` (len ${(payload.received as readonly unknown[]).length})`)
    : '';
  out.push(`    ${ansi.bold('Received')}${receivedLenLabel}`);
  out.push(
    receivedString
      .split('\n')
      .map((receivedLine) => `      ${Colors.Failure(receivedLine)}`)
      .join('\n'),
  );
  // Optional difference summary for arrays of primitives
  if (isArrayOfPrimitives(payload.expected) && isArrayOfPrimitives(payload.received)) {
    const expectedSet = new Set(
      (payload.expected as ReadonlyArray<unknown>).map((element) => String(element)),
    );
    const receivedSet = new Set(
      (payload.received as ReadonlyArray<unknown>).map((element) => String(element)),
    );
    const missing = Array.from(expectedSet).filter((element) => !receivedSet.has(element));
    const unexpected = Array.from(receivedSet).filter((element) => !expectedSet.has(element));
    const parts: string[] = [];
    if (missing.length) {
      parts.push(
        `${missing.length} missing: ${missing
          .slice(0, 3)
          .map((element) => JSON.stringify(element))
          .join(', ')}${missing.length > 3 ? '…' : ''}`,
      );
    }
    if (unexpected.length) {
      parts.push(
        `${unexpected.length} unexpected: ${unexpected
          .slice(0, 3)
          .map((element) => JSON.stringify(element))
          .join(', ')}${unexpected.length > 3 ? '…' : ''}`,
      );
    }
    if (parts.length) {
      out.push(`    ${ansi.dim('Difference:')} ${Colors.Failure(parts.join(ansi.dim(' | ')))}`);
    }
  }
  out.push('');
  return out;
};

export const buildMessageSection = (
  messageLines: readonly string[],
  details: { stacks: string[]; messages: string[] },
  _ctx: { projectHint: RegExp; editorCmd: string | undefined; showStacks: boolean },
  opts?: { suppressDiff?: boolean; stackPreview?: readonly string[] },
): string[] => {
  const out: string[] = [];
  const lines = messageLines.map((lineText) => stripAnsiSimple(lineText));
  const hintIdx = lines.findIndex(
    (candidate) =>
      /expect\(.+?\)\.(?:to|not\.)/.test(candidate) ||
      /\b(?:AssertionError|Error):/.test(candidate),
  );
  const acc: string[] = [];
  if (hintIdx >= 0) {
    acc.push(lines[hintIdx]!);
  }
  const pushBlock = (start: number) => {
    acc.push(lines[start]!);
    for (let i = start + 1; i < lines.length; i += 1) {
      const candidate = lines[i]!;
      if (!candidate.trim() || isStackLine(candidate)) {
        break;
      }
      acc.push(candidate);
    }
  };
  const expectedIdx = lines.findIndex((lineText) => /^\s*Expected:/.test(lineText));
  const receivedIdx = lines.findIndex((lineText) => /^\s*Received:/.test(lineText));
  const diffIdx = lines.findIndex((lineText) =>
    /^\s*(?:- Expected|\+ Received|Difference:)/.test(lineText),
  );
  if (expectedIdx >= 0) {
    pushBlock(expectedIdx);
  }
  if (receivedIdx >= 0) {
    pushBlock(receivedIdx);
  }
  if (diffIdx >= 0) {
    pushBlock(diffIdx);
  }
  const filtered = opts?.suppressDiff
    ? acc.filter((raw) => {
        const simple = stripAnsiSimple(raw);
        return (
          !/^\s*(Expected:|Received:|Difference:)\b/.test(simple) &&
          !/^\s*[-+]\s/.test(simple) &&
          !/^\s*(Array\s*\[|Object\s*\{)/.test(simple)
        );
      })
    : acc;
  const hasOnlyBareError =
    filtered.length === 0 ||
    (filtered.length === 1 && /^\s*(?:Error|AssertionError):?\s*$/.test(filtered[0] ?? ''));
  // Fallback: when we only captured a bare "Error:" line (regression case),
  // include the immediate non-empty non-stack lines following the hint and any detailed messages
  const fallbackLines: string[] = [];
  if (hasOnlyBareError) {
    const startFrom = hintIdx >= 0 ? hintIdx + 1 : 0;
    for (let i = startFrom; i < lines.length; i += 1) {
      const candidate = lines[i]!;
      if (!candidate.trim()) {
        break;
      }
      if (isStackLine(candidate)) {
        break;
      }
      fallbackLines.push(candidate);
    }
    if (fallbackLines.length === 0 && details && details.messages && details.messages.length) {
      // Use messages extracted from failureDetails as a secondary fallback
      fallbackLines.push(
        ...details.messages
          .map((messageText) => stripAnsiSimple(messageText))
          .filter((messageText) => messageText.trim().length > 0)
          .slice(0, 6),
      );
    }
  }
  if (filtered.length > 0) {
    const label = (() => {
      const joined = filtered.join(' ');
      const matchResult =
        joined.match(/\b(TypeError|ReferenceError|SyntaxError|RangeError|AssertionError)\b/) ||
        joined.match(/\bError\b/);
      if (matchResult) {
        const typeName = (matchResult[1] as string | undefined) ?? 'Error';
        return `${typeName}:`;
      }
      return /expect\(.+?\)\.(?:to|not\.)/.test(joined) ? 'Assertion:' : 'Message:';
    })();
    out.push(`    ${ansi.bold(label)}`);
    const body = hasOnlyBareError ? fallbackLines : filtered;
    for (const lineText of body) {
      const colored = /^\s*-\s/.test(lineText)
        ? Colors.Failure(lineText)
        : /^\s*\+\s/.test(lineText)
          ? Colors.Success(lineText)
          : lineText;
      out.push(`    ${ansi.yellow(colored)}`);
    }
    if (opts?.stackPreview && opts.stackPreview.length) {
      for (const frame of opts.stackPreview) {
        out.push(frame);
      }
    }
    out.push('');
  }
  return out;
};

export const linesFromDetails = (
  details: readonly unknown[] | undefined,
): { stacks: string[]; messages: string[] } => {
  const stacks: string[] = [];
  const messages: string[] = [];
  if (!details) {
    return { stacks, messages };
  }
  const pushMaybe = (value: unknown, bucket: string[]) => {
    if (typeof value === 'string' && value.trim()) {
      bucket.push(...value.split(/\r?\n/));
    }
  };
  const visitDeep = (value: unknown, depth: number): void => {
    if (depth > 3 || value == null) {
      return;
    }
    if (typeof value === 'string') {
      pushMaybe(value, messages);
      return;
    }
    if (typeof value !== 'object') {
      return;
    }
    const obj = value as Record<string, unknown>;
    // Common error-like shapes
    if (typeof obj.message === 'string') {
      pushMaybe(obj.message, messages);
    }
    if (typeof obj.stack === 'string') {
      pushMaybe(obj.stack, stacks);
    }
    if (typeof obj.expected === 'string') {
      pushMaybe(obj.expected, messages);
    }
    if (typeof obj.received === 'string') {
      pushMaybe(obj.received, messages);
    }
    const arrays = ['errors', 'causes', 'aggregatedErrors'];
    for (const key of arrays) {
      const arr = obj[key as keyof typeof obj] as unknown;
      if (Array.isArray(arr)) {
        for (const element of arr) {
          visitDeep(element, depth + 1);
        }
      }
    }
    const nestedCandidates = ['error', 'cause', 'matcherResult'];
    for (const key of nestedCandidates) {
      if (obj[key] && typeof obj[key] === 'object') {
        visitDeep(obj[key], depth + 1);
      }
    }
  };
  for (const detail of details) {
    if (typeof detail === 'string') {
      if (/\s+at\s.+\(.+:\d+:\d+\)/.test(detail)) {
        pushMaybe(detail, stacks);
      } else {
        pushMaybe(detail, messages);
      }
    } else if (isObjectRecord(detail)) {
      pushMaybe(detail.stack, stacks);
      pushMaybe(detail.message, messages);
      const err = isObjectRecord(detail.error)
        ? (detail.error as Record<string, unknown>)
        : undefined;
      if (err) {
        pushMaybe(err.stack, stacks);
        pushMaybe(err.message, messages);
      }
      const matcher = isObjectRecord(detail.matcherResult)
        ? (detail.matcherResult as Record<string, unknown>)
        : undefined;
      if (matcher) {
        pushMaybe(matcher.stack, stacks);
        pushMaybe(matcher.message, messages);
        pushMaybe(matcher.expected, messages);
        pushMaybe(matcher.received, messages);
      }
      // Deep search for any nested message/stack when standard fields are absent
      if (messages.length === 0 && stacks.length === 0) {
        visitDeep(detail, 0);
      }
    }
  }
  return { stacks, messages };
};

export const buildStackSection = (
  mergedForStack: readonly string[],
  ctx: { projectHint: RegExp; editorCmd?: string; showStacks: boolean },
  fallbackLoc?: { file: string; line: number } | null,
): string[] => {
  const out: string[] = [];
  out.push(ansi.dim('    Stack:'));
  if (!ctx.showStacks) {
    out.push(`      ${ansi.dim('(hidden by TEST_CLI_STACKS=)')}`, '');
    return out;
  }
  const onlyStack = mergedForStack.filter((lineText: string) =>
    isStackLine(stripAnsiSimple(lineText)),
  );
  const tail = onlyStack.slice(-4);
  if (tail.length) {
    for (const frameLine of tail) {
      out.push(`      ${colorStackLine(String(frameLine), ctx.projectHint)}`);
    }
    const loc = deepestProjectLoc(mergedForStack, ctx.projectHint);
    if (loc) {
      const href = preferredEditorHref(loc.file, loc.line, ctx.editorCmd);
      out.push(`      ${ansi.dim('at')} ${osc8(`${loc.file.split('/').pop()}:${loc.line}`, href)}`);
    }
    out.push('');
    return out;
  }
  if (fallbackLoc) {
    out.push(
      `      ${colorStackLine(`${fallbackLoc.file}:${fallbackLoc.line}:0`, ctx.projectHint)}`,
      '',
    );
    return out;
  }
  out.push(`      ${ansi.dim('(no stack provided)')}`, '');
  return out;
};

const MAX_CONSOLE_ERRORS_TO_SHOW = 3;

type ConsoleEntry = Readonly<{
  type?: unknown;
  message?: unknown;
  origin?: unknown;
}>;

const isConsoleEntry = (candidate: unknown): candidate is ConsoleEntry =>
  typeof candidate === 'object' && candidate !== null;

export const buildConsoleSection = (maybeConsole: unknown): string[] => {
  const out: string[] = [];
  if (!Array.isArray(maybeConsole)) {
    return out;
  }
  const entries = maybeConsole.filter(isConsoleEntry);
  const errorsOnly = entries.filter((entry) => String(entry?.type ?? '').toLowerCase() === 'error');
  const scored = errorsOnly
    .map((entry) => {
      const raw = entry?.message as unknown;
      const msg = Array.isArray(raw)
        ? raw.map(String).join(' ')
        : typeof raw === 'string'
          ? raw
          : String(raw ?? '');
      return { msg, score: msg.length };
    })
    .filter((item) => item.msg.trim().length > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_CONSOLE_ERRORS_TO_SHOW);
  if (scored.length) {
    out.push(ansi.dim('    Console errors:'));
    for (const item of scored) {
      out.push(`      ${ansi.dim('•')} ${item.msg}`);
    }
    out.push('');
  }
  return out;
};

// Fallback message extraction when assertion messages are sparse or just "Error:"
export const buildFallbackMessageBlock = (
  messageLines: readonly string[],
  details: { messages: readonly string[] },
): string[] => {
  const normalize = (arr: readonly string[]) =>
    arr.map((lineText) => stripAnsiSimple(lineText)).filter((line) => line.trim().length > 0);
  const normalized = normalize(messageLines);
  const informative = normalized.filter((line) => !/^\s*(?:Error|AssertionError):?\s*$/.test(line));
  // If caller already has informative lines, they don't need this fallback
  if (informative.length > 0) {
    return [];
  }
  const errorIdx = normalized.findIndex((line) =>
    /(TypeError|ReferenceError|SyntaxError|RangeError|AssertionError|Error):?/.test(line),
  );
  const collected: string[] = [];
  if (errorIdx >= 0) {
    for (let i = errorIdx; i < normalized.length && collected.length < 8; i += 1) {
      const ln = normalized[i]!;
      if (!ln.trim()) {
        break;
      }
      if (isStackLine(ln)) {
        break;
      }
      collected.push(ln);
    }
  }
  const fromDetails = collected.length > 0 ? [] : normalize(details.messages).slice(0, 6);
  const linesToShow = collected.length > 0 ? collected : fromDetails;
  if (linesToShow.length === 0) {
    return [];
  }
  const out: string[] = [];
  out.push(`    ${ansi.bold('Message:')}`);
  for (const lineText of linesToShow) {
    out.push(`    ${ansi.yellow(lineText)}`);
  }
  out.push('');
  return out;
};

// Thrown object pretty-printer (when we get raw error objects in failureDetails)
export const buildThrownSection = (details: readonly unknown[]): string[] => {
  const toLines = (value: unknown): string[] => {
    if (value == null) {
      return [];
    }
    if (typeof value === 'string') {
      return value.split(/\r?\n/);
    }
    try {
      return JSON.stringify(value, null, 2).split(/\r?\n/);
    } catch {
      return [String(value)];
    }
  };
  const candidates: string[] = [];
  for (const d of details) {
    const obj = d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
    if (obj && obj.error && typeof obj.error === 'object') {
      const err = obj.error as Record<string, unknown>;
      if (typeof err.name === 'string') {
        candidates.push(`name: ${err.name}`);
      }
      if (typeof err.message === 'string') {
        candidates.push(`message: ${err.message}`);
      }
      if (typeof err.code === 'string' || typeof err.code === 'number') {
        candidates.push(`code: ${String(err.code)}`);
      }
      if (typeof err.cause === 'string') {
        candidates.push(`cause: ${err.cause}`);
      }
      if (err.cause && typeof err.cause === 'object') {
        candidates.push('cause:');
        candidates.push(...toLines(err.cause));
      }
      const rest = { ...err };
      delete (rest as any).name;
      delete (rest as any).message;
      delete (rest as any).code;
      delete (rest as any).stack;
      if (Object.keys(rest).length > 0) {
        candidates.push('details:');
        candidates.push(...toLines(rest));
      }
    }
  }
  if (!candidates.length) {
    return [];
  }
  const out: string[] = [];
  out.push(`    ${ansi.bold('Thrown:')}`);
  for (const line of candidates.slice(0, 50)) {
    out.push(`    ${ansi.yellow(line)}`);
  }
  out.push('');
  return out;
};

export const mkPrettyFns = (): PrettyFns => ({
  drawRule,
  drawFailLine,
  renderRunLine,
  buildPerFileOverview,
  buildFileBadgeLine,
  extractBridgePath,
  buildCodeFrameSection,
  buildMessageSection,
  buildPrettyDiffSection,
  buildStackSection,
  deepestProjectLoc,
  findCodeFrameStart,
  linesFromDetails,
  buildFallbackMessageBlock,
  buildThrownSection,
});

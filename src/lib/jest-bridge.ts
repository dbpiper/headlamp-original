/* eslint-disable no-continue */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as util from 'node:util';

// eslint-disable-next-line import/no-extraneous-dependencies
import JSON5 from 'json5';

import { ansi, osc8 } from './ansi';
import { Colors, BackgroundColors } from './colors';
import { preferredEditorHref } from './paths';
import { collapseStacks, firstTestLocation, isStackLine, stripAnsiSimple } from './stacks';

// near imports (fs already imported) — helper to find the last bridge JSON path
const extractBridgePath = (raw: string, cwd: string): string | null => {
  const matches = Array.from(
    raw.matchAll(/Test results written to:\s+([^\n\r]+jest-bridge-[^\s'"]+\.json)/g),
  );
  if (!matches.length) {
    return null;
  }
  const jsonPath = matches[matches.length - 1]![1]!.trim().replace(/^["'`]|["'`]$/g, '');
  return path.isAbsolute(jsonPath) ? jsonPath : path.resolve(cwd, jsonPath);
};

// Vitest-like formatter helpers
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

type KnownEnv = NodeJS.ProcessEnv & {
  TEST_CLI_STACKS?: string;
  TEST_CLI_SUMMARY?: string;
  TEST_CLI_SHOW_CONSOLE?: string;
  NO_COLOR?: string;
};
const env = process.env as unknown as KnownEnv;

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

const MAX_CONSOLE_ERRORS_TO_SHOW = 3;

// Pretty diff helpers
const isArrayOfPrimitives = (value: unknown): value is Array<string | number | boolean | null> =>
  Array.isArray(value) &&
  value.every(
    (element) => ['string', 'number', 'boolean'].includes(typeof element) || element === null,
  );

type DiffPayload = { expected?: unknown; received?: unknown };

// Normalize and indentation helpers for prettier-style rendering
export const indentBlock = (text: string, pad = '      '): string =>
  text
    .split('\n')
    .map((line) => (line ? pad + line : pad.trimEnd()))
    .join('\n');

export const prettifyPrettyFormatBlock = (raw: string): string => {
  const lines = raw.split('\n');
  if (!lines.length) {
    return raw;
  }

  // Accept both pretty-format and already-normalized blocks
  const first = lines[0] ?? '';
  const isArrayStart = /^\s*(?:Array\s*\[|\[)\s*$/.test(first);
  const isObjectStart = /^\s*(?:Object\s*\{|\{)\s*$/.test(first);
  if (!isArrayStart && !isObjectStart) {
    return raw;
  }

  // Normalize the opener
  lines[0] = first
    .replace(/^(\s*)Array\s*\[/, '$1[')
    .replace(/^(\s*)Object\s*\{/, '$1{')
    .replace(/^\s*\[\s*$/, '[')
    .replace(/^\s*\{\s*$/, '{');

  const closingChar = isArrayStart ? ']' : '}';
  // Find the closing line
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^\s*[\]}]\s*$/.test(lines[i]!)) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx < 0) {
    return lines.join('\n');
  }

  const inner = lines.slice(1, closeIdx);

  // Compute the baseline indent across non-empty inner lines
  const indents: number[] = [];
  for (const lineText of inner) {
    if (lineText.trim().length === 0) {
      continue;
    }
    indents.push(lineText.match(/^\s*/)?.[0]?.length ?? 0);
  }
  const minIndent = indents.length ? Math.min(...indents) : 0;

  // Re-indent so the *minimum* inner indent becomes exactly two spaces,
  // preserving relative nesting deeper than that.
  const reindented = inner.map((lineText, idx) => {
    if (lineText.trim().length === 0) {
      return lineText;
    } // keep blank lines blank
    const current = lineText.match(/^\s*/)?.[0]?.length ?? 0;
    const rest = lineText.slice(current);
    const extra = Math.max(0, current - minIndent);
    const base = '  '; // Prettier-style 2-space base
    // Optionally remove trailing comma on the last inner item to be more Prettier-like
    const withoutDangling = idx === inner.length - 1 ? rest.replace(/,\s*$/, '') : rest;
    return base + ' '.repeat(extra) + withoutDangling;
  });

  // Normalize the closer to be flush with the opener (no extra inner spaces)
  lines.splice(1, inner.length, ...reindented);
  lines[closeIdx] = closingChar;

  return lines.join('\n');
};

const normalizeBlock = (raw: string) =>
  raw
    .replace(/^\s*Array\s*\[/, '[')
    .replace(/^\s*Object\s*\{/, '{')
    // remove dangling commas just before ] or }
    .replace(/,(\s*[\]}])/g, '$1');

export const stringifyPrettierish = (value: unknown): string => {
  // strings coming from Jest diff
  if (typeof value === 'string') {
    const text = normalizeBlock(value.trim());
    if (/^[[{]/.test(text)) {
      try {
        const parsed = JSON5.parse(text);
        return JSON.stringify(parsed, null, 2);
      } catch {
        /* fall through */
      }
    }
    return value;
  }
  // real data: arrays/objects
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      /* circulars etc — fall through */
    }
  }
  // everything else
  return util.inspect(value, { depth: 10, breakLength: Infinity, compact: false, sorted: true });
};

export const drawFailRule = (label = ' FAIL '): string => drawRule(colorTokens.failPill(label));

// NEW: plain red line rule (no label), matching Vitest section rules
export const drawFailLine = (): string => {
  const width = Math.max(
    40,
    (process.stdout && (process.stdout as NodeJS.WriteStream).columns) || 80,
  );
  return colorTokens.fail('─'.repeat(width));
};

export const renderRunLine = (cwd: string): string =>
  `${colorTokens.runPill('RUN')} ${ansi.dim(cwd.replace(/\\/g, '/'))}`;

export const colorStackLine = (line: string, projectHint: RegExp): string => {
  const plainLine = stripAnsiSimple(line);
  if (!isStackLine(plainLine)) {
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

export const renderCodeFrame = (lines: readonly string[], start: number): string[] => {
  const out: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const raw = stripAnsiSimple(lines[i]!);
    if (!raw.trim()) {
      break;
    }
    if (/^\s*\^+\s*$/.test(raw)) {
      out.push(`    ${colorTokens.fail(raw.trimEnd())}`);
      continue;
    }
    const pointerMatch = raw.match(/^\s*>(\s*\d+)\s*\|\s?(.*)$/);
    if (pointerMatch) {
      const num = ansi.dim(pointerMatch[1]!.trim());
      const code = ansi.yellow(pointerMatch[2] ?? '');
      out.push(`    ${colorTokens.fail('>')} ${num} ${ansi.dim('|')} ${code}`);
      continue;
    }
    const normalMatch = raw.match(/^\s*(\d+)\s*\|\s?(.*)$/);
    if (normalMatch) {
      const num = ansi.dim(normalMatch[1]!);
      const code = ansi.dim(normalMatch[2] ?? '');
      out.push(`      ${num} ${ansi.dim('|')} ${code}`);
      continue;
    }
    out.push(`    ${raw}`);
  }
  return out;
};

// NEW: read file lines cache + synthesized codeframe
const _sourceCache = new Map<string, string[]>();
const readSource = (file: string): string[] => {
  const normalizedFile = file.replace(/\\/g, '/');
  const cached = _sourceCache.get(normalizedFile);
  if (cached) {
    return cached;
  }
  try {
    const txt = fs.readFileSync(normalizedFile, 'utf8');
    const arr = txt.split(/\r?\n/);
    _sourceCache.set(normalizedFile, arr);
    return arr;
  } catch {
    return [];
  }
};

export const renderSourceCodeFrame = (file: string, line: number, context = 3): string[] => {
  const lines = readSource(file);
  if (!lines.length || !Number.isFinite(line)) {
    return [];
  }
  const idx = Math.max(1, Math.min(line, lines.length));
  const start = Math.max(1, idx - context);
  const end = Math.min(lines.length, idx + context);

  const out: string[] = [];
  for (let currentLineNumber = start; currentLineNumber <= end; currentLineNumber += 1) {
    const num = ansi.dim(String(currentLineNumber));
    const code =
      currentLineNumber === idx
        ? ansi.yellow(lines[currentLineNumber - 1] ?? '')
        : ansi.dim(lines[currentLineNumber - 1] ?? '');
    if (currentLineNumber === idx) {
      out.push(`    ${colorTokens.fail('>')} ${num} ${ansi.dim('|')} ${code}`);
    } else {
      out.push(`      ${num} ${ansi.dim('|')} ${code}`);
    }
  }
  out.push(`    ${colorTokens.fail('^')}`);
  return out;
};

// PATCH: deepest project frame (last match in the stack)
const findLastProjectFrameIndex = (lines: readonly string[], projectHint: RegExp): number => {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const simple = stripAnsiSimple(lines[i]!);
    if (
      isStackLine(simple) &&
      projectHint.test(simple) &&
      !/node_modules|vitest|jest/.test(simple)
    ) {
      return i;
    }
  }
  return -1;
};

// NEW: short stack tail (last N frames), colored
const renderStackTail = (lines: readonly string[], projectHint: RegExp, max = 4): string[] => {
  const onlyStack = lines.filter((candidateLine) => isStackLine(stripAnsiSimple(candidateLine)));
  if (!onlyStack.length) {
    return [];
  }
  const tail = onlyStack.slice(-max);
  return tail.map((frameLine) => `      ${colorStackLine(frameLine, projectHint)}`);
};

// NEW: first N project frames from the stack (top-down)
const firstProjectFrames = (lines: readonly string[], projectHint: RegExp, max = 2): string[] => {
  const onlyStack = lines.filter((ln) => isStackLine(stripAnsiSimple(ln)));
  const projectOnly = onlyStack.filter((ln) => projectHint.test(stripAnsiSimple(ln)));
  return projectOnly.slice(0, max).map((ln) => `      ${colorStackLine(ln, projectHint)}`);
};

// NEW: extract assertion message (matcher hint + Expected/Received/diff)
const isTerminator = (lineText: string) => !lineText.trim() || isStackLine(lineText);

export const extractAssertionMessage = (msgLines: readonly string[]): string[] => {
  const lines = msgLines.map((rawLine: string) => stripAnsiSimple(rawLine));
  const out: string[] = [];

  const hintIdx = lines.findIndex(
    (candidateLine: string) =>
      /expect\(.+?\)\.(?:to|not\.)/.test(candidateLine) ||
      /\b(?:AssertionError|Error):/.test(candidateLine),
  );
  if (hintIdx >= 0) {
    out.push(lines[hintIdx]!);
  }

  const collectBlock = (start: number) => {
    out.push(lines[start]!);
    for (let i = start + 1; i < lines.length; i += 1) {
      const candidate = lines[i]!;
      if (isTerminator(candidate)) {
        break;
      }
      out.push(candidate);
    }
  };

  const expectedIdx = lines.findIndex((candidateLine: string) =>
    /^\s*Expected:/.test(candidateLine),
  );
  const receivedIdx = lines.findIndex((candidateLine: string) =>
    /^\s*Received:/.test(candidateLine),
  );
  const diffIdx = lines.findIndex((candidateLine: string) =>
    /^\s*(?:- Expected|\+ Received|Difference:)/.test(candidateLine),
  );

  if (expectedIdx >= 0) {
    collectBlock(expectedIdx);
  }
  if (receivedIdx >= 0) {
    collectBlock(receivedIdx);
  }
  if (diffIdx >= 0) {
    collectBlock(diffIdx);
  }

  // fallback: grab up to 4 non-stack lines after hint
  if (out.length === 0 && hintIdx >= 0) {
    for (let i = hintIdx + 1; i < lines.length && out.length < 4; i += 1) {
      const candidate = lines[i]!;
      if (isTerminator(candidate)) {
        break;
      }
      out.push(candidate);
    }
  }
  return out;
};

// PATCH: convert a single stack line to "file:line" (for editor link)
const stackLocation = (line: string): { file: string; line: number } | null => {
  const match = stripAnsiSimple(line).match(/\(?([^\s()]+):(\d+):\d+\)?$/);
  return match ? { file: match[1]!.replace(/\\/g, '/'), line: Number(match[2]!) } : null;
};
export const JEST_BRIDGE_REPORTER_SOURCE = `const fs = require('fs');
const path = require('path');

class BridgeReporter {
  constructor(globalConfig, options) {
    this.out = process.env.JEST_BRIDGE_OUT || (options && options.outFile) || path.join(process.cwd(), 'coverage', 'jest-run.json');
    this.buf = { startTime: Date.now(), testResults: [], aggregated: null };
  }
  onRunStart() { this.buf.startTime = Date.now(); }
  onTestResult(_test, tr) {
    const mapAssertion = (a) => ({
      title: a.title,
      fullName: a.fullName || [...(a.ancestorTitles || []), a.title].join(' '),
      status: a.status,
      duration: a.duration || 0,
      location: a.location || null,
      failureMessages: (a.failureMessages || []).map(String),
    });
    this.buf.testResults.push({
      testFilePath: tr.testFilePath,
      status: tr.numFailingTests ? 'failed' : 'passed',
      failureMessage: tr.failureMessage || '',
      failureDetails: tr.failureDetails || [],
      console: tr.console || null,
      perfStats: tr.perfStats || {},
      testResults: (tr.testResults || []).map(mapAssertion),
    });
  }
  onRunComplete(_contexts, agg) {
    this.buf.aggregated = {
      numTotalTestSuites: agg.numTotalTestSuites,
      numPassedTestSuites: agg.numPassedTestSuites,
      numFailedTestSuites: agg.numFailedTestSuites,
      numTotalTests: agg.numTotalTests,
      numPassedTests: agg.numPassedTests,
      numFailedTests: agg.numFailedTests,
      numPendingTests: agg.numPendingTests,
      numTodoTests: agg.numTodoTests,
      startTime: agg.startTime,
      success: agg.success,
      runTimeMs: agg.testResults.reduce((t, r) => t + Math.max(0, (r.perfStats?.end || 0) - (r.perfStats?.start || 0)), 0),
    };
    fs.mkdirSync(path.dirname(this.out), { recursive: true });
    fs.writeFileSync(this.out, JSON.stringify(this.buf), 'utf8');
  }
}
module.exports = BridgeReporter;`;

type Dict = Record<string, unknown>;

const asDict = (value: unknown): Dict | null =>
  value && typeof value === 'object' ? (value as Dict) : null;

const get = (objectValue: Dict | null, key: string): unknown =>
  objectValue ? objectValue[key] : undefined;

const getStr = (objectValue: Dict | null, key: string): string | undefined => {
  const candidate = get(objectValue, key);
  return typeof candidate === 'string' ? candidate : undefined;
};

export function linesFromDetails(details: readonly unknown[] | undefined): {
  stacks: string[];
  messages: string[];
} {
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

  for (const detail of details) {
    if (typeof detail === 'string') {
      if (/\s+at\s.+\(.+:\d+:\d+\)/.test(detail)) {
        pushMaybe(detail, stacks);
      } else {
        pushMaybe(detail, messages);
      }
      continue;
    }
    const dict = asDict(detail);
    if (dict) {
      pushMaybe(getStr(dict, 'stack'), stacks);
      pushMaybe(getStr(dict, 'message'), messages);

      const err = asDict(get(dict, 'error'));
      pushMaybe(getStr(err, 'stack'), stacks);
      pushMaybe(getStr(err, 'message'), messages);

      const matcherResult = asDict(get(dict, 'matcherResult'));
      pushMaybe(getStr(matcherResult, 'stack'), stacks);
      pushMaybe(getStr(matcherResult, 'message'), messages);
      pushMaybe(getStr(matcherResult, 'expected'), messages);
      pushMaybe(getStr(matcherResult, 'received'), messages);
    }
  }
  return { stacks, messages };
}

// NEW: choose a label that matches the payload
export function labelForMessage(lines: readonly string[]): string {
  const joined = lines.join(' ');
  const matched =
    joined.match(/\b(TypeError|ReferenceError|SyntaxError|RangeError|AssertionError)\b/) ||
    joined.match(/\bError\b/);
  if (matched) {
    const typeName = (matched[1] as string | undefined) ?? 'Error';
    return `${typeName}:`;
  }
  return /expect\(.+?\)\.(?:to|not\.)/.test(joined) ? 'Assertion:' : 'Message:';
}

/** Try to pull rich expected/received from
 * failureDetails.matcherResult; else sniff from message lines */
export function extractExpectedReceived(
  details?: readonly unknown[],
  lines?: readonly string[],
): DiffPayload {
  if (details) {
    for (const detail of details) {
      const dict = asDict(detail);
      const matcherResult = dict && asDict(get(dict, 'matcherResult'));
      if (matcherResult) {
        const expected = get(matcherResult, 'expected');
        const received = get(matcherResult, 'received');
        if (expected !== undefined || received !== undefined) {
          return { expected, received };
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
        continue;
      }
      if (/^\s*Received:/.test(simple)) {
        mode = 'rec';
        receivedLines.push(simple.replace(/^\s*Received:\s*/, ''));
        continue;
      }
      if (/^\s*[-+]\s/.test(simple)) {
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
}

export function extractFromUnifiedDiff(rawLines: readonly string[]): {
  expected?: string;
  received?: string;
} {
  const lines = rawLines.map((lineText) => stripAnsiSimple(lineText));

  // Find the first pretty-format block start, signed or unsigned
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
        // Skip unrelated lines before the pretty block
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
      const expJoined = expectedParts.join('\n');
      expDone = canParseJsonish(expJoined);
    }
    if (!recDone && receivedParts.length > 0) {
      const recJoined = receivedParts.join('\n');
      recDone = canParseJsonish(recJoined);
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
}

function renderPrettyDiff(payload: DiffPayload): string[] {
  const out: string[] = [];
  const { expected, received } = payload;
  if (expected === undefined && received === undefined) {
    return out;
  }

  const expectedString = stringifyPrettierish(expected);
  const receivedString = stringifyPrettierish(received);

  out.push(
    `    ${ansi.bold('Expected')} ${ansi.dim(
      expected && Array.isArray(expected) ? `(len ${(expected as unknown[]).length})` : '',
    )}`,
  );
  out.push(indentBlock(colorTokens.pass(expectedString)));
  out.push(
    `    ${ansi.bold('Received')} ${ansi.dim(
      received && Array.isArray(received) ? `(len ${(received as unknown[]).length})` : '',
    )}`,
  );
  out.push(indentBlock(colorTokens.fail(receivedString)));

  if (isArrayOfPrimitives(expected) && isArrayOfPrimitives(received)) {
    const expectedSet = new Set(expected.map((element) => String(element)));
    const receivedSet = new Set(received.map((element) => String(element)));
    const missing = [...expectedSet].filter((element) => !receivedSet.has(element));
    const unexpected = [...receivedSet].filter((element) => !expectedSet.has(element));
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
      out.push(`    ${ansi.dim('Difference:')} ${colorTokens.fail(parts.join(ansi.dim(' | ')))}`);
    }
  }

  out.push('');
  return out;
}

function pickPrimaryMessage(
  candidateMessageLines: readonly string[],
  details: ReturnType<typeof linesFromDetails>,
): string[] {
  const extracted = extractAssertionMessage(candidateMessageLines);
  if (extracted.length) {
    return extracted;
  }
  const errorLine = details.messages.find((lineText) =>
    /\b(?:Error|TypeError|ReferenceError|SyntaxError|RangeError|AssertionError)\b/.test(lineText),
  );
  if (errorLine) {
    return [errorLine];
  }
  const firstNonEmpty = details.messages.find((lineText) => lineText.trim().length);
  if (firstNonEmpty) {
    return [firstNonEmpty];
  }
  return [];
}

function colorUnifiedDiffLine(simple: string): string {
  if (/^\s*-\s/.test(simple)) {
    return colorTokens.fail(simple);
  }
  if (/^\s*\+\s/.test(simple)) {
    return colorTokens.pass(simple);
  }
  return simple;
}

export type Loc = { file: string; line: number };

export type BuildCtx = {
  readonly projectHint: RegExp;
  readonly editorCmd: string | undefined;
  readonly showStacks: boolean;
};

export const findCodeFrameStart = (lines: readonly string[]): number =>
  lines.findIndex((line) => /^\s*(>?\s*\d+\s*\|)/.test(stripAnsiSimple(line)));

export const deepestProjectLoc = (
  stackLines: readonly string[],
  projectHint: RegExp,
): Loc | null => {
  const idx = findLastProjectFrameIndex(stackLines, projectHint);
  return idx >= 0 ? stackLocation(stackLines[idx]!) : null;
};

export const buildCodeFrameSection = (
  messageLines: readonly string[],
  ctx: BuildCtx,
  synthLoc?: Loc | null,
): string[] => {
  const lines: string[] = [];
  const start = findCodeFrameStart(messageLines);
  if (start >= 0) {
    lines.push(...renderCodeFrame(messageLines, start), '');
    return lines;
  }
  if (ctx.showStacks && synthLoc) {
    lines.push(...renderSourceCodeFrame(synthLoc.file, synthLoc.line), '');
  }
  return lines;
};

export const buildPrettyDiffSection = (
  details?: readonly unknown[],
  messageLines?: readonly string[],
): string[] => renderPrettyDiff(extractExpectedReceived(details, messageLines));

export const buildMessageSection = (
  messageLines: readonly string[],
  details: ReturnType<typeof linesFromDetails>,
  ctx: BuildCtx,
  opts?: { suppressDiff?: boolean; stackPreview?: readonly string[] },
): string[] => {
  const out: string[] = [];

  const primary = pickPrimaryMessage(messageLines, details);

  const filtered = opts?.suppressDiff
    ? primary.filter((raw) => {
        const simple = stripAnsiSimple(raw);
        return (
          !/^\s*(Expected:|Received:|Difference:)\b/.test(simple) &&
          !/^\s*[-+]\s/.test(simple) &&
          !/^\s*(Array\s*\[|Object\s*\{)/.test(simple)
        );
      })
    : primary;

  if (filtered.length) {
    const label = labelForMessage(filtered);
    out.push(`    ${ansi.bold(label)}`);
    for (const lineText of filtered) {
      out.push(`    ${ansi.yellow(colorUnifiedDiffLine(lineText))}`);
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

type ConsoleEntry = Readonly<{
  type?: unknown;
  message?: unknown;
  origin?: unknown;
}>;

function isConsoleEntry(candidate: unknown): candidate is ConsoleEntry {
  return typeof candidate === 'object' && candidate !== null;
}

export const buildConsoleSection = (maybeConsole: unknown): string[] => {
  const out: string[] = [];
  if (!Array.isArray(maybeConsole)) {
    return out;
  }

  const entries = maybeConsole.filter(isConsoleEntry);

  const errorsOnly = entries.filter((entry) => {
    const val = entry?.type;
    return String(val ?? '').toLowerCase() === 'error';
  });
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

export const buildStackSection = (
  mergedForStack: readonly string[],
  ctx: BuildCtx,
  fallbackLoc?: Loc | null,
): string[] => {
  const out: string[] = [];
  out.push(ansi.dim('    Stack:'));
  if (!ctx.showStacks) {
    out.push(`      ${ansi.dim('(hidden by TEST_CLI_STACKS=)')}`, '');
    return out;
  }
  const tail = renderStackTail(mergedForStack, ctx.projectHint, 4);
  if (tail.length) {
    out.push(...tail);
    const loc = deepestProjectLoc(mergedForStack, ctx.projectHint);
    if (loc) {
      const href = preferredEditorHref(loc.file, loc.line, ctx.editorCmd);
      out.push(`      ${ansi.dim('at')} ${osc8(`${path.basename(loc.file)}:${loc.line}`, href)}`);
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

export const formatJestOutputVitest = (
  raw: string,
  opts?: { readonly cwd?: string; readonly editorCmd?: string; readonly onlyFailures?: boolean },
): string => {
  const showStacks = Boolean(env.TEST_CLI_STACKS);
  const cwd = (opts?.cwd ?? process.cwd()).replace(/\\/g, '/');
  const projectHint = new RegExp(
    `(${cwd.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')})|(/gigworx-node/)`,
  );
  const onlyFailures = Boolean(opts?.onlyFailures);
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  const seenFailures = new Set<string>();
  const seenFiles = new Set<string>();
  for (let lineIndex = 0; lineIndex < lines.length; ) {
    const ln = stripAnsiSimple(lines[lineIndex]!);
    if (/^\s*●\s+/.test(ln)) {
      const title = ln.replace(/^\s*●\s+/, '').trim();
      const block: string[] = [lines[lineIndex]!];
      let scanIndex = lineIndex + 1;
      while (scanIndex < lines.length) {
        const scanLine = stripAnsiSimple(lines[scanIndex]!);
        const nextIsStart =
          /^\s*●\s+/.test(scanLine) ||
          /^\s*(PASS|FAIL)\s/.test(scanLine) ||
          /^\s*Test Suites:/.test(scanLine);
        if (nextIsStart && stripAnsiSimple(lines[scanIndex - 1] ?? '').trim() === '') {
          break;
        }
        block.push(lines[scanIndex]!);
        scanIndex += 1;
      }
      const codeFrameStart = block.findIndex((candidateLine) =>
        /^\s*(>?\s*\d+\s*\|)/.test(stripAnsiSimple(candidateLine)),
      );
      const location = firstTestLocation(block, projectHint);
      const rel = location
        ? location.split(':')[0]!.replace(/\\/g, '/').replace(`${cwd}/`, '')
        : '';
      const key = `${rel}|${title}`;
      if (seenFailures.has(key)) {
        lineIndex = scanIndex;
        continue;
      }
      seenFailures.add(key);
      out.push(drawFailLine());
      const header = `${colorTokens.fail('×')} ${ansi.white(rel ? `${rel} > ${title}` : title)}`;
      out.push(header);
      // Reordered block: header already printed → codeframe → pretty diff → message → stack
      const linesBlock = block.map(String);
      const collapsedForSrc = collapseStacks(linesBlock.slice(0));
      // 1) Codeframe (embedded or synthesized)
      if (codeFrameStart >= 0) {
        out.push('');
        out.push(...renderCodeFrame(linesBlock, codeFrameStart));
        out.push('');
      } else if (showStacks) {
        const deepestIdxForSrc = findLastProjectFrameIndex(collapsedForSrc, projectHint);
        const locForSrc =
          deepestIdxForSrc >= 0 ? stackLocation(collapsedForSrc[deepestIdxForSrc]!) : null;
        if (locForSrc) {
          out.push('');
          out.push(...renderSourceCodeFrame(locForSrc.file, locForSrc.line));
          out.push('');
        }
      }
      // 2) Pretty Expected/Received
      const payload = extractExpectedReceived(undefined, linesBlock);
      const hasPretty = payload.expected !== undefined || payload.received !== undefined;
      out.push(...renderPrettyDiff(payload));

      // 3) Message with label + inline top project frames
      const detailsForMsg = linesFromDetails(undefined);
      const collapsedForTail = collapseStacks(linesBlock.slice(0));
      const stackPreview = showStacks ? firstProjectFrames(collapsedForTail, projectHint, 2) : [];
      out.push(
        ...buildMessageSection(
          linesBlock,
          detailsForMsg,
          { projectHint, editorCmd: opts?.editorCmd, showStacks },
          { suppressDiff: hasPretty, stackPreview },
        ),
      );

      // 4) Stack tail last — only if we didn’t inline a preview
      if (showStacks && stackPreview.length === 0) {
        const collapsed = collapseStacks(linesBlock.slice(0));
        out.push(
          ...buildStackSection(collapsed, {
            projectHint,
            editorCmd: opts?.editorCmd,
            showStacks,
          }),
        );
      }
      out.push(drawFailLine());
      out.push('');
      lineIndex = scanIndex;
      continue;
    }
    const passFail = ln.match(/^\s*(PASS|FAIL)\s+(.+)$/);
    if (passFail) {
      const badge = passFail[1]!;
      const fileAbs = passFail[2]!;
      const rel = fileAbs.replace(/\\/g, '/').replace(`${cwd}/`, '');
      if (seenFiles.has(rel)) {
        lineIndex += 1;
        continue;
      }
      seenFiles.add(rel);
      if (!(onlyFailures && badge === 'PASS')) {
        const pill = badge === 'PASS' ? colorTokens.passPill('PASS') : colorTokens.failPill('FAIL');
        out.push(`${pill} ${ansi.white(rel)}`);
      }
      lineIndex += 1;
      continue;
    }
    if (/^\s*(Test Suites:|Tests:|Snapshots:|Time:|Ran all)/.test(ln)) {
      // Always show summary lines in live stream
      out.push(lines[lineIndex]!);
      lineIndex += 1;
      continue;
    }
    if (isStackLine(ln)) {
      if (showStacks) {
        const kept = collapseStacks([lines[lineIndex]!]);
        out.push(...kept);
      }
      lineIndex += 1;
      continue;
    }
    out.push(lines[lineIndex]!);
    lineIndex += 1;
  }
  const rendered = out.join('\n');
  // Detect if no test sections were parsed from the live stream and fall back to JSON rendering
  const hadParsedTests =
    seenFiles.size > 0 ||
    seenFailures.size > 0 ||
    out.some((lineText) => /^(?:\s*)(PASS|FAIL)\b/.test(stripAnsiSimple(lineText)));

  if (!hadParsedTests) {
    const bridgePath = extractBridgePath(raw, cwd);
    if (bridgePath && fs.existsSync(bridgePath)) {
      try {
        const json = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
        const bridge = coerceJestJsonToBridge(json);
        const renderedFromJson = renderVitestFromJestJSON(bridge, opts);
        const prefix = out.join('\n');
        return prefix ? `${prefix}\n${renderedFromJson}` : renderedFromJson;
      } catch {
        // if JSON load fails, fall through to the minimal stream output
      }
    }
  }
  try {
    const preview = rendered.split('\n').slice(0, 2).join('\n');
    // eslint-disable-next-line no-console
    console.info(`formatJestOutputVitest: produced ${out.length} lines; preview:\n${preview}`);
  } catch {
    /* no-op */
  }
  return rendered;
};

export type BridgeJSON = {
  startTime: number;
  testResults: Array<{
    testFilePath: string;
    status: 'passed' | 'failed';
    failureMessage: string;
    failureDetails?: unknown[];
    console?: Array<{ message?: string; type?: string; origin?: string }> | null;
    testResults: Array<{
      fullName: string;
      status: string;
      duration: number;
      location: { line: number; column: number } | null;
      failureMessages: string[];
    }>;
  }>;
  aggregated: {
    numTotalTestSuites: number;
    numPassedTestSuites: number;
    numFailedTestSuites: number;
    numTotalTests: number;
    numPassedTests: number;
    numFailedTests: number;
    numPendingTests: number;
    numTodoTests: number;
    startTime: number;
    success: boolean;
    runTimeMs?: number;
  };
};

type JestAssertionResult = {
  title: string;
  ancestorTitles: string[];
  status: string;
  location?: { line: number; column: number } | null;
  failureMessages?: string[];
  fullName?: string;
  duration?: number;
};

type JestTestResultExtra = {
  readonly failureDetails?: unknown[];
  readonly console?: ReadonlyArray<{
    message?: unknown;
    type?: unknown;
    origin?: unknown;
  }> | null;
  readonly perfStats?: Readonly<Record<string, unknown>>;
};

type JestTestResult = {
  testFilePath?: string;
  name?: string;
  status: 'passed' | 'failed';
  failureMessage?: string;
  assertionResults?: JestAssertionResult[];
} & JestTestResultExtra;

type JestAggregatedResult = {
  startTime: number;
  success: boolean;
  numTotalTestSuites: number;
  numPassedTestSuites: number;
  numFailedTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  testResults: JestTestResult[];
};

const isBridgeJSONLike = (candidate: unknown): candidate is BridgeJSON => {
  const candidateValue = candidate as Record<string, unknown> | null;
  return (
    typeof candidateValue === 'object' &&
    candidateValue !== null &&
    'aggregated' in (candidateValue as Record<string, unknown>)
  );
};

export function coerceJestJsonToBridge(raw: unknown): BridgeJSON {
  if (isBridgeJSONLike(raw)) {
    return raw as BridgeJSON;
  }
  const j = raw as JestAggregatedResult;
  if (!j || !Array.isArray(j.testResults)) {
    throw new Error('Unexpected Jest JSON shape');
  }
  return {
    startTime: Number(j.startTime ?? Date.now()),
    testResults: j.testResults.map((testFileResult) => ({
      testFilePath: testFileResult.testFilePath || testFileResult.name || '',
      status: testFileResult.status,
      failureMessage: testFileResult.failureMessage || '',
      failureDetails: testFileResult.failureDetails ?? [],
      testResults: (testFileResult.assertionResults || []).map((assertion) => ({
        title: assertion.title,
        fullName:
          assertion.fullName || [...(assertion.ancestorTitles || []), assertion.title].join(' '),
        status: assertion.status,
        duration: assertion.duration || 0,
        location: assertion.location ?? null,
        failureMessages: assertion.failureMessages || [],
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
}

const vitestFooter = (
  agg: BridgeJSON['aggregated'],
  _startedAt?: number,
  durationMs?: number,
): string => {
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

  const durMs =
    typeof durationMs === 'number'
      ? durationMs
      : typeof agg.runTimeMs === 'number'
        ? agg.runTimeMs
        : undefined;
  const time = durMs != null ? `${Math.max(0, Math.round(durMs))}ms` : '';
  const thread = ansi.dim('(in thread 0ms, 0.00%)');

  return [
    `${ansi.bold('Test Files')} ${files} ${ansi.dim(`(${agg.numTotalTestSuites})`)}`,
    `${ansi.bold('Tests')}     ${tests} ${ansi.dim(`(${agg.numTotalTests})`)}`,
    `${ansi.bold('Time')}      ${time} ${thread}`,
  ].join('\n');
};

export function renderVitestFromJestJSON(
  data: BridgeJSON,
  opts?: { cwd?: string; editorCmd?: string; onlyFailures?: boolean },
): string {
  const cwd = (opts?.cwd ?? process.cwd()).replace(/\\/g, '/');
  const projectHint = new RegExp(
    `(${cwd.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')})|(/gigworx-node/)`,
  );
  const ctx: BuildCtx = { projectHint, editorCmd: opts?.editorCmd, showStacks: true };
  const onlyFailures = Boolean(opts?.onlyFailures);
  const out: string[] = [];
  // Top RUN line
  if (!onlyFailures) {
    out.push(renderRunLine(cwd));
    out.push('');
  }
  for (const file of data.testResults) {
    const rel = file.testFilePath.replace(/\\/g, '/').replace(`${cwd}/`, '');
    const failed = file.testResults.filter((assertion) => assertion.status === 'failed');
    // Per-file overview list
    if (!onlyFailures) {
      out.push(...buildPerFileOverview(rel, file.testResults));
    }
    // File header block with PASS/FAIL badge
    if (!(onlyFailures && failed.length === 0)) {
      out.push(buildFileBadgeLine(rel, failed.length));
    }
    // Only render file-level failure when there are NO per-assertion failures
    if (file.failureMessage && failed.length === 0) {
      const lines = file.failureMessage.split(/\r?\n/);
      const details = linesFromDetails(file.failureDetails);
      const mergedForStack = collapseStacks([...lines, ...details.stacks]);
      const synthLoc = deepestProjectLoc(mergedForStack, projectHint);
      out.push(...buildCodeFrameSection(lines, ctx, synthLoc));

      const payload = extractExpectedReceived(file.failureDetails, lines);
      const hasPretty = payload.expected !== undefined || payload.received !== undefined;
      out.push(...renderPrettyDiff(payload));

      const stackPreview = ctx.showStacks ? firstProjectFrames(mergedForStack, projectHint, 2) : [];
      out.push(
        ...buildMessageSection(lines, details, ctx, {
          suppressDiff: hasPretty,
          stackPreview,
        }),
      );
      out.push(...buildConsoleSection(file.console ?? null));

      if (ctx.showStacks && stackPreview.length === 0) {
        out.push(...buildStackSection(mergedForStack, ctx));
      }
    }
    for (const failedAssertion of failed) {
      out.push(drawFailLine());
      const header = `${rel} > ${failedAssertion.fullName}`;
      const messagesArray: string[] =
        failedAssertion.failureMessages.length > 0 ? failedAssertion.failureMessages : [''];
      const details = linesFromDetails(file.failureDetails);
      const mergedForStack = collapseStacks([...messagesArray, ...details.stacks]);
      const deepestLoc = deepestProjectLoc(mergedForStack, projectHint);
      const locLink =
        deepestLoc &&
        (() => {
          const href = preferredEditorHref(deepestLoc.file, deepestLoc.line, opts?.editorCmd);
          const base = `${path.basename(deepestLoc.file)}:${deepestLoc.line}`;
          return osc8(base, href);
        })();
      const headerLine = `${ansi.white(header)}${locLink ? `  ${ansi.dim(`(${locLink})`)}` : ''}`;
      const bullet = (text: string) => `${colorTokens.fail('×')} ${ansi.white(text)}`;
      out.push(bullet(headerLine));
      const msgLines = messagesArray.join('\n').split('\n');
      const assertFallback =
        deepestLoc ||
        (failedAssertion.location && {
          file: file.testFilePath,
          line: failedAssertion.location.line,
        });
      out.push('', ...buildCodeFrameSection(msgLines, ctx, assertFallback), '');

      const payload = extractExpectedReceived(file.failureDetails, msgLines);
      const hasPretty = payload.expected !== undefined || payload.received !== undefined;
      out.push(...renderPrettyDiff(payload));

      const stackPreview = ctx.showStacks ? firstProjectFrames(mergedForStack, projectHint, 2) : [];
      out.push(
        ...buildMessageSection(msgLines, details, ctx, { suppressDiff: hasPretty, stackPreview }),
      );
      if (ctx.showStacks && stackPreview.length === 0) {
        out.push(
          ...buildStackSection(
            mergedForStack,
            ctx,
            failedAssertion.location
              ? { file: file.testFilePath, line: failedAssertion.location.line }
              : null,
          ),
        );
      }
      out.push(drawFailLine());
      out.push('');
    }
  }
  // Dashed rule + right-aligned pill (always show final summary)
  const failedCount = data.aggregated.numFailedTests;
  out.push(drawRule(colorTokens.failPill(` Failed Tests ${failedCount} `)));
  out.push('');
  const footer = vitestFooter(
    data.aggregated,
    data.aggregated?.startTime ?? data.startTime,
    data.aggregated?.runTimeMs,
  );
  return `${out.join('\n')}\n${footer}`;
}

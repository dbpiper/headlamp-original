import * as fs from 'node:fs';
import * as util from 'node:util';

import JSON5 from 'json5';

import { ansi } from '../ansi';
import { Colors } from '../colors';
import { stripAnsiSimple, isStackLine } from '../stacks';

export const findCodeFrameStart = (lines: readonly string[]): number =>
  lines.findIndex((line) => /^\s*(>?\s*\d+\s*\|)/.test(stripAnsiSimple(line)));

const sourceCache = new Map<string, readonly string[]>();
const readSource = (file: string): readonly string[] => {
  const normalized = file.replace(/\\/g, '/');
  const hit = sourceCache.get(normalized);
  if (hit) {
    return hit;
  }
  try {
    const txt = fs.readFileSync(normalized, 'utf8');
    const arr = txt.split(/\r?\n/);
    sourceCache.set(normalized, arr);
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
      continue;
    }
    const ptr = raw.match(/^\s*>(\s*\d+)\s*\|\s?(.*)$/);
    if (ptr) {
      const num = ansi.dim(ptr[1]!.trim());
      const code = ansi.yellow(ptr[2] ?? '');
      out.push(`    ${Colors.Failure('>')} ${num} ${ansi.dim('|')} ${code}`);
      continue;
    }
    const nor = raw.match(/^\s*(\d+)\s*\|\s?(.*)$/);
    if (nor) {
      const num = ansi.dim(nor[1]!);
      const code = ansi.dim(nor[2] ?? '');
      out.push(`      ${num} ${ansi.dim('|')} ${code}`);
      continue;
    }
    out.push(`    ${raw}`);
  }
  return out;
};

const renderSourceCodeFrame = (file: string, line: number, context = 3): string[] => {
  const lines = readSource(file);
  if (!lines.length || !Number.isFinite(line)) {
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
  return match ? { file: match[1]!.replace(/\\/g, '/'), line: Number(match[2]!) } : null;
};

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

export const deepestProjectLoc = (
  stackLines: readonly string[],
  projectHint: RegExp,
): { file: string; line: number } | null => {
  const idx = findLastProjectFrameIndex(stackLines, projectHint);
  return idx >= 0 ? stackLocation(stackLines[idx]!) : null;
};

export const buildCodeFrameSection = (
  messageLines: readonly string[],
  ctx: { readonly projectHint: RegExp; readonly editorCmd?: string; readonly showStacks: boolean },
  synthLoc?: { file: string; line: number } | null,
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

const indentBlock = (text: string, pad = '      '): string =>
  text
    .split('\n')
    .map((line) => (line ? pad + line : pad.trimEnd()))
    .join('\n');

const normalizeBlock = (raw: string) =>
  raw
    .replace(/^\s*Array\s*\[/, '[')
    .replace(/^\s*Object\s*\{/, '{')
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

export const buildPrettyDiffSection = (
  details?: readonly unknown[],
  messageLines?: readonly string[],
): string[] => {
  const extract = (): { expected?: unknown; received?: unknown } => {
    if (messageLines && messageLines.length) {
      const expectedLines: string[] = [];
      const receivedLines: string[] = [];
      let mode: 'none' | 'exp' | 'rec' = 'none';
      for (const rawLine of messageLines) {
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
    }
    return {};
  };
  const payload = extract();
  if (payload.expected === undefined && payload.received === undefined) {
    return [];
  }
  const expectedString = stringifyPrettierish(payload.expected);
  const receivedString = stringifyPrettierish(payload.received);
  return [
    `    ${ansi.bold('Expected')}`,
    indentBlock(Colors.Success(expectedString)),
    `    ${ansi.bold('Received')}`,
    indentBlock(Colors.Failure(receivedString)),
    '',
  ];
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
  for (const detail of details) {
    if (typeof detail === 'string') {
      if (/\s+at\s.+\(.+:\d+:\d+\)/.test(detail)) {
        pushMaybe(detail, stacks);
      } else {
        pushMaybe(detail, messages);
      }
      continue;
    }
    const dict = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : null;
    if (dict) {
      pushMaybe((dict as any).stack, stacks);
      pushMaybe((dict as any).message, messages);
      const err =
        (dict as any).error && typeof (dict as any).error === 'object'
          ? ((dict as any).error as Record<string, unknown>)
          : null;
      if (err) {
        pushMaybe((err as any).stack, stacks);
        pushMaybe((err as any).message, messages);
      }
      const matcherResult =
        (dict as any).matcherResult && typeof (dict as any).matcherResult === 'object'
          ? ((dict as any).matcherResult as Record<string, unknown>)
          : null;
      if (matcherResult) {
        pushMaybe((matcherResult as any).stack, stacks);
        pushMaybe((matcherResult as any).message, messages);
        pushMaybe((matcherResult as any).expected, messages);
        pushMaybe((matcherResult as any).received, messages);
      }
    }
  }
  return { stacks, messages };
};

export const buildMessageSection = (
  messageLines: readonly string[],
  _details: { stacks: string[]; messages: string[] },
  _ctx: { projectHint: RegExp; editorCmd?: string; showStacks: boolean },
  opts?: { suppressDiff?: boolean; stackPreview?: readonly string[] },
): string[] => {
  const out: string[] = [];
  const lines = messageLines.map((l) => stripAnsiSimple(l));
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
  const expectedIdx = lines.findIndex((l) => /^\s*Expected:/.test(l));
  const receivedIdx = lines.findIndex((l) => /^\s*Received:/.test(l));
  const diffIdx = lines.findIndex((l) => /^\s*(?:- Expected|\+ Received|Difference:)/.test(l));
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
  if (filtered.length) {
    const label = (() => {
      const joined = filtered.join(' ');
      const m =
        joined.match(/\b(TypeError|ReferenceError|SyntaxError|RangeError|AssertionError)\b/) ||
        joined.match(/\bError\b/);
      if (m) {
        return `${(m[1] as string | undefined) ?? 'Error'}:`;
      }
      return /expect\(.+?\)\.(?:to|not\.)/.test(joined) ? 'Assertion:' : 'Message:';
    })();
    out.push(`    ${ansi.bold(label)}`);
    for (const ln of filtered) {
      const colored = /^\s*-\s/.test(ln)
        ? Colors.Failure(ln)
        : /^\s*\+\s/.test(ln)
          ? Colors.Success(ln)
          : ln;
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
  const onlyStack = mergedForStack.filter((ln) => isStackLine(stripAnsiSimple(ln)));
  const tail = onlyStack.slice(-4);
  if (tail.length) {
    for (const frame of tail) {
      out.push(`      ${stripAnsiSimple(frame)}`);
    }
    out.push('');
    return out;
  }
  if (fallbackLoc) {
    out.push(`      ${fallbackLoc.file}:${fallbackLoc.line}:0`, '');
    return out;
  }
  out.push(`      ${ansi.dim('(no stack provided)')}`, '');
  return out;
};

export const extractBridgePath = (raw: string, cwd: string): string | null => {
  const matches = Array.from(
    raw.matchAll(/Test results written to:\s+([^\n\r]+jest-bridge-[^\s'"]+\.json)/g),
  );
  if (!matches.length) {
    return null;
  }
  const jsonPath = (matches[matches.length - 1]![1] ?? '').trim().replace(/^["'`]|["'`]$/g, '');
  return /^\//.test(jsonPath) ? jsonPath : `${cwd.replace(/\\/g, '/')}/${jsonPath}`;
};

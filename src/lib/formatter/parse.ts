import { some, none, unfoldr } from '../fp';
import type { Chunk } from './model';
import { stripAnsiSimple, isStackLine } from '../stacks';

const isFailureStart = (lineText: string) => /^\s*●\s+/.test(lineText);
const isSuiteLine = (lineText: string) => /^\s*(PASS|FAIL)\s+/.test(lineText);
const isSummaryLine = (lineText: string) =>
  /^\s*(Test Suites:|Tests:|Snapshots:|Time:|Ran all)/.test(lineText);

const collectFailure = (
  allLines: ReadonlyArray<string>,
  startIndex: number,
): readonly [Chunk, number] => {
  const title = stripAnsiSimple(allLines[startIndex]!)
    .replace(/^\s*●\s+/, '')
    .trim();
  const buf: string[] = [allLines[startIndex]!];
  let i = startIndex + 1;
  for (; i < allLines.length; i += 1) {
    const simple = stripAnsiSimple(allLines[i]!);
    const nextIsStart = isFailureStart(simple) || isSuiteLine(simple) || isSummaryLine(simple);
    const prevBlank = stripAnsiSimple(allLines[i - 1] ?? '').trim() === '';
    if (nextIsStart && prevBlank) {
      break;
    }
    buf.push(allLines[i]!);
  }
  return [{ tag: 'FailureBlock', title, lines: buf }, i];
};

const parseSuite = (lineText: string): Chunk => {
  const match = lineText.match(/^\s*(PASS|FAIL)\s+(.+)$/)!;
  return { tag: 'PassFail', badge: match[1] as 'PASS' | 'FAIL', rel: match[2]! };
};

export const parseChunks = (raw: string): ReadonlyArray<Chunk> => {
  const lines = raw.split(/\r?\n/);
  type State = { readonly index: number };
  return unfoldr<State, Chunk>({ index: 0 }, (state) => {
    if (state.index >= lines.length) {
      return none;
    }
    const line = lines[state.index]!;
    const simple = stripAnsiSimple(line);
    if (isFailureStart(simple)) {
      const [chunk, next] = collectFailure(lines, state.index);
      return some([chunk, { index: next }]);
    }
    if (isSuiteLine(simple)) {
      return some([parseSuite(simple), { index: state.index + 1 }]);
    }
    if (isSummaryLine(simple)) {
      return some([{ tag: 'Summary', line }, { index: state.index + 1 }]);
    }
    if (isStackLine(simple)) {
      return some([{ tag: 'Stack', line }, { index: state.index + 1 }]);
    }
    return some([{ tag: 'Other', line }, { index: state.index + 1 }]);
  });
};

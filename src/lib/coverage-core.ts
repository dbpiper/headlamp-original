/* eslint-disable import/no-extraneous-dependencies */
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';

import { relativizeForMatch } from './paths';

const require = createRequire(import.meta.url);

const { createCoverageMap } =
  // eslint-disable-next-line import/no-extraneous-dependencies
  require('istanbul-lib-coverage') as typeof import('istanbul-lib-coverage');

export const readCoverageJson = async (jsonPath: string) => {
  try {
    const txt = await fs.readFile(jsonPath, 'utf8');
    if (txt.trim().length === 0) {
      return {} as import('istanbul-lib-coverage').CoverageMapData;
    }
    const raw = JSON.parse(txt) as unknown;
    return (raw ?? {}) as import('istanbul-lib-coverage').CoverageMapData;
  } catch {
    return {} as import('istanbul-lib-coverage').CoverageMapData;
  }
};

export const filterCoverageMap = (
  map: import('istanbul-lib-coverage').CoverageMap,
  opts: {
    readonly includes: readonly string[];
    readonly excludes: readonly string[];
    readonly root: string;
    readonly selectionSpecified: boolean;
  },
) => {
  // local picomatch import to avoid circulars
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const picomatchFn = require('picomatch') as unknown as (
    globs: string | readonly string[],
    options?: { readonly nocase?: boolean; readonly dot?: boolean },
  ) => (str: string) => boolean;
  const makeMatcher = (globs: readonly string[]) =>
    globs.length === 0 ? () => true : picomatchFn(globs as string[], { dot: true, nocase: true });

  const includeMatch = makeMatcher(opts.includes.length ? opts.includes : ['**/*']);
  const excludeMatch = makeMatcher(opts.excludes);
  const out = createCoverageMap({});

  for (const absFile of map.files()) {
    const rel = relativizeForMatch(absFile, opts.root);
    const summary = map.fileCoverageFor(absFile).toSummary();

    const executed =
      summary.statements.covered > 0 ||
      summary.functions.covered > 0 ||
      summary.branches.covered > 0 ||
      summary.lines.covered > 0;

    if (executed) {
      out.addFileCoverage(map.fileCoverageFor(absFile));
    } else {
      const inc = includeMatch(rel);
      let exc = excludeMatch(rel);
      if (opts.selectionSpecified) {
        exc = /\b(node_modules|coverage|dist|build)\b/.test(rel) && exc;
      }
      if (inc && !exc) {
        out.addFileCoverage(map.fileCoverageFor(absFile));
      }
    }
  }
  return out;
};

export const computeUncoveredBlocks = (
  file: import('istanbul-lib-coverage').FileCoverage,
): ReadonlyArray<{ readonly start: number; readonly end: number }> => {
  const stmtHitsById = file.data.s as Record<string, number>;
  const sm = file.data.statementMap as Record<
    string,
    { start: { line: number }; end: { line: number } }
  >;
  const missed = new Set<number>();
  for (const statementId of Object.keys(stmtHitsById)) {
    if ((stmtHitsById[statementId] ?? 0) > 0) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const loc = sm[statementId];
    const from = Math.max(1, loc?.start.line ?? 0);
    const to = Math.max(from, loc?.end.line ?? 0);
    for (let ln = from; ln <= to; ln += 1) {
      missed.add(ln);
    }
  }
  const lines = Array.from(missed).sort((leftLine, rightLine) => leftLine - rightLine);
  const ranges: { start: number; end: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index]!;
    let end = start;
    while (index + 1 < lines.length && lines[index + 1] === end + 1) {
      index += 1;
      end = lines[index]!;
    }
    ranges.push({ start, end });
  }
  return ranges;
};

export const missedBranches = (
  file: import('istanbul-lib-coverage').FileCoverage,
): ReadonlyArray<{
  readonly id: string;
  readonly line: number;
  readonly zeroPaths: readonly number[];
}> => {
  const branchHitsById = file.data.b as Record<string, number[]>;
  const branchMap = file.data.branchMap as Record<string, { line: number }>;
  const out: { id: string; line: number; zeroPaths: number[] }[] = [];
  for (const id of Object.keys(branchHitsById)) {
    const hitsArray = branchHitsById[id] ?? [];
    const zeros: number[] = [];
    hitsArray.forEach((hits, index) => {
      if (hits === 0) {
        zeros.push(index);
      }
    });
    if (zeros.length) {
      out.push({ id, line: branchMap[id]?.line ?? 0, zeroPaths: zeros });
    }
  }
  return out.sort((firstBranch, secondBranch) => firstBranch.line - secondBranch.line);
};

export const missedFunctions = (
  file: import('istanbul-lib-coverage').FileCoverage,
): ReadonlyArray<{ readonly name: string; readonly line: number }> => {
  const functionHitCounts = file.data.f as Record<string, number>;
  const functionMap = file.data.fnMap as Record<string, { name: string; line: number }>;
  const out: { name: string; line: number }[] = [];
  for (const id of Object.keys(functionHitCounts)) {
    if ((functionHitCounts[id] ?? 0) === 0) {
      const meta = functionMap[id];
      out.push({ name: meta?.name ?? '(anonymous)', line: meta?.line ?? 0 });
    }
  }
  return out.sort((firstFunction, secondFunction) => firstFunction.line - secondFunction.line);
};

const clamp = (value: number, lowerBound: number, upperBound: number) =>
  Math.max(lowerBound, Math.min(upperBound, value));

export const renderCodeFrame = (
  source: string,
  miss: { readonly start: number; readonly end: number },
  context = 3,
): string => {
  const lines = source.split(/\r?\n/);
  const from = clamp(miss.start - context, 1, lines.length);
  const to = clamp(miss.end + context, 1, lines.length);
  const out: string[] = [];
  for (let ln = from; ln <= to; ln += 1) {
    const body = lines[ln - 1] ?? '';
    const tag =
      ln >= miss.start && ln <= miss.end
        ? `> ${ln.toString().padStart(4)}|`
        : `  ${ln.toString().padStart(4)}|`;
    out.push(`${tag} ${body}`);
  }
  return out.join('\n');
};

export const compositeBarPct = (
  summary: import('istanbul-lib-coverage').CoverageSummary,
  hotspots: ReadonlyArray<{ readonly start: number; readonly end: number }>,
): number => {
  const base = Math.min(
    Number.isFinite(summary.lines.pct) ? (summary.lines.pct as number) : 0,
    Number.isFinite(summary.functions.pct) ? (summary.functions.pct as number) : 0,
    Number.isFinite(summary.branches.pct) ? (summary.branches.pct as number) : 0,
  );
  const totalLines = (summary.lines.total ?? 0) as number;
  let penalty = 0;
  if (totalLines > 0 && hotspots.length > 0) {
    const largestRange = Math.max(...hotspots.map((range) => range.end - range.start + 1));
    const concentration = largestRange / totalLines;
    penalty = Math.min(15, Math.round(concentration * 100 * 0.5));
  }
  return Math.max(0, Math.min(100, base - penalty));
};

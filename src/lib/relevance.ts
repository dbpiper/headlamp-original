import * as path from 'node:path';

import { DEFAULT_EXCLUDE } from './args';
import { cachedRelated, findRelatedTestsFast, DEFAULT_TEST_GLOBS } from './fast-related';
import { discoverTestsForHttpPaths, getRouteIndex } from './routeGraph';
import { pipe } from './fp';

export type TestFileResultLike = Readonly<{
  testFilePath: string;
  status?: string;
  testResults?: ReadonlyArray<{ readonly status?: string }>;
}>;

const normalizeAbs = (inputPath: string): string => path.resolve(inputPath).replace(/\\/g, '/');

const compareBooleanDesc = (left: boolean, right: boolean): number => {
  if (left === right) {
    return 0;
  }
  return right ? 1 : -1; // true first
};

const compareNumberAsc = (left: number, right: number): number => left - right;

const compareStringAsc = (left: string, right: string): number => left.localeCompare(right);

const fileFailed = (file: TestFileResultLike): boolean =>
  Boolean(
    (file.status ?? '') === 'failed' ||
      (file.testResults ?? []).some((assertion) => (assertion.status ?? '') === 'failed'),
  );

export const composeComparators =
  <T>(...comparators: ReadonlyArray<(l: T, r: T) => number>): ((l: T, r: T) => number) =>
  (left: T, right: T) => {
    for (const cmp of comparators) {
      const result = cmp(left, right);
      if (result !== 0) {
        return result;
      }
    }
    return 0;
  };

export const comparatorForRank = (
  rankByPath: ReadonlyMap<string, number>,
): ((left: TestFileResultLike, right: TestFileResultLike) => number) => {
  const rankOrInf = (absPath: string) =>
    rankByPath.has(absPath) ? (rankByPath.get(absPath) as number) : Number.POSITIVE_INFINITY;
  return composeComparators<TestFileResultLike>(
    (left, right) => compareBooleanDesc(fileFailed(left), fileFailed(right)),
    (left, right) =>
      compareNumberAsc(
        rankOrInf(normalizeAbs(left.testFilePath)),
        rankOrInf(normalizeAbs(right.testFilePath)),
      ),
    (left, right) =>
      compareStringAsc(normalizeAbs(left.testFilePath), normalizeAbs(right.testFilePath)),
  );
};

type AugmentHttpArgs = Readonly<{
  readonly repoRoot: string;
  readonly productionSeeds: ReadonlyArray<string>;
  readonly related: ReadonlyArray<string>;
  readonly excludeGlobs: ReadonlyArray<string>;
}>;

export const augmentWithHttpRouteTests = async (
  args: AugmentHttpArgs,
): Promise<ReadonlyArray<string>> => {
  if (args.productionSeeds.length === 0) {
    return args.related;
  }
  try {
    const index = await getRouteIndex(args.repoRoot);
    const httpPaths = pipe(
      args.productionSeeds,
      (seeds) =>
        seeds
          .flatMap((seed) => index.httpRoutesForSource(seed))
          .filter((pathText) => pathText.length > 0),
      (paths) => Array.from(new Set(paths)),
    );
    if (httpPaths.length === 0) {
      return args.related;
    }
    const routeTests = await discoverTestsForHttpPaths(args.repoRoot, httpPaths, args.excludeGlobs);
    if (routeTests.length === 0) {
      return args.related;
    }
    const existing = new Set(args.related.map((candidate) => normalizeAbs(candidate)));
    const additions = pipe(
      routeTests,
      (tests) => tests.map((candidate) => normalizeAbs(candidate)),
      (tests) => tests.filter((candidate) => !existing.has(candidate)),
    );
    if (additions.length === 0) {
      return args.related;
    }
    return [...args.related, ...additions];
  } catch {
    return args.related;
  }
};

export type DirectnessRankOptions = Readonly<{
  repoRoot: string;
  productionSeeds: ReadonlyArray<string>;
  excludeGlobs?: ReadonlyArray<string>;
}>;

export const computeDirectnessRank = async (
  opts: DirectnessRankOptions,
): Promise<Map<string, number>> => {
  const selectionKey = opts.productionSeeds
    .map((abs) => path.relative(opts.repoRoot, abs).replace(/\\/g, '/'))
    .sort((left, right) => left.localeCompare(right))
    .join('|');
  const related = await cachedRelated({
    repoRoot: opts.repoRoot,
    selectionKey,
    compute: () =>
      findRelatedTestsFast({
        repoRoot: opts.repoRoot,
        seeds: opts.productionSeeds,
        testGlobs: DEFAULT_TEST_GLOBS,
        excludeGlobs: opts.excludeGlobs ?? DEFAULT_EXCLUDE,
        timeoutMs: 1500,
      }),
  });
  const augmented = await augmentWithHttpRouteTests({
    repoRoot: opts.repoRoot,
    productionSeeds: opts.productionSeeds,
    excludeGlobs: opts.excludeGlobs ?? DEFAULT_EXCLUDE,
    related,
  });
  const out = new Map<string, number>();
  augmented.forEach((abs, index) => {
    out.set(normalizeAbs(abs), index);
  });
  return out;
};

export const sortTestResultsWithRank = <T extends TestFileResultLike>(
  rankByPath: ReadonlyMap<string, number>,
  results: ReadonlyArray<T>,
): T[] => results.slice().sort(comparatorForRank(rankByPath) as (l: T, r: T) => number);

// Path-only comparator/sorter (for coverage files, etc.)
export const comparatorForPathRank = (
  rankByPath: ReadonlyMap<string, number>,
): ((leftPath: string, rightPath: string) => number) => {
  const rankOrInf = (absPath: string) =>
    rankByPath.has(absPath) ? (rankByPath.get(absPath) as number) : Number.POSITIVE_INFINITY;
  return composeComparators<string>(
    (left, right) =>
      compareNumberAsc(rankOrInf(normalizeAbs(left)), rankOrInf(normalizeAbs(right))),
    (left, right) => compareStringAsc(normalizeAbs(left), normalizeAbs(right)),
  );
};

export const sortPathsWithRank = (
  rankByPath: ReadonlyMap<string, number>,
  paths: ReadonlyArray<string>,
): string[] => paths.slice().sort(comparatorForPathRank(rankByPath));

export const augmentRankWithPriorityPaths = (
  rankByPath: ReadonlyMap<string, number>,
  priorityPaths: ReadonlyArray<string>,
): ReadonlyMap<string, number> => {
  if (priorityPaths.length === 0) {
    return rankByPath;
  }
  const base = new Map(rankByPath);
  const total = priorityPaths.length;
  priorityPaths
    .map((abs) => normalizeAbs(abs))
    .forEach((abs, index) => {
      const priority = -(total - index);
      const existing = base.get(abs);
      const next = existing !== undefined ? Math.min(existing, priority) : priority;
      base.set(abs, next);
    });
  return base;
};

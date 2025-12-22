/* eslint-disable import/no-extraneous-dependencies */
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { ripgrepSearch, isRipgrepAvailable } from './ripgrep-utils';
import { getShortCommitHash } from './git-utils';

const TailSegmentCount = 2 as const;
const EmptyCount = 0 as const;
const JsonIndentSpaces = 2 as const;

export const DEFAULT_TEST_GLOBS = [
  '**/*.{test,spec}.{ts,tsx,js,jsx}',
  'tests/**/*.{ts,tsx,js,jsx}',
] as const;

export type FindRelatedOpts = {
  readonly repoRoot: string;
  readonly seeds: ReadonlyArray<string>;
  readonly testGlobs?: readonly string[];
  readonly excludeGlobs?: readonly string[];
  readonly timeoutMs?: number;
};

export const findRelatedTestsFast = async (opts: FindRelatedOpts): Promise<readonly string[]> => {
  const repoRoot = path.resolve(opts.repoRoot);
  const testGlobs = opts.testGlobs ?? DEFAULT_TEST_GLOBS;
  const excludeGlobs = opts.excludeGlobs ?? [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/.next/**',
  ];

  const toSeeds = (abs: string) => {
    const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
    const withoutExt = rel.replace(/\.(m?[tj]sx?|c[jt]s)$/i, '');
    const base = path.basename(withoutExt);
    const segs = withoutExt.split('/');
    const tail2 = segs.slice(-TailSegmentCount).join('/');
    const uniq = Array.from(new Set([withoutExt, base, tail2].filter(Boolean)));
    return uniq;
  };

  const seeds = Array.from(
    new Set(opts.seeds.flatMap((candidate) => toSeeds(path.resolve(candidate)))),
  );
  if (seeds.length === EmptyCount) {
    return [] as string[];
  }

  const rgAvailable = await isRipgrepAvailable();
  if (!rgAvailable) {
    return [] as string[];
  }

  let raw = '';
  try {
    raw = await ripgrepSearch(seeds, testGlobs, excludeGlobs, repoRoot, {
      lineNumbers: true,
      filesWithMatches: true,
      smartCase: true,
      fixedStrings: true,
      env: { CI: '1' },
    });
  } catch {
    raw = '';
  }

  const lines = raw
    .split(/\r?\n/)
    .map((lineText) => lineText.trim())
    .filter(Boolean);

  const looksLikeTest = (pathText: string) =>
    /\.(test|spec)\.[tj]sx?$/i.test(pathText) || /(^|\/)tests?\//i.test(pathText);

  const absolute = lines
    .map((relativePath) => path.resolve(repoRoot, relativePath).replace(/\\/g, '/'))
    .filter(looksLikeTest);

  const uniq = Array.from(new Set(absolute));
  const checks = await Promise.all(
    uniq.map(async (absolutePath) => {
      try {
        await fs.access(absolutePath);
        return absolutePath;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((p): p is string => typeof p === 'string');
};

export const cachedRelated = async (opts: {
  readonly repoRoot: string;
  readonly selectionKey: string;
  readonly compute: () => Promise<readonly string[]>;
}): Promise<readonly string[]> => {
  const cacheRoot = process.env.HEADLAMP_CACHE_DIR || path.join(os.tmpdir(), 'headlamp-cache');
  const repoKey = createHash('sha1').update(path.resolve(opts.repoRoot)).digest('hex').slice(0, 12);
  const cacheDir = path.join(cacheRoot, repoKey);
  const cacheFile = path.join(cacheDir, 'relevant-tests.json');

  const head = await getShortCommitHash({ cwd: opts.repoRoot });

  const key = `${head}::${opts.selectionKey}`;

  let bag: Record<string, string[]> = {};
  try {
    const read = await fs.readFile(cacheFile, 'utf8');
    bag = JSON.parse(read) as Record<string, string[]>;
  } catch {
    bag = {};
  }

  const hit = bag[key];
  if (hit?.length) {
    // Validate cached paths still exist on disk; if any are missing, recompute
    const existing: string[] = [];
    await Promise.all(
      hit.map(async (candidatePath) => {
        try {
          await fs.access(candidatePath);
          existing.push(candidatePath);
        } catch {
          // missing → ignore; will trigger recompute below
        }
      }),
    );
    if (existing.length === hit.length) {
      return existing as readonly string[];
    }
    // One or more cached entries are stale; recompute and refresh cache
    const recomputed = await opts.compute();
    try {
      const next = { ...bag, [key]: Array.from(new Set(recomputed)) } as Record<string, string[]>;
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(next, null, JsonIndentSpaces));
    } catch {
      /* ignore cache write errors */
    }
    return recomputed as readonly string[];
  }

  const computed = await opts.compute();
  try {
    const next = { ...bag, [key]: Array.from(new Set(computed)) } as Record<string, string[]>;
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify(next, null, JsonIndentSpaces));
  } catch {
    /* ignore cache write errors */
  }
  return computed;
};

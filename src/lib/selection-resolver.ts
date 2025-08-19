import * as path from 'node:path';
import * as fsSync from 'node:fs';

import { safeEnv } from './env-utils';
import { runText } from './_exec';

const toAbsPosix = (absPath: string): string => path.resolve(absPath).replace(/\\/g, '/');
const existsFile = (absPath: string): boolean => {
  try {
    const stat = fsSync.statSync(absPath);
    return stat.isFile();
  } catch {
    return false;
  }
};

export const isTestLikePathToken = (candidate: string): boolean =>
  /\.(test|spec)\.[tj]sx?$/i.test(candidate) || /(^|\/)tests?\//i.test(candidate);

const isTestFilePath = (absPath: string): boolean => isTestLikePathToken(absPath);

type ResolveOptions = {
  readonly includeGlobs?: readonly string[];
  readonly excludeGlobs?: readonly string[];
  readonly onlyTestFiles?: boolean;
  readonly forbidTestFiles?: boolean;
};

const DEFAULT_EXCLUDES = [
  '!**/node_modules/**',
  '!**/coverage/**',
  '!**/dist/**',
  '!**/build/**',
] as const;

const unique = <T>(values: readonly T[]): readonly T[] => Array.from(new Set(values));

const resolveTokens = async (
  tokens: readonly string[],
  repoRoot: string,
  opts?: ResolveOptions,
): Promise<readonly string[]> => {
  const includeGlobs = (opts?.includeGlobs ?? []) as string[];
  const excludeGlobs = unique([...(opts?.excludeGlobs ?? []), ...DEFAULT_EXCLUDES]) as string[];
  const results = new Set<string>();

  const pushIf = (absPath: string) => {
    const norm = toAbsPosix(absPath);
    if (existsFile(norm)) results.add(norm);
  };

  for (const raw of tokens) {
    const token = String(raw || '').trim();
    if (!token) {
      // eslint-disable-next-line no-continue
      continue;
    }
    if (path.isAbsolute(token)) {
      pushIf(token);
      // eslint-disable-next-line no-continue
      continue;
    }
    if (token.startsWith('/')) {
      pushIf(path.join(repoRoot, token.slice(1)));
    }
    try {
      const args: string[] = ['--files', '-g', `**/${token}`];
      for (const g of includeGlobs) {
        args.push('-g', g);
      }
      for (const g of excludeGlobs) {
        args.push('-g', g);
      }
      // eslint-disable-next-line no-await-in-loop
      const out = await runText('rg', args, {
        cwd: repoRoot,
        env: safeEnv(process.env, {}) as unknown as NodeJS.ProcessEnv,
        timeoutMs: 4000,
      });
      out
        .split(/\r?\n/)
        .map((ln) => ln.trim())
        .filter(Boolean)
        .map((rel) => toAbsPosix(path.resolve(repoRoot, rel)))
        .forEach((abs) => results.add(abs));
    } catch {
      /* ignore ripgrep failures */
    }
  }

  const filtered = Array.from(results).filter((absPath) => {
    const isTest = isTestFilePath(absPath);
    if (opts?.onlyTestFiles) return isTest;
    if (opts?.forbidTestFiles) return !isTest;
    return true;
  });
  return unique(filtered);
};

export const resolveTestSelectionTokens = async (
  tokens: readonly string[],
  repoRoot: string,
): Promise<readonly string[]> =>
  resolveTokens(tokens, repoRoot, {
    onlyTestFiles: true,
    includeGlobs: ['**/*.test.*', '**/*.spec.*', 'tests/**/*'],
  });

export const resolveProdSelectionTokens = async (
  tokens: readonly string[],
  repoRoot: string,
): Promise<readonly string[]> => resolveTokens(tokens, repoRoot, { forbidTestFiles: true });

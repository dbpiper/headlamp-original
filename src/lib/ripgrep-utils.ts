import { runText } from './_exec';
import { safeEnv } from './env-utils';

const isNoMatchExit = (error: unknown): boolean =>
  error instanceof Error && /\bexit 1\b/.test(error.message);

export type RipgrepOptions = {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly ignoreGitignore?: boolean;
};

/**
 * Run ripgrep to list files matching the given glob patterns.
 * By default, includes untracked/ignored files (--no-ignore).
 */
export const ripgrepFiles = async (
  patterns: readonly string[],
  excludePatterns: readonly string[] = [],
  opts?: RipgrepOptions,
): Promise<string> => {
  const args: string[] = ['--files'];

  // Include untracked/ignored files by default
  if (opts?.ignoreGitignore !== true) {
    args.push('--no-ignore');
  }

  for (const pattern of patterns) {
    args.push('-g', pattern);
  }

  for (const excludePattern of excludePatterns) {
    args.push('-g', excludePattern);
  }

  return runText('rg', args, {
    cwd: opts?.cwd ?? process.cwd(),
    env: safeEnv(process.env, opts?.env ?? {}) as unknown as NodeJS.ProcessEnv,
    timeoutMs: opts?.timeoutMs ?? 4000,
  });
};

/**
 * Run ripgrep to search file contents for the given patterns.
 * By default, includes untracked/ignored files (--no-ignore).
 */
export const ripgrepSearch = async (
  searchPatterns: readonly string[],
  globPatterns: readonly string[] = [],
  excludeGlobPatterns: readonly string[] = [],
  targetPath: string,
  opts?: RipgrepOptions & {
    readonly lineNumbers?: boolean;
    readonly filesWithMatches?: boolean;
    readonly smartCase?: boolean;
    readonly fixedStrings?: boolean;
  },
): Promise<string> => {
  const args: string[] = [];

  // Add search behavior flags
  if (opts?.lineNumbers) args.push('-n');
  if (opts?.filesWithMatches) args.push('-l');
  if (opts?.smartCase) args.push('-S');
  if (opts?.fixedStrings) args.push('-F');

  // Include untracked/ignored files by default
  if (opts?.ignoreGitignore !== true) {
    args.push('--no-ignore');
  }

  // Add glob patterns
  for (const pattern of globPatterns) {
    args.push('-g', pattern);
  }

  for (const excludePattern of excludeGlobPatterns) {
    args.push('-g', `!${excludePattern}`);
  }

  // Add search patterns
  for (const pattern of searchPatterns) {
    args.push('-e', pattern);
  }

  args.push(targetPath);

  try {
    return await runText('rg', args, {
      env: safeEnv(process.env, opts?.env ?? {}) as unknown as NodeJS.ProcessEnv,
      timeoutMs: opts?.timeoutMs,
    });
  } catch (error) {
    if (isNoMatchExit(error)) {
      return '';
    }
    throw error;
  }
};

/**
 * Check if ripgrep is available.
 */
export const isRipgrepAvailable = async (): Promise<boolean> => {
  try {
    const version = await runText('rg', ['--version'], {
      env: safeEnv(process.env, {}) as unknown as NodeJS.ProcessEnv,
    });
    return Boolean(version);
  } catch {
    return false;
  }
};

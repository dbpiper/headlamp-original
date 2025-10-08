import { runText } from './_exec';
import { safeEnv } from './env-utils';

export type GitOptions = {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 4000;

const runGit = async (args: readonly string[], opts?: GitOptions): Promise<string> =>
  runText('git', args, {
    cwd: opts?.cwd ?? process.cwd(),
    env: safeEnv(process.env, opts?.env ?? {}) as unknown as NodeJS.ProcessEnv,
    timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

const runGitLines = async (
  args: readonly string[],
  opts?: GitOptions,
): Promise<readonly string[]> => {
  try {
    const output = await runGit(args, opts);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

export const getShortCommitHash = async (opts?: GitOptions): Promise<string> => {
  const cwd = opts?.cwd ?? process.cwd();
  try {
    const raw = await runGit(['-C', cwd, 'rev-parse', '--short', 'HEAD'], opts);
    return raw.trim() || 'nogit';
  } catch {
    return 'nogit';
  }
};

export const getGitStatus = async (opts?: GitOptions): Promise<string> => {
  const cwd = opts?.cwd ?? process.cwd();
  try {
    return await runGit(['-C', cwd, 'status', '--porcelain'], opts);
  } catch {
    return '';
  }
};

export const getChangedFilesSinceHead = async (opts?: GitOptions): Promise<readonly string[]> =>
  runGitLines(['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD'], opts);

export const getChangeStats = async (
  files: readonly string[],
  opts?: GitOptions,
): Promise<readonly string[]> => {
  if (files.length === 0) return [];
  return runGitLines(['diff', '--numstat', '--', ...files], opts);
};

export const verifyRef = async (ref: string, opts?: GitOptions): Promise<boolean> => {
  const lines = await runGitLines(['rev-parse', '--verify', ref], opts);
  return lines.length > 0;
};

export const getSymbolicRef = async (ref: string, opts?: GitOptions): Promise<readonly string[]> =>
  runGitLines(['symbolic-ref', ref], opts);

export const getMergeBase = async (
  commit1: string,
  commit2: string,
  opts?: GitOptions,
): Promise<string | undefined> => {
  const lines = await runGitLines(['merge-base', commit1, commit2], opts);
  return lines[0];
};

export const getDiffBetweenCommits = async (
  base: string,
  head: string,
  opts?: GitOptions,
): Promise<readonly string[]> =>
  runGitLines(['diff', '--name-only', '--diff-filter=ACMRTUXB', base, head], opts);

export const getStagedFiles = async (opts?: GitOptions): Promise<readonly string[]> =>
  runGitLines(['diff', '--name-only', '--diff-filter=ACMRTUXB', '--cached'], opts);

export const getUnstagedFiles = async (opts?: GitOptions): Promise<readonly string[]> =>
  runGitLines(['diff', '--name-only', '--diff-filter=ACMRTUXB'], opts);

export const getUntrackedFiles = async (opts?: GitOptions): Promise<readonly string[]> =>
  runGitLines(['ls-files', '--others', '--exclude-standard'], opts);

export const getDefaultBranch = async (opts?: GitOptions): Promise<string | undefined> => {
  const candidates: string[] = [];
  try {
    const sym = await getSymbolicRef('refs/remotes/origin/HEAD', opts);
    const headRef = sym.find((ln) => ln.includes('refs/remotes/origin/'));
    if (headRef) {
      const parts = headRef.split('/');
      const branchName = parts[parts.length - 1];
      if (branchName) {
        candidates.push(`origin/${branchName}`);
      }
    }
  } catch {
    /* ignore */
  }
  candidates.push('origin/main', 'origin/master');
  for (const cand of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await verifyRef(cand, opts);
    if (exists) {
      return cand;
    }
  }
  return undefined;
};

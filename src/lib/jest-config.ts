import * as path from 'node:path';
import * as fs from 'node:fs';

const CANDIDATE_FILENAMES: readonly string[] = [
  'jest.config.cjs',
  'jest.config.js',
  'jest.config.mjs',
  'jest.config.ts',
  'jest.ts.config.js',
  'jest.ts.config.cjs',
];

export const listAllJestConfigs = (cwd?: string): readonly string[] => {
  const baseDir = cwd ?? process.cwd();
  const discovered: string[] = [];
  for (const name of CANDIDATE_FILENAMES) {
    const abs = path.join(baseDir, name);
    // eslint-disable-next-line no-sync
    if (fs.existsSync(abs)) discovered.push(abs);
  }
  return discovered as readonly string[];
};

export const findFirstJestConfig = (cwd?: string): string | undefined => {
  const all = listAllJestConfigs(cwd);
  return all.length > 0 ? all[0] : undefined;
};

export const appendConfigArgIfMissing = (
  args: readonly string[],
  cwd?: string,
): readonly string[] => {
  if (args.includes('--config')) return args;
  const found = findFirstJestConfig(cwd);
  if (!found) return args;
  const baseDir = cwd ?? process.cwd();
  const rel = path.relative(baseDir, found).replace(/\\/g, '/');
  const configToken = rel && !rel.startsWith('..') ? rel : found;
  return [...args, '--config', configToken];
};

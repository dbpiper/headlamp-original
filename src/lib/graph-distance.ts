import * as path from 'node:path';

import { safeEnv } from './env-utils';
import { runText } from './_exec';
import { resolveImportWithRoot } from './path-resolver';

export type ImportSpecExtractor = (absPath: string) => Promise<readonly string[]>;

// Regex patterns for ripgrep (kept as raw templates to preserve backslashes)
const RG_IMPORT_FROM = String.raw`import\s+[^'"\n]*from\s+['"]([^'"]+)['"]`;
const RG_REQUIRE = String.raw`require\(\s*['"]([^'"]+)['"]\s*\)`;
const RG_EXPORT_FROM = String.raw`export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]`;
const RG_DYNAMIC_IMPORT = String.raw`import\(\s*['"]([^'"]+)['"]\s*\)`;

export const extractImportSpecs: ImportSpecExtractor = async (absPath) => {
  const args: string[] = [
    '--pcre2',
    '--no-filename',
    '--no-line-number',
    '--max-columns=200',
    '--max-columns-preview',
    '--no-messages',
    '-o',
    '--replace',
    '$1',
    '-e',
    RG_IMPORT_FROM,
    '-e',
    RG_REQUIRE,
    '-e',
    RG_EXPORT_FROM,
    '-e',
    RG_DYNAMIC_IMPORT,
    absPath,
  ];
  let raw = '';
  try {
    raw = await runText('rg', args, {
      env: safeEnv(process.env, { CI: '1' }) as unknown as NodeJS.ProcessEnv,
      timeoutMs: 1200,
    });
  } catch {
    raw = '';
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

export const isTestLikePath = (abs: string): boolean =>
  /(^|\/)__tests__\//.test(abs) ||
  /(^|\/)tests?\//.test(abs) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(abs);

// Return tests that directly import any of the production files (distance 1).
export const selectDirectTestsForProduction = async (opts: {
  readonly rootDir: string;
  readonly testFiles: readonly string[];
  readonly productionFiles: readonly string[];
}): Promise<readonly string[]> => {
  const specsCache = new Map<string, readonly string[]>();
  const resolutionCache = new Map<string, string | undefined>();
  const prodSet = new Set(
    opts.productionFiles.map((prodPath) => path.resolve(prodPath).replace(/\\/g, '/')),
  );
  const out: string[] = [];
  for (const testAbsRaw of opts.testFiles) {
    const testAbs = path.resolve(testAbsRaw).replace(/\\/g, '/');
    let specs: readonly string[] = [];
    const cached = specsCache.get(testAbs);
    if (cached !== undefined) {
      specs = cached;
    } else {
      // eslint-disable-next-line no-await-in-loop
      specs = await extractImportSpecs(testAbs);
      specsCache.set(testAbs, specs);
    }
    let direct = false;
    for (const spec of specs) {
      const resolved = resolveImportWithRoot(testAbs, spec, opts.rootDir, resolutionCache);
      if (resolved && prodSet.has(resolved)) {
        direct = true;
        break;
      }
    }
    if (direct) {
      out.push(testAbs);
    }
  }
  return out;
};

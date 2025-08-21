import * as path from 'node:path';
import * as os from 'node:os';
import * as fsSync from 'node:fs';

import { safeEnv } from './env-utils';
import { runWithStreaming } from './_exec';
import { stripAnsiSimple } from './stacks';
import { formatJestOutputVitest } from './formatJestOutputVitest';
import { renderVitestFromJestJSON, coerceJestJsonToBridge } from './formatter/bridge';
import { makeCtx } from './formatter/context';
import { sortTestResultsWithRank } from './relevance';

export type ProgressEvent = { readonly type: string; readonly text: string };

export type RunProjectContext = {
  readonly jestBin: string;
  readonly perProjectFiltered: ReadonlyMap<string, readonly string[]>;
  readonly executedTestFilesSet: Set<string>;
  readonly selectionPathsAugmented: readonly string[];
  readonly looksLikeTestPath: (candidatePath: string) => boolean;
  readonly repoRootForDiscovery: string;
  readonly namePatternOnlyForDiscovery: boolean;
  readonly sanitizedJestRunArgs: readonly string[];
  readonly collectCoverage: boolean;
  readonly showLogs: boolean;
  readonly onlyFailures: boolean;
  readonly editorCmd?: string;
  readonly fileRank?: ReadonlyMap<string, number>;
  readonly onProgress: (evt: ProgressEvent) => void;
};

const stripFooter = (text: string): string => {
  const lines = text.split('\n');
  const idx = lines.findIndex((ln) => /^Test Files\s/.test(stripAnsiSimple(ln)));
  return idx >= 0 ? lines.slice(0, idx).join('\n').trimEnd() : text;
};

export const runOneProject = async (
  ctx: RunProjectContext,
  cfg: string,
): Promise<{
  readonly code: number;
  readonly pretty: string;
  readonly bridgeJson?: ReturnType<typeof coerceJestJsonToBridge>;
}> => {
  const files = ctx.perProjectFiltered.get(cfg) ?? [];
  if (files.length === 0) {
    console.info(`Project ${path.basename(cfg)}: 0 matching tests after filter; skipping.`);
    return { code: 0, pretty: '' } as const;
  }

  files.forEach((absTestPath) =>
    ctx.executedTestFilesSet.add(path.resolve(absTestPath).replace(/\\/g, '/')),
  );

  const outJson = path.join(
    os.tmpdir(),
    `jest-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  const reporterPath = path.join(os.tmpdir(), 'headlamp', 'reporter.cjs');
  const setupPath = path.join(os.tmpdir(), 'headlamp', 'setup.cjs');

  const findPackageRoot = (startDir: string): string => {
    let dir = path.resolve(startDir);
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const pkg = path.join(dir, 'package.json');
        if (fsSync.existsSync(pkg)) return dir;
      } catch {
        /* ignore */
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return path.resolve(__dirname, '..', '..');
  };

  const packageRoot = findPackageRoot(__dirname);
  const distJestDir = path.resolve(packageRoot, 'dist', 'jest');
  const srcJestDir = path.resolve(packageRoot, 'src', 'jest');
  const assetSetupPathDist = path.join(distJestDir, 'setup.cjs');
  const assetReporterPathDist = path.join(distJestDir, 'reporter.cjs');
  const assetSetupPathSrc = path.join(srcJestDir, 'setup.cjs');
  const assetReporterPathSrc = path.join(srcJestDir, 'reporter.cjs');
  try {
    const haveDist =
      fsSync.existsSync(assetReporterPathDist) && fsSync.existsSync(assetSetupPathDist);
    const useReporterSrc = haveDist ? assetReporterPathDist : assetReporterPathSrc;
    const useSetupSrc = haveDist ? assetSetupPathDist : assetSetupPathSrc;
    if (!fsSync.existsSync(useReporterSrc) || !fsSync.existsSync(useSetupSrc)) {
      throw new Error(
        `Headlamp jest assets not found. Tried:\n  ${assetReporterPathDist}\n  ${assetSetupPathDist}\n  ${assetReporterPathSrc}\n  ${assetSetupPathSrc}\nPlease build the package or ensure src/jest exists.`,
      );
    }
    const needsWrite = (() => {
      try {
        const existing = fsSync.readFileSync(reporterPath, 'utf8');
        const desired = fsSync.readFileSync(useReporterSrc, 'utf8');
        return existing !== desired;
      } catch {
        return true;
      }
    })();
    if (needsWrite) {
      fsSync.mkdirSync(path.dirname(reporterPath), { recursive: true });
      try {
        fsSync.copyFileSync(useReporterSrc, reporterPath);
      } catch {}
    }
    try {
      const outOfDate = (() => {
        try {
          const existingSetup = fsSync.readFileSync(setupPath, 'utf8');
          const desiredSetup = fsSync.readFileSync(useSetupSrc, 'utf8');
          return existingSetup !== desiredSetup;
        } catch {
          return true;
        }
      })();
      if (outOfDate) {
        try {
          fsSync.mkdirSync(path.dirname(setupPath), { recursive: true });
        } catch {}
        fsSync.copyFileSync(useSetupSrc, setupPath);
      }
    } catch {
      try {
        fsSync.mkdirSync(path.dirname(setupPath), { recursive: true });
      } catch {}
      try {
        fsSync.copyFileSync(useSetupSrc, setupPath);
      } catch {}
    }
  } catch (ensureReporterError) {
    console.warn(`Unable to ensure jest bridge reporter: ${String(ensureReporterError)}`);
  }

  const selectedFilesForCoverage = ctx.selectionPathsAugmented
    .filter((pathToken) => /[\\/]/.test(pathToken))
    .filter((pathToken) => !ctx.looksLikeTestPath(pathToken))
    .map((pathToken) => path.relative(ctx.repoRootForDiscovery, pathToken).replace(/\\\\/g, '/'))
    .filter((rel) => rel && !/^\.+\//.test(rel))
    .map((rel) => (rel.startsWith('./') ? rel : `./${rel}`));
  const coverageFromArgs: string[] = [];
  for (const relPath of selectedFilesForCoverage) {
    coverageFromArgs.push('--collectCoverageFrom', relPath);
  }

  const runArgs = [
    ...(cfg && cfg !== '<default>' ? (['--config', cfg] as const) : ([] as const)),
    '--testLocationInResults',
    ...(ctx.namePatternOnlyForDiscovery ? [] : ['--runTestsByPath']),
    `--reporters=${reporterPath}`,
    '--reporters=default',
    '--colors',
    ...ctx.sanitizedJestRunArgs,
    ...(ctx.collectCoverage
      ? [
          '--coverageDirectory',
          path.join('coverage', 'jest', path.basename(cfg).replace(/[^a-zA-Z0-9_.-]+/g, '_')),
        ]
      : []),
    ...coverageFromArgs,
    ...(ctx.showLogs ? ['--no-silent'] : []),
    '--passWithNoTests',
    '--verbose',
    ...(ctx.namePatternOnlyForDiscovery ? [] : files),
  ];

  if (ctx.showLogs) {
    const hasSilentFalse = runArgs.includes('--silent=false');
    console.info(
      `debug: showLogs=${String(ctx.showLogs)} hasSilentFalse=${String(hasSilentFalse)}`,
    );
  }

  let streamBuf = '';
  const baseEnv = safeEnv(process.env, {
    NODE_ENV: 'test',
    JEST_BRIDGE_OUT: outJson,
    JEST_BRIDGE_DEBUG: ctx.showLogs ? '1' : undefined,
    JEST_BRIDGE_DEBUG_PATH: ctx.showLogs
      ? path.resolve(os.tmpdir(), `jest-bridge-debug-${Date.now()}.log`)
      : undefined,
    FORCE_COLOR: '3',
    TERM: process.env.TERM || 'xterm-256color',
  }) as unknown as NodeJS.ProcessEnv;
  const mergedNodeOptions = (() => {
    try {
      const existing = String(process.env.NODE_OPTIONS || '').trim();
      const add = `--require ${setupPath}`;
      return `${existing ? `${existing} ` : ''}${add}`.trim();
    } catch {
      return `--require ${setupPath}`;
    }
  })();
  const envWithSetup = { ...baseEnv, NODE_OPTIONS: mergedNodeOptions } as NodeJS.ProcessEnv;
  const { code, output } = await runWithStreaming(ctx.jestBin, runArgs, {
    env: envWithSetup,
    onChunk: (text: string) => {
      streamBuf += text;
      const lines = streamBuf.split(/\r?\n/);
      streamBuf = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = String(rawLine);
        const idx = line.indexOf('[JEST-BRIDGE-EVENT]');
        if (idx >= 0) {
          const payload = line.slice(idx + '[JEST-BRIDGE-EVENT]'.length).trim();
          try {
            const obj = JSON.parse(payload) as any;
            if (obj && obj.type === 'testStart') {
              const name: string = obj.currentTestName || '';
              const file: string = typeof obj.testPath === 'string' ? obj.testPath : '';
              const short = file ? `${path.basename(file)} > ${name}` : name;
              ctx.onProgress({ type: 'test', text: short || 'start' });
            } else if (obj && obj.type === 'suiteComplete') {
              const base = obj && obj.testPath ? path.basename(obj.testPath) : '';
              const passed = Number(obj.numPassingTests || 0);
              const failed = Number(obj.numFailingTests || 0);
              ctx.onProgress({
                type: 'suite',
                text: `${base} ✓${passed}${failed ? ` ✗${failed}` : ''}`,
              });
            } else if (obj && obj.type === 'envReady') {
              ctx.onProgress({ type: 'env', text: 'environment ready' });
            } else if (obj && obj.type === 'console') {
              ctx.onProgress({ type: 'console', text: String(obj.level || 'log') });
            } else if (obj && obj.type === 'consoleBatch') {
              const n = Array.isArray(obj.entries) ? obj.entries.length : 0;
              ctx.onProgress({ type: 'console', text: `${n} entries` });
            } else if (obj && obj.type === 'httpResponseBatch') {
              const n = Array.isArray(obj.events) ? obj.events.length : 0;
              ctx.onProgress({ type: 'http', text: `${n} events` });
            } else if (
              obj &&
              (obj.type === 'unhandledRejection' || obj.type === 'uncaughtException')
            ) {
              const msg = obj && obj.message ? String(obj.message) : 'error';
              ctx.onProgress({ type: 'error', text: msg.slice(0, 80) });
            }
          } catch {
            /* ignore malformed bridge line */
          }
          continue;
        }
        try {
          const simple = stripAnsiSimple(line);
          if (/^\s*RUNS\s+/.test(simple)) {
            const m = simple.match(/^\s*RUNS\s+(.*)$/);
            const fileText = m ? m[1] : undefined;
            const base = fileText ? path.basename(fileText) : '';
            ctx.onProgress({ type: 'runs', text: base || fileText || '' });
          }
          if (/^\s*(PASS|FAIL)\s+/.test(simple)) {
            const m = simple.match(/^\s*(PASS|FAIL)\s+(.*)$/);
            if (m) {
              ctx.onProgress({ type: m[1] === 'PASS' ? 'pass' : 'fail', text: m[2] });
            } else {
              ctx.onProgress({ type: 'status', text: simple.slice(0, 80) });
            }
          }
        } catch {
          /* ignore progress counting issues */
        }
      }
    },
  });

  let pretty = '';
  let bridgeJson: ReturnType<typeof coerceJestJsonToBridge> | undefined;
  try {
    const jsonText = fsSync.readFileSync(outJson, 'utf8');
    const parsed = JSON.parse(jsonText) as unknown;
    const bridgeBase = coerceJestJsonToBridge(parsed);
    const filteredForNamePattern = (() => {
      if (!ctx.namePatternOnlyForDiscovery) {
        return bridgeBase;
      }
      const keptFiles = bridgeBase.testResults
        .map((file) => ({
          ...file,
          testResults: file.testResults.filter(
            (t) => t.status === 'passed' || t.status === 'failed',
          ),
        }))
        .filter((file) => file.testResults.length > 0);
      const numFailedTests = keptFiles
        .flatMap((f) => f.testResults)
        .filter((t) => t.status === 'failed').length;
      const numPassedTests = keptFiles
        .flatMap((f) => f.testResults)
        .filter((t) => t.status === 'passed').length;
      const numTotalTests = numFailedTests + numPassedTests;
      const numFailedSuites = keptFiles.filter((f) =>
        f.testResults.some((t) => t.status === 'failed'),
      ).length;
      const numPassedSuites = keptFiles.length - numFailedSuites;
      return {
        ...bridgeBase,
        testResults: keptFiles,
        aggregated: {
          ...bridgeBase.aggregated,
          numTotalTestSuites: keptFiles.length,
          numPassedTestSuites: numPassedSuites,
          numFailedTestSuites: numFailedSuites,
          numTotalTests,
          numPassedTests,
          numFailedTests,
          numPendingTests: 0,
          numTodoTests: 0,
          success: numFailedTests === 0,
        },
      } as typeof bridgeBase;
    })();
    const bridge = filteredForNamePattern;
    const reordered = (() => {
      try {
        return {
          ...bridge,
          testResults: sortTestResultsWithRank(ctx.fileRank as any, bridge.testResults).reverse(),
        } as typeof bridge;
      } catch {
        return bridge;
      }
    })();
    bridgeJson = reordered;
    pretty = renderVitestFromJestJSON(
      reordered,
      makeCtx(
        {
          cwd: ctx.repoRootForDiscovery,
          ...(ctx.editorCmd !== undefined ? { editorCmd: ctx.editorCmd } : {}),
        },
        /\bFAIL\b/.test(stripAnsiSimple(output)),
        Boolean(ctx.showLogs),
      ),
      { onlyFailures: ctx.onlyFailures },
    );
  } catch (jsonErr) {
    pretty = formatJestOutputVitest(output, {
      cwd: ctx.repoRootForDiscovery,
      ...(ctx.editorCmd !== undefined ? { editorCmd: ctx.editorCmd } : {}),
      onlyFailures: ctx.onlyFailures,
      showLogs: ctx.showLogs,
    });
  }

  try {
    const looksSparse =
      /\n\s*Error:\s*\n/.test(pretty) && !/(Message:|Thrown:|Events:|Console errors:)/.test(pretty);
    if (looksSparse) {
      const rawText = formatJestOutputVitest(output, {
        cwd: ctx.repoRootForDiscovery,
        ...(ctx.editorCmd !== undefined ? { editorCmd: ctx.editorCmd } : {}),
        onlyFailures: ctx.onlyFailures,
        showLogs: ctx.showLogs,
      });
      pretty = stripFooter(rawText);
    }
  } catch {}

  pretty = stripFooter(pretty);
  return { code: Number(code) || 0, pretty, bridgeJson } as const;
};

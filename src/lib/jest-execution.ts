import * as path from 'node:path';

import { safeEnv } from './env-utils';
import { runText } from './_exec';
import { Colors } from './colors';
import { ansi } from './ansi';
import { barNeutral } from './bars';
import { runParallelStride } from './parallel';
import { computeDirectnessRank } from './relevance';
import { runOneProject } from './run-one-project';
import { coerceJestJsonToBridge } from './formatter/bridge';

export type ExecuteJestRunInputs = {
  readonly jestBin: string;
  readonly projectConfigs: readonly string[];
  readonly perProjectFiltered: ReadonlyMap<string, readonly string[]>;
  readonly selectionHasPaths: boolean;
  readonly selectionLooksLikeTest: boolean;
  readonly selectionIncludesProdPaths: boolean;
  readonly resolvedSelectionTestPaths: readonly string[];
  readonly selectionPathsAugmented: readonly string[];
  readonly changedSelectionAbs: readonly string[];
  readonly repoRootForDiscovery: string;
  readonly jestArgs: readonly string[];
  readonly collectCoverage: boolean;
  readonly showLogs: boolean;
  readonly onlyFailures: boolean;
  readonly editorCmd?: string;
  readonly sequential: boolean;
};

export type ExecuteJestRunResult = {
  readonly exitCode: number;
  readonly allBridgeJson: Array<ReturnType<typeof coerceJestJsonToBridge>>;
  readonly executedTestFiles: ReadonlySet<string>;
};

const stripPathTokensLocal = (
  args: readonly string[],
  selectionPaths: readonly string[],
): readonly string[] => args.filter((token) => !selectionPaths.includes(token));

const resolveRunArgs = (inputs: ExecuteJestRunInputs): readonly string[] => {
  const hasExplicitTests =
    inputs.selectionHasPaths &&
    inputs.selectionLooksLikeTest &&
    (inputs.resolvedSelectionTestPaths?.length ?? 0) > 0;
  if (hasExplicitTests) {
    const base = stripPathTokensLocal(inputs.jestArgs, inputs.selectionPathsAugmented);
    const resolved = (inputs.resolvedSelectionTestPaths ?? []).map((absPath) =>
      path.resolve(absPath).replace(/\\/g, '/'),
    );
    return [...base, ...resolved];
  }
  return inputs.selectionIncludesProdPaths
    ? stripPathTokensLocal(inputs.jestArgs, inputs.selectionPathsAugmented)
    : inputs.jestArgs;
};

export const executeJestRun = async (
  inputs: ExecuteJestRunInputs,
): Promise<ExecuteJestRunResult> => {
  const projectsToRun = inputs.selectionIncludesProdPaths
    ? inputs.projectConfigs
    : inputs.projectConfigs.filter((cfg) => (inputs.perProjectFiltered.get(cfg) ?? []).length > 0);

  const jestRunArgs = resolveRunArgs(inputs).filter(
    (arg) => !/^--coverageDirectory(?:=|$)/.test(String(arg)),
  );

  const prodSeedsForRun = ((): readonly string[] => {
    const changedAbs = (inputs.changedSelectionAbs ?? []).map((absPath) =>
      path.resolve(absPath).replace(/\\/g, '/'),
    );
    const selAbs = (inputs.selectionPathsAugmented as readonly string[]).map((pathToken) =>
      path.resolve(pathToken).replace(/\\/g, '/'),
    );
    return (changedAbs.length ? changedAbs : selAbs).filter(
      (abs) =>
        /[\\/]/.test(abs) &&
        !/(^|\/)(tests?|__tests__)\//i.test(abs) &&
        !/\.(test|spec)\.[tj]sx?$/i.test(abs),
    );
  })();

  const fileRank = await computeDirectnessRank({
    repoRoot: inputs.repoRootForDiscovery,
    productionSeeds: prodSeedsForRun,
  });

  const useTty = Boolean(process.stdout.isTTY);
  const jestArgsForPlan = inputs.selectionIncludesProdPaths
    ? stripPathTokensLocal(inputs.jestArgs, inputs.selectionPathsAugmented)
    : inputs.jestArgs;
  const sanitizedPlanArgs = jestArgsForPlan.filter(
    (arg) => !/^--coverageDirectory(?:=|$)/.test(String(arg)),
  );

  const computePlannedSuites = async (): Promise<number> => {
    const discovered = projectsToRun.reduce(
      (total, cfg) => total + (inputs.perProjectFiltered.get(cfg)?.length ?? 0),
      0,
    );
    if (discovered > 0) {
      return discovered;
    }
    let sum = 0;
    for (const cfg of projectsToRun) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const listed = await runText(
          inputs.jestBin,
          ['--config', cfg, ...sanitizedPlanArgs, '--listTests'],
          {
            env: safeEnv(process.env, {
              NODE_ENV: 'test',
              FORCE_COLOR: '0',
            }) as unknown as NodeJS.ProcessEnv,
          },
        );
        const count = listed
          .split(/\r?\n/)
          .map((ln) => ln.trim())
          .filter(Boolean).length;
        sum += count;
      } catch {
        /* ignore */
      }
    }
    return sum || discovered;
  };

  const totalSuitesPlanned = await computePlannedSuites();
  let suitesDone = 0;
  let currentTestPreview = '';
  let lastEvent = { type: 'init', text: 'waiting for Jest…', at: Date.now() } as {
    type: string;
    text: string;
    at: number;
  };

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
  let spinnerIndex = 0;
  let progressTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;

  const renderProgress = (): void => {
    const pct =
      totalSuitesPlanned > 0
        ? Math.max(0, Math.min(100, Math.floor((suitesDone / totalSuitesPlanned) * 100)))
        : 0;
    const barText = barNeutral(pct, 24);
    const nameText = currentTestPreview ? ` ${ansi.white(currentTestPreview)}` : '';
    const ageSec = Math.max(0, Math.floor((Date.now() - lastEvent.at) / 1000));
    const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
    const shortened = (() => {
      const text = String(lastEvent.text || '');
      return text.length > 36 ? `${text.slice(0, 35)}…` : text;
    })();
    const eventHead = `${ansi.dim('[')}${ansi.gray(spinner)} ${ansi.cyan(lastEvent.type)}${ansi.dim(':')}${ansi.white(
      shortened,
    )}${ansi.dim(` +${ageSec}s]`)}`;
    const line = `${Colors.Run('RUN')} ${eventHead} ${barText} ${String(pct).padStart(
      3,
      ' ',
    )}% ${ansi.dim(`(${suitesDone}/${totalSuitesPlanned})`)}${nameText}`;
    const cols =
      typeof process.stdout.columns === 'number' && process.stdout.columns > 0
        ? process.stdout.columns
        : 120;
    const clipped = line.length > cols ? `${line.slice(0, Math.max(0, cols - 1))}` : line;
    const pad = Math.max(0, cols - clipped.length - 1);
    try {
      process.stdout.write(`\x1b[2K\r${clipped}${' '.repeat(pad)}`);
    } catch {
      process.stdout.write(`\r${clipped}${' '.repeat(pad)}`);
    }
  };

  renderProgress();
  try {
    progressTimer = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
      renderProgress();
    }, 120);
  } catch {
    // ignore timer setup errors
  }
  try {
    heartbeatTimer = setInterval(() => {
      const pct =
        totalSuitesPlanned > 0
          ? Math.max(0, Math.min(100, Math.floor((suitesDone / totalSuitesPlanned) * 100)))
          : 0;
      const ageSec = Math.max(0, Math.floor((Date.now() - lastEvent.at) / 1000));
      const latestLabel = (() => {
        const text = String(lastEvent.text || '');
        return text.length > 60 ? `${text.slice(0, 59)}…` : text;
      })();
      const status = `${Colors.Run('Progress')} ${String(pct).padStart(3, ' ')}% (${suitesDone}/${totalSuitesPlanned}) ${ansi.cyan(
        'Latest',
      )} ${ansi.white(latestLabel)} (${ansi.cyan(lastEvent.type)} +${ageSec}s)`;
      try {
        process.stdout.write(`${status}\n`);
      } catch {
        // ignore write errors
      }
    }, 2000);
  } catch {
    // ignore timer setup errors
  }

  const executedTestFilesSet = new Set<string>();
  let jestExitCode = 0;
  const allBridgeJson: Array<ReturnType<typeof coerceJestJsonToBridge>> = [];

  const stride = inputs.sequential ? 1 : 3;
  await runParallelStride(projectsToRun, stride, async (cfg) => {
    const { code, pretty, bridgeJson } = await runOneProject(
      {
        jestBin: inputs.jestBin,
        perProjectFiltered: inputs.perProjectFiltered,
        executedTestFilesSet,
        selectionPathsAugmented: inputs.selectionPathsAugmented,
        looksLikeTestPath: (candidate) =>
          /\.(test|spec)\.[tj]sx?$/i.test(candidate) ||
          /(^|\/)(tests?|__tests__)\//i.test(candidate),
        repoRootForDiscovery: inputs.repoRootForDiscovery,
        namePatternOnlyForDiscovery: false,
        sanitizedJestRunArgs: jestRunArgs,
        collectCoverage: inputs.collectCoverage,
        showLogs: inputs.showLogs,
        onlyFailures: inputs.onlyFailures,
        editorCmd: inputs.editorCmd,
        fileRank,
        onProgress: (evt) => {
          lastEvent = { type: evt.type, text: evt.text, at: Date.now() };
          renderProgress();
        },
      },
      cfg as string,
    );

    // Collect bridge JSON if available
    if (bridgeJson) {
      allBridgeJson.push(bridgeJson);
    }

    // Update progress tracking
    suitesDone += 1;

    if (useTty) {
      try {
        process.stdout.write('\n');
      } catch {
        // ignore write errors
      }
    }
    if (pretty.trim().length > 0) {
      process.stdout.write(pretty.endsWith('\n') ? pretty : `${pretty}\n`);
    }
    if (code !== 0) {
      jestExitCode = code;
    }
  });

  if (progressTimer) {
    try {
      clearInterval(progressTimer);
    } catch {
      // ignore cleanup errors
    }
    progressTimer = undefined;
  }
  if (heartbeatTimer) {
    try {
      clearInterval(heartbeatTimer);
    } catch {
      // ignore cleanup errors
    }
    heartbeatTimer = undefined;
  }
  try {
    if (useTty) process.stdout.write('\n');
  } catch {
    // ignore write errors
  }

  return {
    exitCode: jestExitCode,
    allBridgeJson,
    executedTestFiles: executedTestFilesSet,
  } as const;
};

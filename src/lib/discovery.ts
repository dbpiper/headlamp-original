/* eslint-disable no-continue */
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";

import { safeEnv } from "./env-utils";
import { runText } from "./_exec";
import { DEFAULT_EXCLUDE } from "./args";
import {
  cachedRelated,
  findRelatedTestsFast,
  DEFAULT_TEST_GLOBS,
} from "./fast-related";
import { selectDirectTestsForProduction } from "./graph-distance";

export async function findRepoRoot(): Promise<string> {
  let workingDirectory = process.cwd();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fs.stat(path.join(workingDirectory, ".git"));
      return workingDirectory;
    } catch {
      const parentDirectory = path.dirname(workingDirectory);
      if (parentDirectory === workingDirectory) {
        return process.cwd();
      }
      workingDirectory = parentDirectory;
    }
  }
}

export const WATCH_FLAGS = new Set(["--watch", "-w", "--watchAll"]);

export const argsForDiscovery = (
  _vitestArgs: readonly string[],
  jestArgs: readonly string[]
) => {
  const COVERAGE_PREFIXES = [
    "--coverage",
    "--coverageReporters",
    "--coverageDirectory",
    "--coverage.reporter",
    "--coverage.reportsDirectory",
  ] as const;
  const strip = (args: readonly string[]) => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const token = args[i]!;
      if (token === "run") {
        continue;
      }
      if (WATCH_FLAGS.has(token)) {
        continue;
      }
      const isCoverage =
        COVERAGE_PREFIXES.some(
          (prefix) => token === prefix || token.startsWith(`${prefix}=`)
        ) ||
        (COVERAGE_PREFIXES.some((prefix) => token === prefix) &&
          i + 1 < args.length &&
          !String(args[i + 1]).startsWith("-"));
      if (isCoverage) {
        if (
          COVERAGE_PREFIXES.some((prefix) => token === prefix) &&
          i + 1 < args.length
        ) {
          i += 1;
        }
        continue;
      }
      out.push(token);
    }
    return out;
  };
  const base = strip(jestArgs);
  const withNoWatchman = base.includes("--no-watchman")
    ? base
    : [...base, "--no-watchman"];
  return { vitest: [], jest: withNoWatchman };
};

export type FilesObject = { readonly files: readonly string[] };
export const isFilesObject = (candidate: unknown): candidate is FilesObject =>
  typeof candidate === "object" && candidate !== null && "files" in candidate;

export async function discoverJest(
  jestArgs: readonly string[],
  opts?: {
    readonly relatedPaths?: readonly string[];
    readonly patterns?: readonly string[];
    readonly cwd?: string;
  }
): Promise<string[]> {
  const hasRelated = Boolean(
    opts?.relatedPaths && opts.relatedPaths.length > 0
  );
  const hasPatterns = Boolean(opts?.patterns && opts.patterns.length > 0);
  // Always include --listTests so stdout is a file list, even when using --findRelatedTests
  const listArgs = [
    ...jestArgs,
    "--listTests",
    ...(hasRelated ? (["--findRelatedTests"] as const) : ([] as const)),
    ...(hasRelated
      ? (opts!.relatedPaths as readonly string[]) ?? []
      : ([] as const)),
    ...(hasPatterns
      ? (opts!.patterns as readonly string[]) ?? []
      : ([] as const)),
  ];
  const babelNodeBin = "./node_modules/.bin/babel-node";
  const jestBin = "./node_modules/.bin/jest";
  const raw = await runText(
    babelNodeBin,
    ["--extensions", ".js,.ts", jestBin, ...listArgs],
    {
      cwd: opts?.cwd ?? process.cwd(),
      env: safeEnv(process.env, {
        CI: "1",
        NODE_ENV: "test",
      }) as unknown as NodeJS.ProcessEnv,
      timeoutMs: 20000,
    }
  );
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export const discoverJestResilient = async (
  jestArgs: readonly string[],
  opts?: { readonly relatedPaths?: readonly string[]; readonly cwd?: string }
): Promise<readonly string[]> => {
  try {
    return await discoverJest(jestArgs, opts);
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (!msg.includes("timed out")) {
      throw err;
    }
    const repoRoot = opts?.cwd ?? (await findRepoRoot());
    const related = opts?.relatedPaths ?? [];
    if (related.length === 0) {
      console.warn(
        "Jest list timed out and no related production paths were provided; falling back to empty Jest set."
      );
      return [] as string[];
    }
    console.warn(
      `Jest list timed out; falling back to ripgrep-based related test discovery for ${related.length} prod path(s).`
    );
    const selectionKey = related
      .map((abs) => path.relative(repoRoot, abs).replace(/\\/g, "/"))
      .sort()
      .join("|");
    const rgMatches = await cachedRelated({
      repoRoot,
      selectionKey,
      compute: () =>
        findRelatedTestsFast({
          repoRoot,
          productionPaths: related,
          testGlobs: DEFAULT_TEST_GLOBS,
          excludeGlobs: DEFAULT_EXCLUDE,
          timeoutMs: 1500,
        }),
    });
    const toAbsolutePosix = (candidatePath: string) => {
      const isAbs = path.isAbsolute(candidatePath);
      const absJoined = isAbs
        ? candidatePath
        : path.join(repoRoot, candidatePath);
      return absJoined.replace(/\\/g, "/");
    };
    const jestCandidates = rgMatches
      .filter((candidatePath) => !/\.d\.ts$/.test(candidatePath))
      .map(toAbsolutePosix);
    if (jestCandidates.length === 0) {
      console.info("Fallback produced 0 Jest candidates.");
    } else {
      console.info(
        `Fallback produced ${jestCandidates.length} Jest candidate(s).`
      );
    }
    return jestCandidates as readonly string[];
  }
};

export const discoverTargets = async (
  _vitestArgs: readonly string[],
  jestArgs: readonly string[],
  opts?: { readonly relatedPaths?: readonly string[]; readonly cwd?: string }
): Promise<{
  readonly vitestFiles: readonly string[];
  readonly jestFiles: readonly string[];
}> => {
  const related = opts?.relatedPaths ?? [];
  const cwd = opts?.cwd;
  // If production paths were provided, select tests that directly import them (Group 1)
  if (related.length > 0) {
    const repoRoot = cwd ?? (await findRepoRoot());
    // List all jest tests under config
    let allTests: readonly string[] = [];
    try {
      allTests = await discoverJest(jestArgs, { cwd: repoRoot });
    } catch {
      allTests = [];
    }
    if (allTests.length > 0) {
      const direct = await selectDirectTestsForProduction({
        rootDir: repoRoot,
        testFiles: allTests,
        productionFiles: related,
      });
      console.debug(
        `Direct-related jest tests: ${direct.length} (from ${allTests.length} total)`
      );
      return { vitestFiles: [] as string[], jestFiles: direct };
    }
  }
  const jestOpts = {
    relatedPaths: related,
    ...(cwd !== undefined ? { cwd } : {}),
  } as const;
  const [jestFiles] = await Promise.all([
    discoverJestResilient(jestArgs, jestOpts),
  ]);
  console.debug(`Discovery → jest: ${jestFiles.length}`);
  return { vitestFiles: [] as string[], jestFiles };
};

export const filterCandidatesForProject = async (
  cfgPath: string,
  jestArgs: readonly string[],
  candidates: readonly string[],
  cwd: string
): Promise<readonly string[]> => {
  if (candidates.length === 0) {
    return [] as const;
  }
  // Use --listTests with relative file patterns only; avoid --findRelatedTests here
  const toPosixNormalized = (inputPath: string) =>
    inputPath.replace(/\\/g, "/");
  const relativePatterns = candidates
    .map((absOrRel) =>
      path.isAbsolute(absOrRel) ? path.relative(cwd, absOrRel) : absOrRel
    )
    .map(toPosixNormalized);

  console.log("relativePatterns:", relativePatterns);
  let attemptPatterns: string[] = [];
  try {
    attemptPatterns = await discoverJest([...jestArgs, "--config", cfgPath], {
      patterns: relativePatterns,
      cwd,
    });
  } catch {
    attemptPatterns = [];
  }
  const normalizedAttemptPatterns = attemptPatterns.map((candidatePath) =>
    toPosixNormalized(candidatePath)
  );
  if (normalizedAttemptPatterns.length > 0) {
    return normalizedAttemptPatterns as readonly string[];
  }
  // Fallback: if Jest couldn't list,
  // pass the relative patterns as absolute paths for '--runTestsByPath'
  const absoluteFromRelative = relativePatterns.map((rel) =>
    toPosixNormalized(path.join(cwd, rel))
  );
  return absoluteFromRelative as readonly string[];
};

export const decideShouldRunJest = (
  vitestFiles: readonly string[],
  jestFiles: readonly string[],
  opts: {
    readonly selectionSpecified: boolean;
    readonly selectionPaths: readonly string[];
  }
) => {
  const MAX_JEST_FILES = 200;
  const total = vitestFiles.length + jestFiles.length;
  const share = total > 0 ? jestFiles.length / total : 0;
  const looksLikeTestPath = (pathText: string) =>
    /\.(test|spec)\.[tj]sx?$/i.test(pathText) ||
    /(^|\/)tests?\//i.test(pathText);
  const looksLikePath = (pathText: string) =>
    /[\\/]/.test(pathText) || /\.(m?[tj]sx?)$/i.test(pathText);
  const anyTestSelected = (opts.selectionPaths ?? []).some(looksLikeTestPath);
  const anyPathSelected = (opts.selectionPaths ?? []).some(looksLikePath);
  if (!opts.selectionSpecified) {
    return { shouldRunJest: false, share, reason: "broad_run_guard" } as const;
  }
  if (jestFiles.length === 0) {
    return { shouldRunJest: false, share, reason: "no_jest_tests" } as const;
  }
  if (vitestFiles.length === 0) {
    return jestFiles.length > MAX_JEST_FILES
      ? ({
          shouldRunJest: false,
          share: 1,
          reason: "full_suite_guard",
        } as const)
      : ({ shouldRunJest: true, share: 1, reason: "only_jest" } as const);
  }
  const threshold = anyTestSelected ? 0.7 : 0.8;
  if (jestFiles.length > MAX_JEST_FILES) {
    return { shouldRunJest: false, share, reason: "full_suite_guard" } as const;
  }
  if (!anyPathSelected) {
    return share >= 0.85
      ? ({ shouldRunJest: true, share, reason: "meets_threshold" } as const)
      : ({ shouldRunJest: false, share, reason: "below_threshold" } as const);
  }
  return share >= threshold
    ? ({ shouldRunJest: true, share, reason: "meets_threshold" } as const)
    : ({ shouldRunJest: false, share, reason: "below_threshold" } as const);
};

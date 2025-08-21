import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';

import { DEFAULT_EXCLUDE } from './args';
import { cachedRelated, findRelatedTestsFast, DEFAULT_TEST_GLOBS } from './fast-related';
import { discoverJestResilient, filterCandidatesForProject, findRepoRoot } from './discovery';

const toPosix = (p: string) => p.replace(/\\/g, '/');

const computeSelectionKey = (repoRoot: string, prodSelections: readonly string[]) =>
  prodSelections
    .map((absPath) => path.relative(repoRoot, absPath))
    .map(toPosix)
    .sort((a, b) => a.localeCompare(b))
    .join('|');

const rgRelatedCandidates = async (opts: {
  readonly repoRoot: string;
  readonly prodSelections: readonly string[];
}): Promise<readonly string[]> => {
  const selectionKey = computeSelectionKey(opts.repoRoot, opts.prodSelections);
  const matched = await cachedRelated({
    repoRoot: opts.repoRoot,
    selectionKey,
    compute: () =>
      findRelatedTestsFast({
        repoRoot: opts.repoRoot,
        productionPaths: opts.prodSelections,
        testGlobs: DEFAULT_TEST_GLOBS,
        excludeGlobs: DEFAULT_EXCLUDE,
        timeoutMs: 1500,
      }),
  });
  return matched.map(toPosix);
};

const refineOwnedCandidates = async (opts: {
  readonly projectConfigs: readonly string[];
  readonly jestDiscoveryArgs: readonly string[];
  readonly candidates: readonly string[];
}): Promise<ReadonlyMap<string, readonly string[]>> => {
  const out = new Map<string, readonly string[]>();
  for (const cfg of opts.projectConfigs) {
    // eslint-disable-next-line no-await-in-loop
    const owned = await filterCandidatesForProject(
      cfg,
      opts.jestDiscoveryArgs,
      opts.candidates,
      path.dirname(cfg),
    );
    out.set(cfg, owned);
  }
  return out;
};

const fileBody = (absPath: string): string => {
  try {
    return fsSync.readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
};

const resolveLocalImport = (fromFile: string, spec: string): string | undefined => {
  const baseDir = path.dirname(fromFile);
  const cand = path.resolve(baseDir, spec);
  const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  for (const ext of exts) {
    const full = ext ? `${cand}${ext}` : cand;
    if (fsSync.existsSync(full)) {
      return full;
    }
  }
  for (const ext of exts) {
    const full = path.join(cand, `index${ext}`);
    if (fsSync.existsSync(full)) {
      return full;
    }
  }
  return undefined;
};

const importSpecs = (body: string): string[] => {
  const out: string[] = [];
  const importRe = /import\s+[^'"\n]*from\s+['"]([^'"]+)['"];?/g;
  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const dynamicImportRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let importMatch: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((importMatch = importRe.exec(body))) {
    out.push(importMatch[1]!);
  }
  // eslint-disable-next-line no-cond-assign
  let requireMatch: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((requireMatch = requireRe.exec(body))) {
    out.push(requireMatch[1]!);
  }
  // eslint-disable-next-line no-cond-assign
  let dynMatch: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((dynMatch = dynamicImportRe.exec(body))) {
    out.push(dynMatch[1]!);
  }
  return out;
};

const contentScanFilterCandidates = (opts: {
  readonly repoRootForDiscovery: string;
  readonly prodSelections: readonly string[];
  readonly rgCandidates: readonly string[];
}): readonly string[] => {
  const toSeeds = (abs: string) => {
    const rel = path.relative(opts.repoRootForDiscovery, abs);
    const posix = toPosix(rel);
    const withoutExt = posix.replace(/\.(m?[tj]sx?)$/i, '');
    const base = path.basename(withoutExt);
    const segs = withoutExt.split('/');
    const tail2 = segs.slice(-2).join('/');
    return Array.from(new Set([withoutExt, base, tail2].filter(Boolean)));
  };
  const seeds = Array.from(new Set(opts.prodSelections.flatMap(toSeeds)));
  const includesSeed = (text: string) => seeds.some((seed) => text.includes(seed));

  const kept: string[] = [];
  for (const cand of opts.rgCandidates) {
    const body = fileBody(cand);
    if (includesSeed(body)) {
      kept.push(cand);
      continue;
    }
    const specs = importSpecs(body).filter((sp) => sp.startsWith('.') || sp.startsWith('/'));
    let keep = false;
    for (const spec of specs) {
      const target = resolveLocalImport(cand, spec);
      if (!target) {
        continue;
      }
      const tb = fileBody(target);
      if (includesSeed(tb)) {
        keep = true;
        break;
      }
    }
    if (keep) {
      kept.push(cand);
    }
  }
  return kept;
};

const narrowForExplicitSelection = (
  effective: readonly string[],
  rgSet: ReadonlySet<string>,
): readonly string[] => {
  const narrowed = effective.filter((candidate) => rgSet.has(toPosix(candidate)));
  return narrowed.length > 0 ? narrowed : effective;
};

const fallbackExpandIfEmpty = async (opts: {
  readonly effectiveJestFiles: readonly string[];
  readonly jestFiles: readonly string[];
  readonly projectConfigs: readonly string[];
  readonly jestDiscoveryArgs: readonly string[];
  readonly prodSelections: readonly string[];
  readonly repoRootForRefinement: string;
}): Promise<readonly string[]> => {
  if (opts.effectiveJestFiles.length !== 0) {
    return opts.effectiveJestFiles;
  }
  let jestFiles = opts.jestFiles.slice();
  const repoRoot = opts.repoRootForRefinement;
  if (jestFiles.length === 0) {
    try {
      const allAcross: string[] = [];
      for (const cfg of opts.projectConfigs) {
        const cfgCwd = path.dirname(cfg);
        // eslint-disable-next-line no-await-in-loop
        const listed = await discoverJestResilient([...opts.jestDiscoveryArgs, '--config', cfg], {
          cwd: cfgCwd,
        });
        allAcross.push(...listed);
      }
      const uniqAll = Array.from(new Set(allAcross.map(toPosix)));
      if (uniqAll.length > 0) {
        jestFiles = uniqAll;
      }
    } catch {
      /* ignore */
    }
  }

  const seeds = opts.prodSelections
    .map((abs) => toPosix(path.relative(repoRoot, abs)).replace(/\.(m?[tj]sx?)$/i, ''))
    .flatMap((rel) => {
      const base = path.basename(rel);
      const segments = rel.split('/');
      return Array.from(new Set([rel, base, segments.slice(-2).join('/')].filter(Boolean)));
    });
  const includesSeed = (text: string) => seeds.some((seed) => text.includes(seed));

  const tryReadFile = async (absPath: string): Promise<string> => {
    try {
      return await fs.readFile(absPath, 'utf8');
    } catch {
      return '';
    }
  };

  const resolveSpec = (fromFile: string, spec: string): string | undefined => {
    const isLocal = spec.startsWith('.') || spec.startsWith('/');
    return isLocal ? resolveLocalImport(fromFile, spec) : undefined;
  };

  const importOrExportSpecs = (body: string): string[] => {
    const results: string[] = [];
    const importRegex = /import\s+[^'"\n]*from\s+['"]([^'"]+)['"];?/g;
    const requireRegex = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    const exportFromRegex = /export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"];?/g;
    const dynamicImportRegex = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((match = importRegex.exec(body))) {
      results.push(match[1]!);
    }
    // eslint-disable-next-line no-cond-assign
    while ((match = requireRegex.exec(body))) {
      results.push(match[1]!);
    }
    // eslint-disable-next-line no-cond-assign
    while ((match = exportFromRegex.exec(body))) {
      results.push(match[1]!);
    }
    // eslint-disable-next-line no-cond-assign
    while ((match = dynamicImportRegex.exec(body))) {
      results.push(match[1]!);
    }
    return results;
  };

  const union = Array.from(new Set<string>(jestFiles));
  const keep = new Set<string>();
  const visitedBodyCache = new Map<string, string>();
  const specCache = new Map<string, readonly string[]>();
  const resolutionCache = new Map<string, string | undefined>();

  const getBody = async (absPath: string): Promise<string> => {
    const existing = visitedBodyCache.get(absPath);
    if (existing !== undefined) {
      return existing;
    }
    const content = await tryReadFile(absPath);
    visitedBodyCache.set(absPath, content);
    return content;
  };

  const getSpecs = async (absPath: string): Promise<readonly string[]> => {
    const cached = specCache.get(absPath);
    if (cached !== undefined) {
      return cached;
    }
    const body = await getBody(absPath);
    const specs = importOrExportSpecs(body);
    specCache.set(absPath, specs);
    return specs;
  };

  const resolveSpecMemo = (fromFile: string, spec: string): string | undefined => {
    const key = `${fromFile}|${spec}`;
    if (resolutionCache.has(key)) {
      return resolutionCache.get(key);
    }
    const resolved = resolveSpec(fromFile, spec);
    resolutionCache.set(key, resolved);
    return resolved;
  };

  const MAX_DEPTH = 5;
  const seen = new Set<string>();
  const matchesTransitively = async (absTestPath: string, depth: number): Promise<boolean> => {
    if (depth > MAX_DEPTH) {
      return false;
    }
    const cacheKey = `${absTestPath}@${depth}`;
    if (seen.has(cacheKey)) {
      return false;
    }
    seen.add(cacheKey);
    const body = await getBody(absTestPath);
    if (includesSeed(body)) {
      return true;
    }
    const specs = await getSpecs(absTestPath);
    for (const spec of specs) {
      const target = resolveSpecMemo(absTestPath, spec);
      if (!target) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const targetBody = await getBody(target);
      if (includesSeed(targetBody)) {
        return true;
      }
      // eslint-disable-next-line no-await-in-loop
      if (await matchesTransitively(target, depth + 1)) {
        return true;
      }
    }
    return false;
  };

  const concurrency = 16;
  let scanIndex = 0;
  const workers: Promise<void>[] = [];
  for (let workerIndex = 0; workerIndex < concurrency; workerIndex += 1) {
    workers.push(
      // eslint-disable-next-line no-loop-func
      (async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const currentIndex = scanIndex;
          if (currentIndex >= union.length) {
            break;
          }
          scanIndex += 1;
          const candidate = union[currentIndex]!;
          // eslint-disable-next-line no-await-in-loop
          const ok = await matchesTransitively(candidate, 0);
          if (ok) {
            keep.add(candidate);
          }
        }
      })(),
    );
  }
  await Promise.all(workers);

  const jestKept = jestFiles
    .filter((candidate) => keep.has(candidate))
    .sort((left, right) => left.localeCompare(right));
  return jestKept.length ? jestKept : opts.effectiveJestFiles;
};

export const refineJestSelection = async (inputs: {
  readonly selectionHasPaths: boolean;
  readonly selectionLooksLikeTest: boolean;
  readonly selectionIncludesProdPaths: boolean;
  readonly prodSelections: readonly string[];
  readonly projectConfigs: readonly string[];
  readonly jestDiscoveryArgs: readonly string[];
  readonly perProjectFiltered: ReadonlyMap<string, readonly string[]>;
  readonly jestFiles: readonly string[];
  readonly effectiveJestFiles: readonly string[];
  readonly repoRootForDiscovery: string;
  readonly workspaceRoot?: string;
}): Promise<{
  readonly jestFiles: readonly string[];
  readonly effectiveJestFiles: readonly string[];
  readonly perProjectFiltered: ReadonlyMap<string, readonly string[]>;
}> => {
  const {
    selectionHasPaths,
    selectionLooksLikeTest,
    selectionIncludesProdPaths,
    prodSelections,
    projectConfigs,
    jestDiscoveryArgs,
    perProjectFiltered,
    jestFiles,
    effectiveJestFiles,
    repoRootForDiscovery,
    workspaceRoot,
  } = inputs;

  // If the user explicitly selected test files, never override or narrow that
  // selection based on related production paths. This preserves explicit intent
  // even when --changed (or similar) adds production files into the selection.
  const explicitTestSelection = selectionHasPaths && selectionLooksLikeTest;
  if (explicitTestSelection) {
    return {
      jestFiles: jestFiles.slice(),
      effectiveJestFiles: effectiveJestFiles.slice(),
      perProjectFiltered: new Map(perProjectFiltered),
    } as const;
  }

  // If upstream discovery already found owned Jest files (e.g., via direct import graph),
  // keep them. Refinement is primarily a fallback when discovery produced none.
  if (jestFiles.length > 0) {
    return {
      jestFiles: jestFiles.slice(),
      effectiveJestFiles: effectiveJestFiles.slice(),
      perProjectFiltered: new Map(perProjectFiltered),
    } as const;
  }

  if (!(selectionHasPaths && prodSelections.length > 0)) {
    return {
      jestFiles: jestFiles.slice(),
      effectiveJestFiles: effectiveJestFiles.slice(),
      perProjectFiltered: new Map(perProjectFiltered),
    } as const;
  }

  console.info(`rg related → prodSelections=${prodSelections.length} (starting)`);
  const repoRootForRefinement = workspaceRoot ?? (await findRepoRoot());
  const rgMatches = await rgRelatedCandidates({
    repoRoot: repoRootForRefinement,
    prodSelections,
  });
  console.info(`rg candidates → count=${rgMatches.length}`);
  console.info('rg candidates →');
  rgMatches.forEach((candidatePath) => console.info(` - ${candidatePath}`));

  const rgSet = new Set(rgMatches.map(toPosix));

  if (rgSet.size > 0) {
    if (selectionIncludesProdPaths && !explicitTestSelection) {
      const perProjectFromRg = await refineOwnedCandidates({
        projectConfigs,
        jestDiscoveryArgs,
        candidates: Array.from(rgSet),
      });
      let totalOwned = Array.from(perProjectFromRg.values()).flat().length;
      if (totalOwned > 0) {
        const updatedMap = new Map<string, readonly string[]>();
        for (const [cfg, owned] of perProjectFromRg.entries()) {
          updatedMap.set(cfg, owned);
        }
        const nextJestFiles = Array.from(updatedMap.values()).flat();
        return {
          jestFiles: nextJestFiles,
          effectiveJestFiles: nextJestFiles.slice(),
          perProjectFiltered: updatedMap,
        } as const;
      }

      const keptCandidates = contentScanFilterCandidates({
        repoRootForDiscovery,
        prodSelections,
        rgCandidates: Array.from(rgSet),
      });
      if (keptCandidates.length > 0) {
        const perProjectFromScan = await refineOwnedCandidates({
          projectConfigs,
          jestDiscoveryArgs,
          candidates: keptCandidates,
        });
        totalOwned = Array.from(perProjectFromScan.values()).flat().length;
        if (totalOwned > 0) {
          const updatedMap = new Map<string, readonly string[]>();
          for (const [cfg, owned] of perProjectFromScan.entries()) {
            updatedMap.set(cfg, owned);
          }
          const nextJestFiles = Array.from(updatedMap.values()).flat();
          return {
            jestFiles: nextJestFiles,
            effectiveJestFiles: nextJestFiles.slice(),
            perProjectFiltered: updatedMap,
          } as const;
        }
      }
      // Still zero: fall through to fallback
    } else {
      const narrowed = narrowForExplicitSelection(effectiveJestFiles, rgSet);
      if (narrowed !== effectiveJestFiles) {
        return {
          jestFiles: jestFiles.slice(),
          effectiveJestFiles: narrowed.slice(),
          perProjectFiltered: new Map(perProjectFiltered),
        } as const;
      }
    }
  }

  const afterFallback = await fallbackExpandIfEmpty({
    effectiveJestFiles,
    jestFiles,
    projectConfigs,
    jestDiscoveryArgs,
    prodSelections,
    repoRootForRefinement,
  });
  console.info(`fallback refine (transitive) → jest=${afterFallback.length}`);
  return {
    jestFiles: jestFiles.slice(),
    effectiveJestFiles: afterFallback.slice(),
    perProjectFiltered: new Map(perProjectFiltered),
  } as const;
};

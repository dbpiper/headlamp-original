import * as path from 'node:path';

import { getChangeStats } from './git-utils';

export const isConfigLike = (repoRoot: string, absPath: string): boolean => {
  const rel = path.relative(repoRoot, absPath).replace(/\\/g, '/');
  if (rel.startsWith('config/')) return true;
  const base = path.basename(rel).toLowerCase();
  if (/\.config\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/^(jest|babel|vitest|vite|webpack|rollup|eslintrc|tsconfig|prettier)\b/.test(base)) {
    return true;
  }
  return false;
};

export const computeChangeWeights = async (
  repoRoot: string,
  changedAbs: readonly string[],
): Promise<Map<string, number>> => {
  const weights = new Map<string, number>();
  if (!changedAbs.length) return weights;
  const rels = changedAbs
    .map((abs) => path.relative(repoRoot, abs).replace(/\\/g, '/'))
    .filter((rel) => rel && !rel.startsWith('./'));
  try {
    const lines = await getChangeStats(rels, { cwd: repoRoot });
    lines
      .map((ln) => ln.trim())
      .filter(Boolean)
      .forEach((line) => {
        const parts = line.split(/\s+/);
        if (parts.length >= 3) {
          const addedRaw = Number(parts[0] ?? '0');
          const deletedRaw = Number(parts[1] ?? '0');
          const fileRel = parts.slice(2).join(' ');
          const fileAbs = path.resolve(repoRoot, fileRel).replace(/\\/g, '/');
          const addedCount = Number.isFinite(addedRaw) ? addedRaw : 0;
          const deletedCount = Number.isFinite(deletedRaw) ? deletedRaw : 0;
          const score = addedCount + deletedCount;
          const previousScore = weights.get(fileAbs) ?? 0;
          weights.set(fileAbs, Math.max(previousScore, score));
        }
      });
  } catch {
    // ignore
  }
  return weights;
};

export const reorderBySelectionChangeAndConfig = (
  repoRoot: string,
  files: ReadonlyArray<string>,
  selectionAbs: ReadonlyArray<string>,
  changedAbs: ReadonlyArray<string>,
  weights: ReadonlyMap<string, number>,
): string[] => {
  const selectionSet = new Set(selectionAbs);
  const changedSet = new Set(changedAbs);
  const byWeightDesc = (leftPath: string, rightPath: string) =>
    (weights.get(rightPath) ?? 0) - (weights.get(leftPath) ?? 0);

  const selected = files.filter((filePath) => selectionSet.has(filePath)).sort(byWeightDesc);
  const selectedNonCfg = selected.filter((filePath) => !isConfigLike(repoRoot, filePath));
  const selectedCfg = selected.filter((filePath) => isConfigLike(repoRoot, filePath));

  const restAfterSel = files.filter((filePath) => !selectionSet.has(filePath));
  const changedOnly = restAfterSel
    .filter((filePath) => changedSet.has(filePath))
    .sort(byWeightDesc);
  const nonChanged = restAfterSel.filter((filePath) => !changedSet.has(filePath));
  const nonCfg = nonChanged.filter((filePath) => !isConfigLike(repoRoot, filePath));
  const cfg = nonChanged.filter((filePath) => isConfigLike(repoRoot, filePath));
  return [...cfg, ...selectedCfg, ...nonCfg, ...changedOnly, ...selectedNonCfg];
};

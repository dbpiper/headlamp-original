import * as path from 'node:path';
import * as fsSync from 'node:fs';

import { safeEnv } from './env-utils';
import { runText } from './_exec';
import { resolveImportWithRoot } from './path-resolver';
import { ansi } from './ansi';
import { tintPct } from './bars';
import { barCell, ColumnSpec, Cell, cell, renderTable } from './table';
import { preferredEditorHref, linkifyPadded } from './paths';
import { computeDirectnessRank, sortPathsWithRank } from './relevance';
import {
  compositeBarPct,
  computeUncoveredBlocks,
  missedBranches,
  missedFunctions,
} from './coverage-core';
import { resolveProdSelectionTokens } from './selection-resolver';
import {
  isConfigLike as isConfigLikeHelper,
  computeChangeWeights,
  reorderBySelectionChangeAndConfig,
} from './coverage-order-helpers';

export const printDetailedCoverage = async (opts: {
  readonly map: import('istanbul-lib-coverage').CoverageMap;
  readonly root: string;
  readonly limitPerFile: number | 'all';
  readonly showCode: boolean;
  readonly editorCmd?: string;
  readonly selectionPaths?: readonly string[];
  readonly changedFiles?: readonly string[];
}): Promise<void> => {
  const selectionAbs = (opts.selectionPaths ?? []).map((p) => path.resolve(p).replace(/\\/g, '/'));
  const changedAbs = (opts.changedFiles ?? []).map((p) => path.resolve(p).replace(/\\/g, '/'));
  const weights = await computeChangeWeights(opts.root, changedAbs);
  const baseFiles = opts.map
    .files()
    .map((f) => path.resolve(f).replace(/\\/g, '/'))
    .filter((abs) => !isTestLikePath(abs) && !isConfigLikeHelper(opts.root, abs));
  const files = reorderBySelectionChangeAndConfig(
    opts.root,
    baseFiles,
    selectionAbs,
    changedAbs,
    weights,
  );
  for (const abs of files) {
    const fc = opts.map.fileCoverageFor(abs);
    const sum = fc.toSummary();
    const rel = path.relative(opts.root, abs).replace(/\\/g, '/');
    const blocks = computeUncoveredBlocks(fc);
    const misses = missedBranches(fc);
    const missFns = missedFunctions(fc);
    const linesPctText = `${sum.lines.pct.toFixed(1)}%`;
    const funcsPctText = `${sum.functions.pct.toFixed(1)}%`;
    const branchesPctText = `${sum.branches.pct.toFixed(1)}%`;
    const header = `${ansi.bold(rel)}  lines ${tintPct(sum.lines.pct)(
      linesPctText,
    )} ${barCell(compositeBarPct(sum, blocks))(''.padEnd(14))}  funcs ${tintPct(sum.functions.pct)(
      funcsPctText,
    )}  branches ${tintPct(sum.branches.pct)(branchesPctText)}`;
    console.info(header);
    const max = opts.limitPerFile === 'all' ? Number.POSITIVE_INFINITY : (opts.limitPerFile ?? 5);
    const compareRangesByLengthDescThenStart = (
      firstRange: { readonly start: number; readonly end: number },
      secondRange: { readonly start: number; readonly end: number },
    ): number => {
      const secondLength = secondRange.end - secondRange.start;
      const firstLength = firstRange.end - firstRange.start;
      return secondLength - firstLength || firstRange.start - secondRange.start;
    };
    const topBlocks = blocks.slice().sort(compareRangesByLengthDescThenStart).slice(0, max);
    if (topBlocks.length === 0 && misses.length === 0 && missFns.length === 0) {
      console.info(ansi.dim('  No uncovered hotspots.'));
      console.info('');
      // eslint-disable-next-line no-continue
      continue;
    }
    let src = '';
    if (opts.showCode && topBlocks.length > 0) {
      try {
        src = fsSync.readFileSync(abs, 'utf8');
      } catch {
        src = '';
      }
    }
    for (const block of topBlocks) {
      const link = `\u001B]8;;${preferredEditorHref(
        abs,
        block.start,
        opts.editorCmd,
      )}\u0007${path.basename(abs)}:${block.start}\u001B]8;;\u0007`;
      const label = `  ${ansi.yellow(`L${block.start}`)}–${ansi.yellow(`L${block.end}`)}  ${link}`;
      console.info(label);
      if (opts.showCode && src.length) {
        const lines = src.split(/\r?\n/);
        const from = Math.max(1, block.start - 3);
        const to = Math.min(lines.length, block.end + 3);
        for (let ln = from; ln <= to; ln += 1) {
          const body = lines[ln - 1] ?? '';
          const tag =
            ln >= block.start && ln <= block.end
              ? ansi.red(`>${ln.toString().padStart(4)}|`)
              : ansi.dim(` ${ln.toString().padStart(4)}|`);
          console.info(`${tag} ${body}`);
        }
      }
    }
    if (missFns.length) {
      console.info(ansi.bold('  Uncovered functions:'));
      for (const fn of missFns) {
        const link = `\u001B]8;;${preferredEditorHref(
          abs,
          fn.line,
          opts.editorCmd,
        )}\u0007${path.basename(abs)}:${fn.line}\u001B]8;;\u0007`;
        console.info(`    - ${fn.name} @ ${link}`);
      }
    }
    if (misses.length) {
      console.info(ansi.bold('  Branch paths with zero hits:'));
      for (const br of misses) {
        const link = `\u001B]8;;${preferredEditorHref(
          abs,
          br.line,
          opts.editorCmd,
        )}\u0007${path.basename(abs)}:${br.line}\u001B]8;;\u0007`;
        console.info(`    - branch#${br.id} @ ${link}  missed paths: [${br.zeroPaths.join(', ')}]`);
      }
    }
    console.info('');
  }
};

export const printCompactCoverage = async (opts: {
  readonly map: import('istanbul-lib-coverage').CoverageMap;
  readonly root: string;
  readonly maxFiles?: number;
  readonly maxHotspots?: number;
  readonly pageFit?: boolean;
  readonly editorCmd?: string;
}): Promise<void> => {
  const terminalRows =
    typeof process.stdout.rows === 'number' && process.stdout.rows > 10 ? process.stdout.rows : 40;
  const reservedRows = 8;
  const availableRows = Math.max(10, terminalRows - reservedRows);
  const maxHotspotsDerived = opts.pageFit
    ? Math.max(3, Math.floor(availableRows * 0.5))
    : (opts.maxHotspots ?? 8);
  const maxFunctionsDerived = opts.pageFit ? Math.max(2, Math.floor(availableRows * 0.25)) : 6;
  const maxBranchesDerived = opts.pageFit
    ? Math.max(2, availableRows - maxHotspotsDerived - maxFunctionsDerived)
    : 6;
  const files = opts.map
    .files()
    .map((f) => path.resolve(f).replace(/\\/g, '/'))
    .filter((abs) => !isConfigLikeHelper(opts.root, abs))
    .sort(
      (fileA, fileB) =>
        opts.map.fileCoverageFor(fileA).toSummary().lines.pct -
        opts.map.fileCoverageFor(fileB).toSummary().lines.pct,
    );
  const fileCap = opts.maxFiles ?? files.length;
  for (const abs of files.slice(0, fileCap)) {
    const fc = opts.map.fileCoverageFor(abs);
    const sum = fc.toSummary();
    const rel = path.relative(opts.root, abs).replace(/\\/g, '/');
    const compareRangesByLengthDescThenStart = (
      firstRange: { readonly start: number; readonly end: number },
      secondRange: { readonly start: number; readonly end: number },
    ): number => {
      const secondLength = secondRange.end - secondRange.start;
      const firstLength = firstRange.end - firstRange.start;
      return secondLength - firstLength || firstRange.start - secondRange.start;
    };
    const blocks = computeUncoveredBlocks(fc).slice().sort(compareRangesByLengthDescThenStart);
    const missFns = missedFunctions(fc);
    const misses = missedBranches(fc);
    const linesPctText = `${sum.lines.pct.toFixed(1)}%`;
    const funcsPctText = `${sum.functions.pct.toFixed(1)}%`;
    const branchesPctText = `${sum.branches.pct.toFixed(1)}%`;
    const header = `${ansi.bold(rel)}  lines ${tintPct(sum.lines.pct)(
      linesPctText,
    )} ${barCell(compositeBarPct(sum, blocks))(''.padEnd(14))}  funcs ${tintPct(sum.functions.pct)(
      funcsPctText,
    )}  branches ${tintPct(sum.branches.pct)(branchesPctText)}`;
    console.info(header);
    const hotspots = blocks.slice(0, maxHotspotsDerived);
    if (hotspots.length) {
      console.info(ansi.bold('  Hotspots:'));
      for (const hotspot of hotspots) {
        const len = hotspot.end - hotspot.start + 1;
        const link = `\u001B]8;;${preferredEditorHref(
          abs,
          hotspot.start,
          opts.editorCmd,
        )}\u0007${path.basename(abs)}:${hotspot.start}\u001B]8;;\u0007`;
        console.info(`    - L${hotspot.start}–L${hotspot.end} (${len} lines)  ${link}`);
      }
    }
    const functionsList = missFns.slice(0, maxFunctionsDerived);
    if (functionsList.length) {
      console.info(ansi.bold('  Uncovered functions:'));
      for (const fn of functionsList) {
        console.info(
          `    - ${fn.name} @ \u001B]8;;${preferredEditorHref(
            abs,
            fn.line,
            opts.editorCmd,
          )}\u0007${path.basename(abs)}:${fn.line}\u001B]8;;\u0007`,
        );
      }
    }
    const branchesList = misses.slice(0, maxBranchesDerived);
    if (branchesList.length) {
      console.info(ansi.bold('  Branches with zero-hit paths:'));
      for (const br of branchesList) {
        console.info(
          `    - L${br.line} branch#${br.id}  missed: [${br.zeroPaths.join(
            ', ',
          )}]  \u001B]8;;${preferredEditorHref(
            abs,
            br.line,
            opts.editorCmd,
          )}\u0007${path.basename(abs)}:${br.line}\u001B]8;;\u0007`,
        );
      }
    }
    const restHs = Math.max(0, blocks.length - hotspots.length);
    const restFns = Math.max(0, missFns.length - functionsList.length);
    const restBrs = Math.max(0, misses.length - branchesList.length);
    if (restHs + restFns + restBrs > 0) {
      console.info(
        ansi.dim(`  … truncated: +${restHs} hotspots, +${restFns} funcs, +${restBrs} branches`),
      );
    }
    console.info('');
  }
  if (files.length > fileCap) {
    console.info(
      ansi.dim(
        `… ${
          files.length - fileCap
        } more files omitted (use --coverage.maxFiles or --coverage.mode=full)`,
      ),
    );
  }
};

// Shorten a relative path to fit within maxWidth using directory squeezing:
// keep HEAD dirs, squeeze the MIDDLE as "…/", keep TAIL dirs, and always
// preserve the filename (trimming the stem token-aware as a last resort).
const shortenPathPreservingFilename = (
  relPath: string,
  maxWidth: number,
  opts?: {
    readonly keepHead?: number; // soft hint for starting head dirs (default 1)
    readonly keepTail?: number; // soft hint for starting tail dirs (default 1)
    readonly ellipsis?: '…' | '...'; // default '…'
    readonly minDirChars?: number; // minimum per-dir chars when trimmed (default 1)
  },
): string => {
  const ellipsis = opts?.ellipsis ?? '…';
  const START_HEAD = Math.max(0, opts?.keepHead ?? 1);
  const START_TAIL = Math.max(0, opts?.keepTail ?? 1);
  const MIN_DIR_CHARS = Math.max(1, opts?.minDirChars ?? 2);

  if (maxWidth <= 0) {
    return '';
  }

  const visibleWidth = (text: string): number => [...text].length;

  const splitMultiExt = (base: string) => {
    const endings = [
      '.test.ts',
      '.spec.ts',
      '.d.ts',
      '.schema.ts',
      '.schema.js',
      '.config.ts',
      '.config.js',
    ] as const;
    for (const ending of endings) {
      if (base.endsWith(ending)) {
        return { stem: base.slice(0, -ending.length), ext: ending } as const;
      }
    }
    const ext = path.extname(base);
    return { stem: base.slice(0, -ext.length), ext } as const;
  };

  const sliceBalanced = (input: string, width: number): string => {
    if (visibleWidth(input) <= width) {
      return input;
    }
    if (width <= visibleWidth(ellipsis)) {
      return ellipsis.slice(0, width);
    }
    const keep = width - visibleWidth(ellipsis);
    const head = Math.ceil(keep / 2);
    const tail = Math.floor(keep / 2);
    return input.slice(0, head) + ellipsis + input.slice(-tail);
  };

  const tokenAwareMiddle = (stem: string, budget: number): string => {
    if (budget <= 0) {
      return '';
    }
    if (visibleWidth(stem) <= budget) {
      return stem;
    }
    if (budget <= visibleWidth(ellipsis)) {
      return ellipsis.slice(0, budget);
    }
    const tokens = stem.split(/([._-])/); // keep separators
    let leftIndex = 0;
    let rightIndex = tokens.length - 1;
    let left = '';
    let right = '';
    while (leftIndex <= rightIndex) {
      const tryL = left + tokens[leftIndex];
      const tryR = tokens[rightIndex] + right;
      const candL = tryL + ellipsis + right;
      const candR = left + ellipsis + tryR;
      const canL = visibleWidth(candL) <= budget;
      const canR = visibleWidth(candR) <= budget;
      if (canL && (!canR || visibleWidth(candL) >= visibleWidth(candR))) {
        left = tryL;
        leftIndex += 1;
      } else if (canR) {
        right = tryR;
        rightIndex -= 1;
      } else {
        break;
      }
    }
    const glued = left + ellipsis + right;
    if (visibleWidth(glued) < budget - 1) {
      return sliceBalanced(stem, budget);
    }
    return visibleWidth(glued) <= budget ? glued : sliceBalanced(stem, budget);
  };

  // Build a candidate label from split parts, collapsing duplicate ellipses
  // and removing any segments that are themselves just an ellipsis string.
  const joinParts = (
    headParts: readonly string[],
    tailParts: readonly string[],
    hideMiddle: boolean,
    baseLabel: string,
  ): string => {
    const removeEllipsisSegments = (parts: readonly string[]) =>
      parts.filter((segment) => segment && segment !== ellipsis);
    const headCleaned = removeEllipsisSegments(headParts);
    const tailCleaned = removeEllipsisSegments(tailParts);

    const segmentsList: string[] = [];
    if (headCleaned.length) {
      segmentsList.push(headCleaned.join('/'));
    }
    if (hideMiddle) {
      segmentsList.push(ellipsis);
    }
    if (tailCleaned.length) {
      segmentsList.push(tailCleaned.join('/'));
    }
    segmentsList.push(baseLabel);

    const squashed: string[] = [];
    for (const segmentText of segmentsList) {
      const previous = squashed[squashed.length - 1];
      const isDuplicateEllipsis = segmentText === ellipsis && previous === ellipsis;
      if (!isDuplicateEllipsis) {
        squashed.push(segmentText);
      }
    }
    return squashed.join('/');
  };

  // Trim shown directory names to make the candidate fit, token-aware
  const tryTrimDirsToFit = (
    headSrc: readonly string[],
    tailSrc: readonly string[],
    hideMiddle: boolean,
    baseLabel: string,
    max: number,
  ): string | null => {
    const headParts = headSrc.map((segment) => segment);
    const tailParts = tailSrc.map((segment) => segment);
    let hidAny = false;

    const build = () => {
      const label = joinParts(headParts, tailParts, hideMiddle || hidAny, baseLabel);
      return { label, width: visibleWidth(label) };
    };

    let { label, width } = build();
    if (width <= max) {
      return label;
    }

    type Segment = {
      arr: string[];
      idx: number;
      original: string;
      budget: number;
      min: number;
    };
    const segments: Segment[] = [];
    headParts.forEach((part, index) =>
      segments.push({
        arr: headParts,
        idx: index,
        original: headSrc[index] ?? '',
        budget: visibleWidth(part),
        min: MIN_DIR_CHARS,
      }),
    );
    tailParts.forEach((part, index) =>
      segments.push({
        arr: tailParts,
        idx: index,
        original: tailSrc[index] ?? '',
        budget: visibleWidth(part),
        min: MIN_DIR_CHARS,
      }),
    );

    let guardCounter = 200;
    while (width > max && guardCounter-- > 0) {
      let best: Segment | undefined;
      let bestSlack = 0;
      for (const seg of segments) {
        const slack = seg.budget - seg.min;
        if (slack > bestSlack) {
          bestSlack = slack;
          best = seg;
        }
      }
      if (!best) {
        break;
      }

      const overflow = width - max;
      const reduceBy = Math.min(overflow, best.budget - best.min);
      const nextBudget = Math.max(best.min, best.budget - reduceBy);

      // If the segment would shrink below the minimum per-dir chars, hide it.
      if (nextBudget < MIN_DIR_CHARS) {
        best.arr[best.idx] = '';
        best.budget = 0;
        hidAny = true;
      } else {
        const trimmed = tokenAwareMiddle(best.original, nextBudget);
        if (trimmed === ellipsis || visibleWidth(trimmed) < MIN_DIR_CHARS) {
          best.arr[best.idx] = '';
          best.budget = 0;
          hidAny = true;
        } else {
          best.arr[best.idx] = trimmed;
          best.budget = visibleWidth(trimmed);
        }
      }

      ({ label, width } = build());
      if (width <= max) {
        return label;
      }
    }

    return null;
  };

  const normalized = relPath.replace(/\\/g, '/');
  if (visibleWidth(normalized) <= maxWidth) {
    return normalized;
  }

  const segs = normalized.split('/');
  const baseName = segs.pop() ?? '';
  const { stem, ext } = splitMultiExt(baseName);
  const baseFull = stem + ext;

  if (visibleWidth(baseFull) > maxWidth) {
    const stemBudget = Math.max(1, maxWidth - visibleWidth(ext));
    return tokenAwareMiddle(stem, stemBudget) + ext;
  }

  if (segs.length === 0) {
    return baseFull;
  }

  const total = segs.length;
  let headCount = Math.min(START_HEAD, total);
  let tailCount = Math.min(START_TAIL, Math.max(0, total - headCount));
  if (tailCount === 0 && total > headCount) {
    tailCount = 1;
  }

  const buildRaw = (headNum: number, tailNum: number) => {
    const headRaw = segs.slice(0, headNum);
    const tailRaw = segs.slice(total - tailNum);
    const hideMiddle = headNum + tailNum < total;
    return { headRaw, tailRaw, hideMiddle } as const;
  };

  let { headRaw, tailRaw, hideMiddle } = buildRaw(headCount, tailCount);
  let candidate = tryTrimDirsToFit(headRaw, tailRaw, hideMiddle, baseFull, maxWidth);
  if (!candidate) {
    return baseFull;
  }

  while (headCount + tailCount < total) {
    let advanced = false;

    if (headCount + tailCount < total) {
      const tryTail = Math.min(tailCount + 1, total - headCount);
      ({ headRaw, tailRaw, hideMiddle } = buildRaw(headCount, tryTail));
      const candTail = tryTrimDirsToFit(headRaw, tailRaw, hideMiddle, baseFull, maxWidth);
      if (candTail) {
        tailCount = tryTail;
        candidate = candTail;
        advanced = true;
      }
    }

    if (!advanced && headCount + tailCount < total) {
      const tryHead = Math.min(headCount + 1, total - tailCount);
      ({ headRaw, tailRaw, hideMiddle } = buildRaw(tryHead, tailCount));
      const candHead = tryTrimDirsToFit(headRaw, tailRaw, hideMiddle, baseFull, maxWidth);
      if (candHead) {
        headCount = tryHead;
        candidate = candHead;
        advanced = true;
      }
    }

    if (!advanced) {
      break;
    }
  }

  if (headCount + tailCount >= total) {
    const full = `${segs.join('/')}/${baseFull}`;
    return visibleWidth(full) <= maxWidth ? full : candidate;
  }

  return candidate;
};

const isTestLikePath = (abs: string): boolean =>
  /(^|\/)__tests__\//.test(abs) ||
  /(^|\/)tests?\//.test(abs) ||
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(abs);

// Extract import/require/export-from specs for one file using ripgrep with timeout.
const extractImportSpecs = async (
  absPath: string,
  cache: Map<string, readonly string[]>,
): Promise<readonly string[]> => {
  const cached = cache.get(absPath);
  if (cached) {
    return cached;
  }

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
    'import\\s+[^\'"\n]*from\\s+[\'"]([^\'"]+)[\'"]',
    '-e',
    'require\\(\\s*[\'"]([^\'"]+)[\'"]\\s*\\)',
    '-e',
    'export\\s+(?:\\*|\\{[^}]*\\})\\s*from\\s*[\'"]([^\'"]+)[\'"]',
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

  const out = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((spec) => spec.startsWith('.') || spec.startsWith('/'));

  cache.set(absPath, out);
  return out;
};

// Build minimal import-graph distance map from a set of executed tests.
const buildDistanceMapFromTests = async (
  executedTestsAbs: readonly string[],
  rootDir: string,
): Promise<Map<string, number>> => {
  const dist = new Map<string, number>();
  const specsCache = new Map<string, readonly string[]>();
  const resolutionCache = new Map<string, string | undefined>();
  const queue: Array<[string, number]> = [];
  const seen = new Set<string>();

  for (const testAbs of executedTestsAbs) {
    const testPathNormalized = path.resolve(testAbs).replace(/\\/g, '/');
    dist.set(testPathNormalized, 0);
    queue.push([testPathNormalized, 0]);
  }

  const MAX_DEPTH = 6;

  while (queue.length) {
    const nextItem = queue.shift();
    if (!nextItem) {
      break;
    }
    const [currentFile, currentDistance] = nextItem;
    const withinDepth = currentDistance < MAX_DEPTH;
    const notSeen = !seen.has(currentFile);
    const isRepoFile = !currentFile.includes('/node_modules/');
    if (withinDepth && notSeen && isRepoFile) {
      seen.add(currentFile);
      // eslint-disable-next-line no-await-in-loop
      const specs = await extractImportSpecs(currentFile, specsCache);
      const nextDistance = currentDistance + 1;
      for (const spec of specs) {
        const resolved = resolveImportWithRoot(currentFile, spec, rootDir, resolutionCache);
        const usable = resolved && !resolved.includes('/node_modules/');
        if (usable) {
          const existing = dist.get(resolved!);
          if (existing === undefined || nextDistance < existing) {
            dist.set(resolved!, nextDistance);
            queue.push([resolved!, nextDistance]);
          }
        }
      }
    }
  }

  return dist;
};

export const renderPerFileCompositeTable = async (opts: {
  readonly absPath: string;
  readonly file: import('istanbul-lib-coverage').FileCoverage;
  readonly root: string;
  readonly maxRows?: number;
  readonly maxHotspots?: number;
  readonly editorCmd?: string;
}): Promise<void> => {
  const rel = path.relative(opts.root, opts.absPath).replace(/\\/g, '/');
  const sum = opts.file.toSummary();
  const rowsAvail =
    typeof process.stdout.rows === 'number' && process.stdout.rows > 10 ? process.stdout.rows : 40;
  const tableBudget = Math.max(14, Math.min(opts.maxRows ?? rowsAvail - 1, rowsAvail + 8));
  const rowBudget = Math.max(6, tableBudget - 6);
  const blocks = computeUncoveredBlocks(opts.file)
    .slice()
    .sort((firstRange, secondRange) => {
      const firstLength = firstRange.end - firstRange.start;
      const secondLength = secondRange.end - secondRange.start;
      return secondLength - firstLength || firstRange.start - secondRange.start;
    });
  const missFns = missedFunctions(opts.file);
  const misses = missedBranches(opts.file);
  const total =
    typeof process.stdout.columns === 'number' && process.stdout.columns > 20
      ? process.stdout.columns
      : 100;
  const fileMax = Math.max(32, Math.floor(total * 0.42));
  const detailMax = Math.max(20, Math.floor(total * 0.22));
  const barMax = Math.max(6, Math.floor(total * 0.06));
  const cols: readonly ColumnSpec[] = [
    { label: 'File', min: 28, max: fileMax },
    { label: 'Section', min: 8, max: 10 },
    { label: 'Where', min: 10, max: 14 },
    { label: 'Lines%', min: 6, max: 7, align: 'right' },
    { label: 'Bar', min: 6, max: barMax },
    { label: 'Funcs%', min: 6, max: 7, align: 'right' },
    { label: 'Branch%', min: 7, max: 8, align: 'right' },
    { label: 'Detail', min: 18, max: detailMax },
  ];
  const rows: Cell[][] = [];
  const lPct = Number.isFinite(sum.lines.pct) ? sum.lines.pct : 0;
  const fPct = Number.isFinite(sum.functions.pct) ? sum.functions.pct : 0;
  const bPct = Number.isFinite(sum.branches.pct) ? sum.branches.pct : 0;
  rows.push([
    cell(rel, (padded) => {
      const width = padded.length;
      const display = shortenPathPreservingFilename(rel, width).padEnd(width);
      return linkifyPadded(opts.absPath, undefined, opts.editorCmd)(display);
    }),
    cell('Summary', ansi.bold),
    cell('—'),
    cell(`${lPct.toFixed(1)}%`, tintPct(lPct)),
    cell(''.padEnd(10), barCell(compositeBarPct(sum, blocks))),
    cell(`${fPct.toFixed(1)}%`, tintPct(fPct)),
    cell(`${bPct.toFixed(1)}%`, tintPct(bPct)),
    cell(''),
  ]);
  rows.push([
    cell(rel, (padded) =>
      ansi.dim(shortenPathPreservingFilename(rel, padded.length).padEnd(padded.length)),
    ),
    cell('Totals', ansi.dim),
    cell('—', ansi.dim),
    cell(`${lPct.toFixed(1)}%`, ansi.dim),
    cell(''.padEnd(10), (padded) => ansi.dim(padded)),
    cell(`${fPct.toFixed(1)}%`, ansi.dim),
    cell(`${bPct.toFixed(1)}%`, ansi.dim),
    cell(''),
  ]);
  if (blocks.length || missFns.length || misses.length) {
    const wantHs = Math.min(
      typeof opts.maxHotspots === 'number' ? opts.maxHotspots : Math.ceil(rowBudget * 0.45),
      blocks.length,
    );
    if (wantHs > 0) {
      rows.push([
        cell(rel, (padded) =>
          ansi.dim(shortenPathPreservingFilename(rel, padded.length).padEnd(padded.length)),
        ),
        cell('Hotspots', ansi.dim),
        cell('', ansi.dim),
        cell('', ansi.dim),
        cell('', ansi.dim),
        cell('', ansi.dim),
        cell('', ansi.dim),
        cell('(largest uncovered ranges)', ansi.dim),
      ]);
      for (const hotspotRange of blocks.slice(0, wantHs)) {
        rows.push([
          cell(rel, (padded) => {
            const width = padded.length;
            const display = shortenPathPreservingFilename(rel, width).padEnd(width);
            return linkifyPadded(opts.absPath, hotspotRange.start, opts.editorCmd)(display);
          }),
          cell('Hotspot'),
          cell(`L${hotspotRange.start}–L${hotspotRange.end}`),
          cell(''),
          cell(''),
          cell(''),
          cell(''),
          cell(`${hotspotRange.end - hotspotRange.start + 1} lines`),
        ]);
      }
    }
    const wantFn = Math.min(Math.ceil(rowBudget * 0.25), missFns.length);
    if (wantFn > 0) {
      rows.push([
        cell(rel, (padded) =>
          ansi.dim(shortenPathPreservingFilename(rel, padded.length).padEnd(padded.length)),
        ),
        cell('Functions', ansi.dim),
        cell('', ansi.dim),
        cell('', ansi.dim),
        cell('', ansi.dim),
        cell('', ansi.dim),
        cell('', ansi.dim),
        cell('(never executed)', ansi.dim),
      ]);
      for (const missedFunction of missFns.slice(0, wantFn)) {
        rows.push([
          cell(rel, (padded) => {
            const width = padded.length;
            const display = shortenPathPreservingFilename(rel, width).padEnd(width);
            return linkifyPadded(opts.absPath, missedFunction.line, opts.editorCmd)(display);
          }),
          cell('Func'),
          cell(`L${missedFunction.line}`),
          cell(''),
          cell(''),
          cell(''),
          cell(''),
          cell(missedFunction.name),
        ]);
      }
    }
    const wantBr = Math.min(Math.ceil(rowBudget * 0.2), misses.length);
    if (wantBr > 0) {
      rows.push([
        cell(rel, (padded) =>
          ansi.dim(shortenPathPreservingFilename(rel, padded.length).padEnd(padded.length)),
        ),
        cell('Branches', ansi.dim),
        cell('', ansi.dim),
        cell('', ansi.dim),
        cell('', ansi.dim),
        cell('', ansi.dim),
        cell('', ansi.dim),
        cell('(paths with 0 hits)', ansi.dim),
      ]);
      for (const missedBranch of misses.slice(0, wantBr)) {
        rows.push([
          cell(rel, (padded) => {
            const width = padded.length;
            const display = shortenPathPreservingFilename(rel, width).padEnd(width);
            return linkifyPadded(opts.absPath, missedBranch.line, opts.editorCmd)(display);
          }),
          cell('Branch'),
          cell(`L${missedBranch.line}`),
          cell(''),
          cell(''),
          cell(''),
          cell(''),
          cell(`#${missedBranch.id} missed [${missedBranch.zeroPaths.join(', ')}]`),
        ]);
      }
    }
    const target = rowBudget;
    if (rows.length < target) {
      const lineQueue: number[] = [];
      for (const hotspotRange of blocks) {
        for (let ln = hotspotRange.start; ln <= hotspotRange.end; ln += 1) {
          lineQueue.push(ln);
        }
        if (lineQueue.length > 5000) {
          break;
        }
      }
      while (rows.length < target && lineQueue.length) {
        const ln = lineQueue.shift()!;
        rows.push([
          cell(rel, (padded) => {
            const width = padded.length;
            const display = shortenPathPreservingFilename(rel, width).padEnd(width);
            return linkifyPadded(opts.absPath, ln, opts.editorCmd)(display);
          }),
          cell('Line'),
          cell(`L${ln}`),
          cell(''),
          cell(''),
          cell(''),
          cell(''),
          cell('uncovered'),
        ]);
      }
      while (rows.length < target) {
        rows.push([cell(''), cell(''), cell(''), cell(''), cell(''), cell(''), cell(''), cell('')]);
      }
    }
  }
  const table = renderTable(cols, rows);
  console.info(table);
  const sep = ansi.gray(
    '─'.repeat(
      Math.max(20, typeof process.stdout.columns === 'number' ? process.stdout.columns : 100),
    ),
  );
  console.info(sep);
};

export const printPerFileCompositeTables = async (opts: {
  readonly map: import('istanbul-lib-coverage').CoverageMap;
  readonly root: string;
  readonly pageFit?: boolean;
  readonly maxHotspots?: number;
  readonly selectionPaths?: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly executedTests?: readonly string[];
  readonly editorCmd?: string;
}): Promise<void> => {
  const selectionPathTokens = (opts.selectionPaths ?? [])
    .map((tok) => String(tok || '').trim())
    .filter(Boolean);
  const resolvedSelectionAbs = await resolveProdSelectionTokens(selectionPathTokens, opts.root);
  const selectionAbs = (
    resolvedSelectionAbs.length > 0
      ? resolvedSelectionAbs
      : selectionPathTokens.map((selPath) => path.resolve(selPath))
  ).map((absPath) => path.resolve(absPath).replace(/\\/g, '/'));
  const changedAbs = (opts.changedFiles ?? []).map((chgPath) =>
    path.resolve(chgPath).replace(/\\/g, '/'),
  );
  const tokenizeForSimilarity = (filePathForTokens: string) =>
    new Set(
      filePathForTokens
        .toLowerCase()
        .replace(/[^a-z0-9/_\-.]/g, ' ')
        .split(/[/_.-]+/)
        .filter(Boolean),
    );
  const jaccard = (left: Set<string>, right: Set<string>) => {
    let intersectionCount = 0;
    for (const token of left) {
      if (right.has(token)) {
        intersectionCount += 1;
      }
    }
    const unionSize = left.size + right.size - intersectionCount || 1;
    return intersectionCount / unionSize;
  };
  // use helpers below for config filtering and change weights
  const isSameDirOrChild = (firstAbs: string, secondAbs: string) => {
    const dirA = path.dirname(firstAbs).replace(/\\/g, '/');
    const dirB = path.dirname(secondAbs).replace(/\\/g, '/');
    return dirA === dirB || dirB.startsWith(`${dirA}/`) || dirA.startsWith(`${dirB}/`);
  };
  const selectionSets = selectionAbs.map(tokenizeForSimilarity);
  const changedTokens = changedAbs.map(tokenizeForSimilarity);
  const executedTestsAbs = (opts.executedTests ?? [])
    .map((testPath) => path.resolve(testPath).replace(/\\/g, '/'))
    .filter((absPath) => absPath.length > 0);
  const testTokens = executedTestsAbs.map(tokenizeForSimilarity);
  const allMapFilesAbs = opts.map
    .files()
    .map((absPath) => path.resolve(absPath).replace(/\\/g, '/'));
  const uncoveredCandidates = allMapFilesAbs.filter((absPath) => {
    const sum = opts.map.fileCoverageFor(absPath).toSummary();
    return !(sum.lines.pct >= 100 && sum.functions.pct >= 100 && sum.branches.pct >= 100);
  });
  let candidates: string[];
  if (selectionAbs.length > 0 || executedTestsAbs.length > 0) {
    // When tests or production paths are explicitly selected, consider ALL covered files,
    // then we'll sort by relevancy to the executed tests/selection below.
    candidates = allMapFilesAbs.slice();
  } else {
    candidates = uncoveredCandidates;
  }
  // Always exclude test-like files and config-like files from candidates
  candidates = candidates.filter(
    (abs) => !isTestLikePath(abs) && !isConfigLikeHelper(opts.root, abs),
  );

  // Compute relevancy of each candidate file to executed tests using import graph distance.
  // Distance tiers: 0=selected file, 1=direct from test, 2+=transitive.
  const INF = 1e9;
  const distFromTests = executedTestsAbs.length
    ? await buildDistanceMapFromTests(executedTestsAbs, opts.root)
    : new Map<string, number>();
  const selectionSetAbs = new Set(selectionAbs);

  type Scored = {
    abs: string;
    rel: string;
    linesPct: number;
    group: number;
    score: number;
    distance: number;
  };
  const scored: Scored[] = await Promise.all(
    candidates.map(async (abs): Promise<Scored> => {
      const rel = path.relative(opts.root, abs).replace(/\\/g, '/');
      const sum = opts.map.fileCoverageFor(abs).toSummary();
      const pct = Number.isFinite(sum.lines.pct) ? sum.lines.pct : 0;
      const absNorm = path.resolve(abs).replace(/\\/g, '/');
      const selfTokens = tokenizeForSimilarity(absNorm);
      const selSim = Math.max(
        0,
        ...selectionSets.map((selectionTokenSet) => jaccard(selfTokens, selectionTokenSet)),
      );
      const chgSim = Math.max(
        0,
        ...changedTokens.map((changedTokenSet) => jaccard(selfTokens, changedTokenSet)),
      );
      const tstSim = Math.max(0, ...testTokens.map((tset) => jaccard(selfTokens, tset)));
      const nearSelection = selectionAbs.some((selectionPath) =>
        isSameDirOrChild(absNorm, selectionPath),
      );
      const nearChanged = changedAbs.some((changedPath) => isSameDirOrChild(absNorm, changedPath));
      const related = selSim > 0 || chgSim > 0 || nearSelection || nearChanged;

      // Use precomputed distance
      const distance = selectionSetAbs.has(absNorm) ? 0 : (distFromTests.get(absNorm) ?? INF);

      let group = 6;
      if (selectionSetAbs.has(absNorm)) {
        group = 0; // selected prod file
      } else if (distance === 1) {
        group = 1; // directly imported by tests
      } else if (distance >= 2 && distance <= 3) {
        group = 2; // nearby transitive
      } else if (distance < INF) {
        group = 3; // distant transitive
      } else if (related) {
        group = 4; // path-similar only
      } else if (pct > 0) {
        group = 5; // executed but not in graph
      } else {
        group = 6;
      }

      // similarity to selection/changed/tests, with slight demotion for config/
      const prefixPenalty = rel.startsWith('config/') ? -100 : 0;
      const score =
        Math.round(selSim * 10) + Math.round(chgSim * 5) + Math.round(tstSim * 12) + prefixPenalty;
      return { abs: absNorm, rel, linesPct: pct, group, score, distance };
    }),
  );
  // Primary ordering by directness rank using shared relevance helpers
  const prodSeeds = selectionAbs.length > 0 ? selectionAbs : changedAbs;
  const rank = await computeDirectnessRank({ repoRoot: opts.root, productionSeeds: prodSeeds });
  let files = sortPathsWithRank(
    rank,
    scored.map((item) => item.abs),
  );
  // Re-rank head by explicit selection and degree of change; deprioritize config files
  {
    const weights = await computeChangeWeights(opts.root, changedAbs);
    files = reorderBySelectionChangeAndConfig(opts.root, files, selectionAbs, changedAbs, weights);
  }
  const rowsAvail =
    typeof process.stdout.rows === 'number' && process.stdout.rows > 10 ? process.stdout.rows : 40;
  const perFileRows = opts.pageFit ? Math.max(14, rowsAvail - 1) : rowsAvail + 8;
  for (const absolutePath of [...files].reverse()) {
    const fileCoverage = opts.map.fileCoverageFor(absolutePath);
    // Print least-relevant first, highest priority last (nearest the summary table)
    // and keep output order stable.
    // eslint-disable-next-line no-await-in-loop
    await renderPerFileCompositeTable({
      absPath: absolutePath,
      file: fileCoverage,
      root: opts.root,
      maxRows: perFileRows,
      ...(typeof opts.maxHotspots === 'number' ? { maxHotspots: opts.maxHotspots } : {}),
      editorCmd: opts.editorCmd ?? '',
    });
  }
};

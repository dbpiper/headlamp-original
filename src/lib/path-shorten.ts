import * as path from 'node:path';

// Shorten a relative path to fit within maxWidth using directory squeezing:
// keep HEAD dirs, squeeze the MIDDLE as "…/", keep TAIL dirs, and always
// preserve the filename (trimming the stem token-aware as a last resort).
export const shortenPathPreservingFilename = (
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

    type Segment = { arr: string[]; idx: number; original: string; budget: number; min: number };
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

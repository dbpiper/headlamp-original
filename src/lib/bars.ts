import { ansi, supportsUnicode } from './ansi';
import { Colors } from './colors';

const SUCCESS_THRESHOLD = 85;
const WARNING_THRESHOLD = 60;
const PERCENT_MAX = 100;
const DEFAULT_BAR_WIDTH = 14;

// NOTE: keep local color helpers minimal in this module; shared palette lives in colors.ts

export const tintPct = (pct: number): ((s: string) => string) => {
  if (pct >= SUCCESS_THRESHOLD) {
    return Colors.Success;
  }
  if (pct >= WARNING_THRESHOLD) {
    return Colors.Warn;
  }
  return Colors.Failure;
};

export const bar = (pct: number, width = DEFAULT_BAR_WIDTH): string => {
  const filled = Math.round((pct / PERCENT_MAX) * width);
  const solid = supportsUnicode() ? '█' : '#';
  const empty = supportsUnicode() ? '░' : '-';
  const good = tintPct(pct);
  const MIN_REMAINING = 0;
  return `${good(solid.repeat(filled))}${ansi.gray(
    empty.repeat(Math.max(MIN_REMAINING, width - filled)),
  )}`;
};

// Neutral progress bar variant: always uses a single calm "Run" color
// regardless of percentage thresholds (success/warn/failure colors are for coverage, not progress).
export const barNeutral = (pct: number, width = DEFAULT_BAR_WIDTH): string => {
  const filled = Math.round((pct / PERCENT_MAX) * width);
  const solid = supportsUnicode() ? '█' : '#';
  const empty = supportsUnicode() ? '░' : '-';
  const MIN_REMAINING = 0;
  return `${Colors.Run(solid.repeat(filled))}${ansi.gray(
    empty.repeat(Math.max(MIN_REMAINING, width - filled)),
  )}`;
};

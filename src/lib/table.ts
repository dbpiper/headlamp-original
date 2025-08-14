import { ansi } from './ansi';
import { bar } from './bars';

export type ColumnSpec = {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly align?: 'left' | 'right';
};
export type Cell = { readonly raw: string; readonly decorate?: (s: string) => string };

export const cell = (raw: string, decorate?: (s: string) => string): Cell =>
  decorate ? { raw, decorate } : { raw };

const padVisible = (text: string, width: number, align: 'left' | 'right') => {
  if (text.length === width) {
    return text;
  }
  if (text.length < width) {
    return align === 'right'
      ? ' '.repeat(width - text.length) + text
      : text + ' '.repeat(width - text.length);
  }
  return text.slice(0, Math.max(0, width));
};

const border = {
  v: '│',
  h: '─',
  tl: '┌',
  tr: '┐',
  bl: '└',
  br: '┘',
  jt: '┬',
  jb: '┴',
  jc: '┼',
} as const;

export const renderTable = (
  columns: readonly ColumnSpec[],
  rows: ReadonlyArray<readonly Cell[]>,
) => {
  const total =
    typeof process.stdout.columns === 'number' ? Math.max(process.stdout.columns, 60) : 100;
  const mins = columns.map((columnSpec) => columnSpec.min);
  const maxs = columns.map((columnSpec) => columnSpec.max);
  const borders = columns.length + 1;
  const budget = Math.max(1, total - borders);

  let widths = mins.slice();
  const minSum = mins.reduce((accumulated, value) => accumulated + value, 0);
  const maxSum = maxs.reduce((accumulated, value) => accumulated + value, 0);

  if (minSum > budget) {
    const factor = budget / minSum;
    widths = mins.map((minForColumn) => Math.max(1, Math.floor(minForColumn * factor)));
    let leftover = budget - widths.reduce((accumulated, widthValue) => accumulated + widthValue, 0);
    for (let i = 0; leftover > 0 && i < widths.length; i += 1) {
      widths[i]! += 1;
      leftover -= 1;
    }
  } else {
    let remaining = Math.min(budget, maxSum) - minSum;
    for (let i = 0; i < widths.length && remaining > 0; i += 1) {
      const maximumWidthAtIndex = maxs[i] ?? 0;
      const currentWidthAtIndex = widths[i] ?? 0;
      const grow = Math.min(remaining, Math.max(0, maximumWidthAtIndex - currentWidthAtIndex));
      widths[i] = currentWidthAtIndex + grow;
      remaining -= grow;
    }
  }

  const hr = (left: string, mid: string, right: string) =>
    `${left}${widths.map((columnWidth) => '─'.repeat(columnWidth)).join(mid)}${right}`;
  const hrTop = hr(border.tl, border.jt, border.tr);
  const hrSep = hr(border.jc, border.jc, border.jc);
  const hrBot = hr(border.bl, border.jb, border.br);

  const header = `${border.v}${columns
    .map((col, i) => ansi.bold(padVisible(col.label, widths[i]!, col.align ?? 'left')))
    .join(border.v)}${border.v}`;

  const lines = rows.map((row) => {
    const cells = row.map((cellObj, i) => {
      const txt = padVisible(cellObj.raw, widths[i]!, columns[i]!.align ?? 'left');
      return typeof cellObj.decorate === 'function' ? cellObj.decorate(txt) : txt;
    });
    return `${border.v}${cells.join(border.v)}${border.v}`;
  });

  return [hrTop, header, hrSep, ...lines, hrBot].join('\n');
};

export const barCell = (pct: number) => (padded: string) => bar(pct, padded.length);

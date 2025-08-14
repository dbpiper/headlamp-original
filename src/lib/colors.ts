export type Colorize = (text: string) => string;

const useColor = Boolean(
  process.stdout.isTTY && !(process.env as unknown as { NO_COLOR?: string }).NO_COLOR,
);
const maybe =
  (fn: Colorize): Colorize =>
  (text) =>
    useColor ? fn(text) : text;

export const colorRgb = (red: number, green: number, blue: number): Colorize =>
  maybe((text) => `\x1b[38;2;${red};${green};${blue}m${text}\x1b[0m`);

const HEX_SHORT_LENGTH = 3;
const HEX_SLICE = {
  redStart: 0,
  redEnd: 2,
  greenStart: 2,
  greenEnd: 4,
  blueStart: 4,
  blueEnd: 6,
} as const;

const parseHex = (hex: string): { red: number; green: number; blue: number } => {
  const normalized = hex.replace(/^#/, '').trim();
  const isShort = normalized.length === HEX_SHORT_LENGTH;
  const full = isShort
    ? normalized
        .split('')
        .map((char) => char + char)
        .join('')
    : normalized;
  const red = parseInt(full.slice(HEX_SLICE.redStart, HEX_SLICE.redEnd), 16);
  const green = parseInt(full.slice(HEX_SLICE.greenStart, HEX_SLICE.greenEnd), 16);
  const blue = parseInt(full.slice(HEX_SLICE.blueStart, HEX_SLICE.blueEnd), 16);
  return { red, green, blue };
};

export const colorHex = (hex: string): Colorize => {
  const { red, green, blue } = parseHex(hex);
  return colorRgb(red, green, blue);
};

export const Colors = {
  Success: colorHex('#22c55e'),
  Warn: colorHex('#eab308'),
  Failure: colorHex('#ff2323'),
  Run: colorHex('#3b82f6'),
  Skip: colorHex('#eab308'),
  Todo: colorHex('#38bdf8'),
} as const;

export const backgroundRgb = (red: number, green: number, blue: number): Colorize =>
  maybe((text) => `\x1b[48;2;${red};${green};${blue}m${text}\x1b[0m`);

export const bgColorHex = (hex: string): Colorize => {
  const { red, green, blue } = parseHex(hex);
  return backgroundRgb(red, green, blue);
};

export const BackgroundColors = {
  Success: bgColorHex('#22c55e'),
  Warn: bgColorHex('#eab308'),
  Failure: bgColorHex('#ff2323'),
  Run: bgColorHex('#3b82f6'),
  Skip: bgColorHex('#eab308'),
  Todo: bgColorHex('#38bdf8'),
} as const;

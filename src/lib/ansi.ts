export const ansi = {
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
  dim: (text: string) => `\u001b[2m${text}\u001b[22m`,
  black: (text: string) => `\u001b[30m${text}\u001b[39m`,
  red: (text: string) => `\u001b[31m${text}\u001b[39m`,
  yellow: (text: string) => `\u001b[33m${text}\u001b[39m`,
  green: (text: string) => `\u001b[32m${text}\u001b[39m`,
  magenta: (text: string) => `\u001b[35m${text}\u001b[39m`,
  gray: (text: string) => `\u001b[90m${text}\u001b[39m`,
  cyan: (text: string) => `\u001b[36m${text}\u001b[39m`,
  white: (text: string) => `\u001b[97m${text}\u001b[39m`,
  bgRed: (text: string) => `\u001b[41m${text}\u001b[49m`,
  bgGreen: (text: string) => `\u001b[42m${text}\u001b[49m`,
  bgMagenta: (text: string) => `\u001b[45m${text}\u001b[49m`,
  bgCyan: (text: string) => `\u001b[46m${text}\u001b[49m`,
  bgGray: (text: string) => `\u001b[100m${text}\u001b[49m`,
} as const;

export const supportsUnicode = (): boolean => {
  const term = String(process.env.TERM ?? '').toLowerCase();
  const wtSession = process.env.WT_SESSION ?? '';
  return Boolean(wtSession) || (Boolean(term) && term !== 'dumb');
};

export const osc8 = (text: string, url: string) => `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;

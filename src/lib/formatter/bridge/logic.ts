import * as path from 'node:path';

export const extractBridgePath = (raw: string, cwd: string): string | null => {
  const matches = Array.from(
    raw.matchAll(/Test results written to:\s+([^\n\r]+jest-bridge-[^\s'"]+\.json)/g),
  );
  if (!matches.length) {
    return null;
  }
  const jsonPath = (matches[matches.length - 1]![1] ?? '').trim().replace(/^['"`]|['"`]$/g, '');
  return path.isAbsolute(jsonPath) ? jsonPath : path.resolve(cwd, jsonPath).replace(/\\/g, '/');
};

import * as path from 'node:path';

export const toPosix = (p: string) => p.replace(/\\/g, '/');

export const relativizeForMatch = (filePath: string, root: string) => {
  const rel = path.relative(root, filePath);
  return toPosix(rel.startsWith('..') ? filePath : rel);
};

const preferVsCode = (hint?: string): boolean =>
  /^(code|vscode)$/i.test(String(hint ?? process.env.COVERAGE_EDITOR)) ||
  process.env.TERM_PROGRAM === 'vscode' ||
  Boolean(process.env.VSCODE_IPC_HOOK);

export const preferredEditorHref = (absPath: string, line?: number, hint?: string) => {
  const absolute = path.resolve(absPath);
  return preferVsCode(hint)
    ? `vscode://file/${absolute}${typeof line === 'number' ? `:${line}` : ''}`
    : `file://${absolute}${typeof line === 'number' ? `#L${line}` : ''}`;
};

export const linkifyPadded =
  (absPath: string, line?: number, hint?: string) => (padded: string) => {
    const trimmed = padded.replace(/\s+$/u, '');
    const pad = padded.length - trimmed.length;
    return `\u001B]8;;${preferredEditorHref(absPath, line, hint)}\u0007${trimmed}\u001B]8;;\u0007${' '.repeat(pad)}`;
  };

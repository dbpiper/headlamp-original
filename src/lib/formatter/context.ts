import * as fs from 'node:fs';

export type Ctx = {
  readonly cwd: string;
  readonly width: number;
  readonly showStacks: boolean;
  readonly showLogs: boolean;
  readonly projectHint: RegExp;
  readonly editorCmd: string | undefined;
  readonly readSource: (absPath: string) => readonly string[];
};

export const makeCtx = (
  opts?: { readonly cwd?: string; readonly editorCmd?: string },
  showStacks = false,
  showLogs = false,
): Ctx => {
  const cwd = (opts?.cwd ?? process.cwd()).replace(/\\/g, '/');
  const width = Math.max(
    40,
    (process.stdout && (process.stdout as NodeJS.WriteStream).columns) || 80,
  );
  const projectHint = new RegExp(
    `(${cwd.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')})|(/gigworx-node/)`,
  );
  const readSource = (file: string): readonly string[] => {
    try {
      return fs.readFileSync(file.replace(/\\/g, '/'), 'utf8').split(/\r?\n/);
    } catch {
      return [];
    }
  };
  return {
    cwd,
    width,
    showStacks,
    showLogs,
    projectHint,
    editorCmd: opts?.editorCmd,
    readSource,
  };
};

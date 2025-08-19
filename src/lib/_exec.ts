import { spawn } from 'node:child_process';
import * as os from 'node:os';

// eslint-disable-next-line import/no-extraneous-dependencies
import { withTimeout, TimeoutError } from 'es-toolkit';

export type RunTextOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
};

export const runText = async (
  cmd: string,
  args: readonly string[],
  opts: RunTextOptions = {},
): Promise<string> => {
  const child = spawn(cmd, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const exec = new Promise<string>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      Number(code) === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)),
    );
  });

  try {
    return await (opts.timeoutMs ? withTimeout(() => exec, opts.timeoutMs) : exec);
  } catch (caughtError) {
    try {
      if (os.platform() === 'win32') {
        child.kill();
      } else if (typeof child.pid === 'number') {
        child.kill('SIGKILL');
      }
    } catch {
      /* ignore kill error */
    }
    if (caughtError instanceof TimeoutError) {
      throw new Error(`${cmd} timed out`);
    }
    throw caughtError;
  }
};

export const runExitCode = async (
  cmd: string,
  args: readonly string[],
  opts: Omit<RunTextOptions, 'timeoutMs'> = {},
): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(Number(code)));
  });

export const runWithCapture = async (
  cmd: string,
  args: readonly string[],
  opts: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
) =>
  new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let buf = '';
    child.stdout?.on('data', (chunk) => {
      buf += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      buf += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: Number(code), output: buf }));
  });

export const runWithStreaming = async (
  cmd: string,
  args: readonly string[],
  opts: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly onChunk?: (text: string) => void;
  },
) =>
  new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let buf = '';
    const handle = (chunk: unknown) => {
      const text = String(chunk);
      buf += text;
      try {
        if (opts.onChunk) opts.onChunk(text);
      } catch {
        /* ignore onChunk error */
      }
    };
    child.stdout?.on('data', handle);
    child.stderr?.on('data', handle);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: Number(code), output: buf }));
  });

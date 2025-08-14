import { chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

const EXECUTABLE_MODE = 0o755;

(async () => {
  try {
    const cli = resolve(new URL('.', import.meta.url).pathname, '..', 'dist', 'cli.cjs');
    await chmod(cli, EXECUTABLE_MODE);
  } catch {
    // ignore (best-effort)
  }
})();

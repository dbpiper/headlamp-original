import { rm, mkdir, writeFile, chmod, cp } from 'node:fs/promises';
import { resolve } from 'node:path';

// eslint-disable-next-line import/no-extraneous-dependencies
import { build } from 'esbuild';

const root = resolve(new URL('.', import.meta.url).pathname, '..');
const src = resolve(root, 'src');
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// Build ESM library output (index.js)
await build({
  entryPoints: [resolve(src, 'index.ts')],
  outdir: dist,
  format: 'esm',
  platform: 'node',
  target: ['node18'],
  bundle: true,
  sourcemap: true,
  external: [
    'fs',
    'path',
    'os',
    'crypto',
    'stream',
    'util',
    'events',
    'assert',
    'buffer',
    'querystring',
    'url',
    'http',
    'https',
    'zlib',
    'child_process',
    'cluster',
    'dgram',
    'dns',
    'domain',
    'http2',
    'net',
    'perf_hooks',
    'process',
    'punycode',
    'readline',
    'repl',
    'string_decoder',
    'tls',
    'tty',
    'v8',
    'vm',
    'worker_threads',
    // Keep Istanbul libs external to avoid bundling CJS that requires('fs')
    // which breaks in ESM bundles on Node 20+ with dynamic require shim
    'istanbul-lib-coverage',
    'istanbul-lib-report',
    'istanbul-reports',
  ],
});

// Build CJS CLI output (cli.cjs) to support CJS-only deps and dynamic require
await build({
  entryPoints: [resolve(src, 'cli.ts')],
  outfile: resolve(dist, 'cli.cjs'),
  format: 'cjs',
  platform: 'node',
  target: ['node18'],
  bundle: true,
  sourcemap: true,
  external: [
    // keep Node core externals trivial
    'fs',
    'path',
    'os',
    'crypto',
    'stream',
    'util',
    'events',
    'assert',
    'buffer',
    'querystring',
    'url',
    'http',
    'https',
    'zlib',
    'child_process',
    'cluster',
    'dgram',
    'dns',
    'domain',
    'http2',
    'net',
    'perf_hooks',
    'process',
    'punycode',
    'readline',
    'repl',
    'string_decoder',
    'tls',
    'tty',
    'v8',
    'vm',
    'worker_threads',
    // Externalize Istanbul + picomatch so their internal dynamic requires resolve correctly
    'istanbul-lib-coverage',
    'istanbul-lib-report',
    'istanbul-reports',
    'picomatch',
  ],
});

// Create a Node shebang for the CLI
const cliPath = resolve(dist, 'cli.cjs');
const cliContent = await (await import('node:fs/promises')).readFile(cliPath, 'utf8');
await writeFile(cliPath, `#!/usr/bin/env node\n${cliContent}`);
await chmod(cliPath, 0o755);

// Copy Jest runtime assets (reporter/setup) to dist so Jest can require them by absolute path
await mkdir(resolve(dist, 'jest'), { recursive: true });
await cp(resolve(src, 'jest'), resolve(dist, 'jest'), { recursive: true });

import { build } from "esbuild";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL(".", import.meta.url).pathname, "..");
const src = resolve(root, "src");
const dist = resolve(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [resolve(src, "index.ts"), resolve(src, "cli.ts")],
  outdir: dist,
  format: "esm",
  platform: "node",
  target: ["node18"],
  bundle: true,
  sourcemap: true,
});

// Create a Node shebang for the CLI
const cliPath = resolve(dist, "cli.js");
const cliContent = await (
  await import("node:fs/promises")
).readFile(cliPath, "utf8");
await writeFile(cliPath, `#!/usr/bin/env node\n${cliContent}`);

import * as fs from 'node:fs';
import * as path from 'node:path';

// eslint-disable-next-line import/no-extraneous-dependencies
import JSON5 from 'json5';

import type { Ctx } from '../context';
import { extractBridgePath } from './logic';
import { coerceJestJsonToBridge, renderVitestFromJestJSON } from './utils';

export const tryBridgeFallback = (
  raw: string,
  ctx: Ctx,
  opts?: { readonly onlyFailures?: boolean },
): string | null => {
  let bridgeJsonPath = extractBridgePath(raw, ctx.cwd);
  if (!bridgeJsonPath) {
    const def = path.resolve(ctx.cwd, 'coverage/jest-run.json').replace(/\\/g, '/');
    if (fs.existsSync(def)) {
      bridgeJsonPath = def;
    }
  }
  if (!bridgeJsonPath || !fs.existsSync(bridgeJsonPath)) {
    return null;
  }
  try {
    const json = JSON5.parse(fs.readFileSync(bridgeJsonPath, 'utf8'));
    const bridge = coerceJestJsonToBridge(json);
    return renderVitestFromJestJSON(bridge, ctx, opts);
  } catch {
    return null;
  }
};

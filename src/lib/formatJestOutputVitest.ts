import { stripAnsiSimple } from './stacks';
import { pipe } from './fp';
import { parseChunks } from './formatter/parse';
import { renderChunks } from './formatter/render';
import { makeCtx } from './formatter/context';
import { mkPrettyFns } from './formatter/fns';
import { tryBridgeFallback } from './formatter/bridge';

export type FormatOpts = {
  readonly cwd?: string;
  readonly editorCmd?: string;
  readonly onlyFailures?: boolean;
  readonly showLogs?: boolean;
};

export const formatJestOutputVitest = (raw: string, opts?: FormatOpts): string =>
  pipe(
    { raw, opts },
    (state) => ({
      ...state,
      ctx: makeCtx(
        state.opts,
        /\bFAIL\b/.test(stripAnsiSimple(state.raw)),
        Boolean(state.opts?.showLogs),
      ),
    }),
    (state) => ({ ...state, chunks: parseChunks(state.raw) }),
    (state) => ({
      ...state,
      native: renderChunks(state.chunks, state.ctx, mkPrettyFns(), {
        onlyFailures: Boolean(state.opts?.onlyFailures),
      }).text,
    }),
    (state) => ({
      ...state,
      bridge:
        tryBridgeFallback(state.raw, state.ctx, {
          onlyFailures: Boolean(state.opts?.onlyFailures),
        }) || null,
    }),
    (state) => {
      const out: string[] = [];
      const seen = new Set<string>();
      const pushUnique = (text?: string | null) => {
        if (!text) {
          return;
        }
        for (const line of text.split(/\r?\n/)) {
          const key = stripAnsiSimple(line);
          if (!seen.has(key)) {
            out.push(line);
            seen.add(key);
          }
        }
      };
      pushUnique(state.native);
      if (state.bridge) {
        if (out.length) {
          out.push('');
        }
        pushUnique(state.bridge);
      }
      return out.join('\n');
    },
  );

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
};

export const formatJestOutputVitest = (raw: string, opts?: FormatOpts): string =>
  pipe(
    { raw, opts },
    (state) => ({
      ...state,
      ctx: makeCtx(state.opts, /\bFAIL\b/.test(stripAnsiSimple(state.raw))),
    }),
    (state) => ({ ...state, chunks: parseChunks(state.raw) }),
    (state) => ({
      ...state,
      rendered: renderChunks(state.chunks, state.ctx, mkPrettyFns(), {
        onlyFailures: Boolean(state.opts?.onlyFailures),
      }),
    }),
    (state) => {
      if (state.rendered.hadParsed) {
        return state.rendered.text;
      }
      const fallback = tryBridgeFallback(state.raw, state.ctx, {
        onlyFailures: Boolean(state.opts?.onlyFailures),
      });
      if (!fallback) {
        return state.rendered.text;
      }
      const prefix = state.rendered.text;
      return prefix ? `${prefix}\n${fallback}` : fallback;
    },
  );

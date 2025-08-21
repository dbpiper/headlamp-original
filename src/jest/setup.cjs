/* eslint-disable global-require */
/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable import/no-dynamic-require */

(function setupBridge() {
  try {
    const print = (payload) => {
      try {
        const line = `[JEST-BRIDGE-EVENT] ${JSON.stringify(payload)}`;
        (process.stderr || process.stdout).write(`${line}\n`);
      } catch {}
    };

    const toErr = (x) => {
      try {
        return x instanceof Error ? x : new Error(String(x));
      } catch {
        return new Error('unknown');
      }
    };

    const getCtx = () => {
      try {
        const st =
          global.expect && typeof global.expect.getState === 'function'
            ? global.expect.getState()
            : {};
        return { testPath: st.testPath, currentTestName: st.currentTestName };
      } catch {
        return {};
      }
    };

    // Capture console output during tests
    try {
      const g = global;
      const levels = ['log', 'info', 'warn', 'error'];
      const originals = {};
      const maxEntries = 200;
      const toText = (args) => {
        try {
          return args.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ');
        } catch {
          return args.map(String).join(' ');
        }
      };
      if (!g.__JEST_CONSOLE_BUFFER__) g.__JEST_CONSOLE_BUFFER__ = [];
      for (const lvl of levels) {
        try {
          originals[lvl] =
            g.console[lvl] && g.console[lvl].bind ? g.console[lvl].bind(g.console) : g.console[lvl];
          g.console[lvl] = (...args) => {
            try {
              const buf = Array.isArray(g.__JEST_CONSOLE_BUFFER__)
                ? g.__JEST_CONSOLE_BUFFER__
                : (g.__JEST_CONSOLE_BUFFER__ = []);
              const msg = toText(args);
              buf.push({ type: lvl, message: msg, ts: Date.now() });
              if (buf.length > maxEntries) buf.splice(0, buf.length - maxEntries);
              const ctx = getCtx();
              print({ type: 'console', level: lvl, message: msg, ...ctx });
            } catch {}
            try {
              return originals[lvl](...args);
            } catch {
              return undefined;
            }
          };
        } catch {}
      }
    } catch {}

    // Process-level error hooks
    try {
      const onRej = (reason) => {
        const e = toErr(reason);
        const c = getCtx();
        print({
          type: 'unhandledRejection',
          name: e.name,
          message: e.message,
          stack: e.stack,
          code: e.code ?? undefined,
          ...c,
        });
      };
      const onExc = (error) => {
        const e = toErr(error);
        const c = getCtx();
        print({
          type: 'uncaughtException',
          name: e.name,
          message: e.message,
          stack: e.stack,
          code: e.code ?? undefined,
          ...c,
        });
      };
      process.on('unhandledRejection', onRej);
      process.on('uncaughtException', onExc);
    } catch {}

    // HTTP response patch
    try {
      const http = require('node:http');
      const PATCH_FLAG = Symbol.for('jestBridgePatched');
      const ORIGINAL_KEY = Symbol.for('jestBridgeOriginalEmit');
      const originalEmit =
        http &&
        http.Server &&
        http.Server.prototype &&
        typeof http.Server.prototype.emit === 'function'
          ? http.Server.prototype.emit
          : null;
      if (originalEmit && !http.Server.prototype.emit[PATCH_FLAG]) {
        const MAX = 64 * 1024;
        const asString = (x) => {
          try {
            if (typeof x === 'string') return x;
            if (Buffer.isBuffer(x)) return x.toString('utf8');
            return String(x);
          } catch {
            return '';
          }
        };
        const patched = function (eventName, req, res) {
          try {
            if (
              eventName === 'request' &&
              req &&
              res &&
              typeof res.write === 'function' &&
              typeof res.end === 'function'
            ) {
              const startAt = Date.now();
              const chunks = [];
              const write = res.write.bind(res);
              const end = res.end.bind(res);
              const method = req.method ? String(req.method) : undefined;
              const url =
                req.originalUrl || req.url ? String(req.originalUrl || req.url) : undefined;
              res.write = function (chunk, enc, cb) {
                try {
                  const s = asString(chunk);
                  if (s) chunks.push(s);
                } catch {}
                return write(chunk, enc, cb);
              };
              res.end = function (chunk, enc, cb) {
                try {
                  const s = asString(chunk);
                  if (s) chunks.push(s);
                } catch {}
                try {
                  const preview = chunks.join('').slice(0, MAX);
                  const statusCode =
                    typeof res.statusCode === 'number' ? res.statusCode : undefined;
                  const ctx = getCtx();
                  print({
                    type: 'httpResponse',
                    timestampMs: Date.now(),
                    durationMs: Math.max(0, Date.now() - startAt),
                    method,
                    url,
                    statusCode,
                    bodyPreview: preview,
                    ...ctx,
                  });
                } catch {}
                return end(chunk, enc, cb);
              };
              try {
                res.on('close', () => {
                  try {
                    const ended =
                      typeof res.writableEnded === 'boolean' ? res.writableEnded : false;
                    if (!ended) {
                      const ctx = getCtx();
                      print({
                        type: 'httpAbort',
                        timestampMs: Date.now(),
                        durationMs: Math.max(0, Date.now() - startAt),
                        method,
                        url,
                        ...ctx,
                      });
                    }
                  } catch {}
                });
              } catch {}
            }
          } catch {}
          return originalEmit.apply(this, arguments);
        };
        patched[PATCH_FLAG] = true;
        patched[ORIGINAL_KEY] = originalEmit;
        http.Server.prototype.emit = patched;
      }
    } catch {}
  } catch {}
})();

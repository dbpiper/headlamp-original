export const JEST_BRIDGE_ENV_SOURCE = `

'use strict';

const NodeEnvironment = require('jest-environment-node').TestEnvironment || require('jest-environment-node');

module.exports = class BridgeEnv extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    this._cleanup = [];
    try {
      const { AsyncLocalStorage } = require('async_hooks');
      this._als = new AsyncLocalStorage();
    } catch {
      this._als = { getStore() { return undefined; }, enterWith() {} };
    }
    try {
      const fs = require('node:fs');
      const dbgPath = process.env.JEST_BRIDGE_DEBUG_PATH;
      this._dbg = (msg) => {
        try {
          if (process.env.JEST_BRIDGE_DEBUG && dbgPath) fs.appendFileSync(dbgPath, String(msg) + '\n', 'utf8');
        } catch {}
      };
    } catch {}
  }

  _ctx() {
    try { const s = this._als.getStore(); if (s) return s; } catch {}
    try {
      const st = this.global.expect && typeof this.global.expect.getState === 'function' ? this.global.expect.getState() : {};
      return { testPath: st.testPath, currentTestName: st.currentTestName };
    } catch { return {}; }
  }

  async setup() {
    await super.setup();

    try { Error.stackTraceLimit = Math.max(Error.stackTraceLimit || 10, 50); } catch {}

    const print = (payload) => {
      try {
        const stderr =
          this.global && this.global.process && this.global.process.stderr
            ? this.global.process.stderr
            : process.stderr;
        let line = '[JEST-BRIDGE-EVENT] ';
        try {
          line += JSON.stringify(payload);
        } catch {
          line += JSON.stringify({ type: String(payload && payload.type || 'unknown') });
        }
        stderr.write(line + '\n');
      } catch {}
    };
    // Expose to class methods (e.g., handleTestEvent). Also keep a safe fallback.
    try { this._emitBridge = (p) => print(p); } catch {}
    const toErr = (x) => { try { return x instanceof Error ? x : new Error(String(x)); } catch { return new Error('unknown'); } };

    const onRej = (reason) => {
      const e = toErr(reason);
      const c = this._ctx();
      print({ type: 'unhandledRejection', name: e.name, message: e.message, stack: e.stack, code: e.code ?? undefined, ...c });
    };
    const onExc = (error) => {
      const e = toErr(error);
      const c = this._ctx();
      print({ type: 'uncaughtException', name: e.name, message: e.message, stack: e.stack, code: e.code ?? undefined, ...c });
    };

    this.global.process.on('unhandledRejection', onRej);
    this.global.process.on('uncaughtException', onExc);
    this._cleanup.push(() => {
      try {
        const proc = this.global && this.global.process ? this.global.process : process;
        const off = typeof proc.off === 'function' ? proc.off.bind(proc) : proc.removeListener.bind(proc);
        off('unhandledRejection', onRej);
        off('uncaughtException', onExc);
      } catch {}
    });

    // Signal environment readiness so we can confirm the custom env loaded
    try { const c = this._ctx(); print({ type: 'envReady', ...c }); } catch {}
    try { if (this._dbg) this._dbg('envReady'); } catch {}
    // Capture console output during tests and emit a batch per test case
    try {
      const g = this.global;
      const self = this;
      const levels = ['log', 'info', 'warn', 'error'];
      const originals = {};
      const maxEntries = 200;
      const toText = (args) => {
        try { return args.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' '); } catch { return args.map(String).join(' '); }
      };
      if (!g.__JEST_CONSOLE_BUFFER__) { g.__JEST_CONSOLE_BUFFER__ = []; }
      for (const lvl of levels) {
        try {
          originals[lvl] = g.console[lvl] && g.console[lvl].bind ? g.console[lvl].bind(g.console) : g.console[lvl];
          g.console[lvl] = (...args) => {
            try {
              const buf = Array.isArray(g.__JEST_CONSOLE_BUFFER__) ? g.__JEST_CONSOLE_BUFFER__ : (g.__JEST_CONSOLE_BUFFER__ = []);
              const msg = toText(args);
              buf.push({ type: lvl, message: msg, ts: Date.now() });
              if (buf.length > maxEntries) buf.splice(0, buf.length - maxEntries);
              try { const c = self._ctx(); print({ type: 'console', level: lvl, message: msg, ...c }); } catch {}
              try { if (self._dbg) { self._dbg('console:' + String(lvl) + ':' + String(msg).slice(0, 120)); } } catch {}
            } catch {}
            try { return originals[lvl](...args); } catch { return undefined; }
          };
        } catch {}
      }
      this._cleanup.push(() => {
        try { for (const lvl of levels) { if (originals[lvl]) g.console[lvl] = originals[lvl]; } } catch {}
      });
    } catch {}


    try {
      const http = require('http');

      const PATCH_FLAG = Symbol.for('jestBridgePatched');
      const ORIGINAL_KEY = Symbol.for('jestBridgeOriginalEmit');

      const originalEmit =
        http && http.Server && http.Server.prototype && typeof http.Server.prototype.emit === 'function'
          ? http.Server.prototype.emit
          : null;
      if (originalEmit) {
        // Skip if another worker has already patched it.
        if ((http.Server.prototype.emit)[PATCH_FLAG]) {
          try { this.global.__JEST_BRIDGE_ENV_REF = this; global.__JEST_BRIDGE_ENV_REF = this; } catch {}
          this._cleanup.push(() => {});
        } else {
        const MAX = 64 * 1024;
        const asString = (x) => { try { if (typeof x === 'string') return x; if (Buffer.isBuffer(x)) return x.toString('utf8'); return String(x); } catch { return ''; } };

        const patched = function(eventName, req, res) {
          try {
            if (eventName === 'request' && req && res && typeof res.write === 'function' && typeof res.end === 'function') {
              const startAt = Date.now();
              const safeHeader = (k) => { try { return req && req.headers ? String((req.headers[k.toLowerCase()] ?? '')) : ''; } catch { return ''; } };
              const reqIdHeader = safeHeader('x-request-id');
              const chunks = [];
              const write = res.write.bind(res);
              const end = res.end.bind(res);
              const method = req.method ? String(req.method) : undefined;
              const url = (req.originalUrl || req.url) ? String(req.originalUrl || req.url) : undefined;

              res.write = function(chunk, enc, cb) {
                try { const s = asString(chunk); if (s) chunks.push(s); } catch {}
                return write(chunk, enc, cb);
              };
              res.end = function(chunk, enc, cb) {
                try { const s = asString(chunk); if (s) chunks.push(s); } catch {}
                try {
                  const preview = chunks.join('').slice(0, MAX);
                  const statusCode = typeof res.statusCode === 'number' ? res.statusCode : undefined;
                  const ct = (typeof res.getHeader === 'function' && res.getHeader('content-type')) || undefined;
                  const routePath = (req && req.route && req.route.path) || (req && req.baseUrl && req.path ? (req.baseUrl + req.path) : undefined);
                  const jsonParsed = (() => { try { return JSON.parse(preview); } catch { return undefined; } })();
                  const requestId = reqIdHeader || (jsonParsed && typeof jsonParsed === 'object' ? (jsonParsed.requestId || jsonParsed.reqId || '') : '');
                  const ctx = (global.__JEST_BRIDGE_ENV_REF && global.__JEST_BRIDGE_ENV_REF._ctx) ? global.__JEST_BRIDGE_ENV_REF._ctx() : {};
                  const payload = {
                    type: 'httpResponse',
                    timestampMs: Date.now(),
                    durationMs: Math.max(0, Date.now() - startAt),
                    method, url, statusCode,
                    route: routePath ? String(routePath) : undefined,
                    contentType: ct ? String(ct) : undefined,
                    headers: (typeof res.getHeaders === 'function') ? res.getHeaders() : undefined,
                    requestId: requestId ? String(requestId) : undefined,
                    bodyPreview: preview,
                    json: jsonParsed,
                    testPath: ctx.testPath, currentTestName: ctx.currentTestName,
                  };
                  try {
                    if (!global.__JEST_HTTP_EVENTS__) global.__JEST_HTTP_EVENTS__ = [];
                    const arr = global.__JEST_HTTP_EVENTS__;
                    arr.push({ timestampMs: payload.timestampMs, durationMs: payload.durationMs, method: payload.method, url: payload.url, route: payload.route, statusCode: payload.statusCode, contentType: payload.contentType, requestId: payload.requestId, json: payload.json, bodyPreview: payload.bodyPreview });
                    if (arr.length > 25) arr.splice(0, arr.length - 25);
                  } catch {}
                  try { print(payload); } catch {}
                } catch {}
                return end(chunk, enc, cb);
              };
              try {
                res.on('close', function onClose() {
                  try {
                    const ended = typeof res.writableEnded === 'boolean' ? res.writableEnded : false;
                    if (!ended) {
                      const routePath = (req && req.route && req.route.path) || (req && req.baseUrl && req.path ? (req.baseUrl + req.path) : undefined);
                      const ctx = (global.__JEST_BRIDGE_ENV_REF && global.__JEST_BRIDGE_ENV_REF._ctx) ? global.__JEST_BRIDGE_ENV_REF._ctx() : {};
                      const payload = {
                        type: 'httpAbort',
                        timestampMs: Date.now(),
                        durationMs: Math.max(0, Date.now() - startAt),
                        method, url,
                        route: routePath ? String(routePath) : undefined,
                        testPath: ctx.testPath, currentTestName: ctx.currentTestName,
                      };
                      try { print(payload); } catch {}
                    }
                  } catch {}
                });
              } catch {}
            }
          } catch {}
          return originalEmit.apply(this, arguments);
        };

        try { this.global.__JEST_BRIDGE_ENV_REF = this; global.__JEST_BRIDGE_ENV_REF = this; } catch {}

        (patched)[PATCH_FLAG] = true;
        (patched)[ORIGINAL_KEY] = originalEmit;
        http.Server.prototype.emit = patched;

        this._cleanup.push(() => {
          try {
            if (http.Server && http.Server.prototype && typeof http.Server.prototype.emit === 'function') {
              const current = http.Server.prototype.emit;
              if (current && current[PATCH_FLAG]) {
                const orig = current[ORIGINAL_KEY] || originalEmit;
                if (typeof orig === 'function') http.Server.prototype.emit = orig;
              }
            }
          } catch {}
          try { delete this.global.__JEST_BRIDGE_ENV_REF; } catch {}
        });
        }
      }
    } catch {}

    // Wrap test functions to emit rich assertion events on failures
    try {
      const g = this.global;
      const ctxFn = () => {
        try {
          const ref = g.__JEST_BRIDGE_ENV_REF;
          return ref && typeof ref._ctx === 'function' ? ref._ctx() : {};
        } catch { return {}; }
      };
      const emitAssertion = (err) => {
        try {
          const e = toErr(err);
          const mr = e && typeof e === 'object' && e.matcherResult ? e.matcherResult : undefined;
          const messageText = (() => { try { return mr && typeof mr.message === 'function' ? String(mr.message()) : (e.message || ''); } catch { return e.message || ''; } })();
          const expectedPreview = (() => { try { return mr && mr.expected !== undefined ? JSON.stringify(mr.expected, null, 2) : undefined; } catch { return undefined; } })();
          const actualPreview = (() => { try { return mr && mr.received !== undefined ? JSON.stringify(mr.received, null, 2) : undefined; } catch { return undefined; } })();
          const c = ctxFn();
          print({
            type: 'assertionFailure',
            timestampMs: Date.now(),
            matcher: mr && typeof mr.matcherName === 'string' ? mr.matcherName : undefined,
            expectedPreview,
            actualPreview,
            expectedNumber: typeof (mr && mr.expected) === 'number' ? mr.expected : undefined,
            receivedNumber: typeof (mr && mr.received) === 'number' ? mr.received : undefined,
            message: messageText,
            stack: e.stack,
            ...c,
          });
        } catch {}
      };
      const wrap = (orig) => {
        if (!orig || typeof orig !== 'function') return orig;
        const wrapped = function(name, fn, timeout) {
          if (typeof fn !== 'function') return orig.call(this, name, fn, timeout);
          const run = function() {
            try {
              const res = fn.apply(this, arguments);
              if (res && typeof res.then === 'function') {
                return res.catch((err) => { emitAssertion(err); throw err; });
              }
              return res;
            } catch (err) {
              emitAssertion(err);
              throw err;
            }
          };
          return orig.call(this, name, run, timeout);
        };
        try { wrapped.only = orig.only && typeof orig.only === 'function' ? wrap(orig.only) : orig.only; } catch {}
        try { wrapped.skip = orig.skip && typeof orig.skip === 'function' ? wrap(orig.skip) : orig.skip; } catch {}
        return wrapped;
      };
      try { g.it = wrap(g.it); } catch {}
      try { g.test = wrap(g.test); } catch {}
    } catch {}
  }

  async handleTestEvent(evt, state) {
    if (evt && evt.name === 'test_start') {
      const tn = evt.test && evt.test.name ? evt.test.name : undefined;
      const store = { testPath: state && state.testPath ? state.testPath : undefined, currentTestName: tn };
      try { this._als && typeof this._als.enterWith === 'function' && this._als.enterWith(store); } catch {}
    } else if (evt && evt.name === 'test_done') {
      try { this._als && typeof this._als.enterWith === 'function' && this._als.enterWith({}); } catch {}

      // Flush HTTP batch (global buffer)
      try {
        const events = Array.isArray(global.__JEST_HTTP_EVENTS__) ? global.__JEST_HTTP_EVENTS__ : [];
        if (events.length) {
          const batch = events.slice(-10);
          const payload = { type: 'httpResponseBatch', events: batch, testPath: state && state.testPath ? state.testPath : undefined, currentTestName: evt.test && evt.test.name ? evt.test.name : undefined };
          try { this._emitBridge && this._emitBridge(payload); } catch {}
          try { global.__JEST_HTTP_EVENTS__ = []; } catch {}
        }
      } catch {}

      // Flush console batch (sandbox buffer)
      try {
        const buf = Array.isArray(this.global.__JEST_CONSOLE_BUFFER__) ? this.global.__JEST_CONSOLE_BUFFER__ : [];
        if (buf.length) {
          const payload = { type: 'consoleBatch', entries: buf.slice(-200), testPath: state && state.testPath ? state.testPath : undefined, currentTestName: (evt.test && evt.test.name) ? evt.test.name : undefined };
          try { this._emitBridge && this._emitBridge(payload); } catch {}
          try { this.global.__JEST_CONSOLE_BUFFER__ = []; } catch {}
          try { this._dbg && this._dbg('consoleBatch:' + String(buf.length)); } catch {}
        }
      } catch {}
    }
  }

  async teardown() {
    for (let i = this._cleanup.length - 1; i >= 0; i--) {
      try { this._cleanup[i](); } catch {}
    }
    try { delete global.__JEST_BRIDGE_ENV_REF; } catch {}
    await super.teardown();
  }
};
`;

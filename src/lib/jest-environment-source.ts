export const JEST_BRIDGE_ENV_SOURCE = `
'use strict';

const NodeEnvironment = require('jest-environment-node').TestEnvironment || require('jest-environment-node');

module.exports = class BridgeEnv extends NodeEnvironment {
  constructor(config, context) {
    super(config, context);
    const { AsyncLocalStorage } = require('node:async_hooks');
    this._als = new AsyncLocalStorage();
    this._cleanup = [];
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

    const print = (payload) => { try { this.global.console.error('[JEST-BRIDGE-EVENT]', JSON.stringify(payload)); } catch {} };
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
      this.global.process.off('unhandledRejection', onRej);
      this.global.process.off('uncaughtException', onExc);
    });

    // Signal environment readiness so we can confirm the custom env loaded
    try { const c = this._ctx(); print({ type: 'envReady', ...c }); } catch {}

    try {
      const http = this.global.require ? this.global.require('http') : require('http');
      const originalEmit = http && http.Server && http.Server.prototype && http.Server.prototype.emit;
      if (originalEmit) {
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
                  try { console.error('[JEST-BRIDGE-EVENT]', JSON.stringify(payload)); } catch {}
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
                      try { console.error('[JEST-BRIDGE-EVENT]', JSON.stringify(payload)); } catch {}
                    }
                  } catch {}
                });
              } catch {}
            }
          } catch {}
          return originalEmit.apply(this, arguments);
        };

        try { this.global.__JEST_BRIDGE_ENV_REF = this; } catch {}
        http.Server.prototype.emit = patched;

        this._cleanup.push(() => {
          try { if (http.Server && http.Server.prototype) http.Server.prototype.emit = originalEmit; } catch {}
          try { delete this.global.__JEST_BRIDGE_ENV_REF; } catch {}
        });
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
          const expectedRaw = (() => { try { return mr?.expected; } catch { return undefined; } })();
          const receivedRaw = (() => { try { return mr?.received; } catch { return undefined; } })();
          print({
            type: 'assertionFailure',
            timestampMs: Date.now(),
            matcher: mr && typeof mr.matcherName === 'string' ? mr.matcherName : undefined,
            expectedPreview,
            actualPreview,
            expectedNumber: typeof expectedRaw === 'number' ? expectedRaw : undefined,
            receivedNumber: typeof receivedRaw === 'number' ? receivedRaw : undefined,
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
    if (evt.name === 'test_start') {
      const store = { testPath: state.testPath, currentTestName: evt.test.name };
      try { this._als.enterWith(store); } catch {}
    } else if (evt.name === 'test_done') {
      try { this._als.enterWith({}); } catch {}
      try {
        const events = Array.isArray(global.__JEST_HTTP_EVENTS__) ? global.__JEST_HTTP_EVENTS__ : [];
        if (events.length) {
          const batch = events.slice(-10);
          const payload = { type: 'httpResponseBatch', events: batch, testPath: state.testPath, currentTestName: evt.test.name };
          try { this.global.console.error('[JEST-BRIDGE-EVENT]', JSON.stringify(payload)); } catch {}
          try { global.__JEST_HTTP_EVENTS__ = []; } catch {}
        }
      } catch {}
    }
  }

  async teardown() {
    for (let i = this._cleanup.length - 1; i >= 0; i--) {
      try { this._cleanup[i](); } catch {}
    }
    await super.teardown();
  }
};
`;

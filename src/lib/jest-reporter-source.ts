export const JEST_BRIDGE_REPORTER_SOURCE = `const fs = require('fs');
const path = require('path');

const isObject = (v) => typeof v === 'object' && v !== null;
const sanitizeError = (err) => {
  if (!isObject(err)) return err;
  const out = {};
  const name = err.name || (err.constructor && err.constructor.name) || undefined;
  if (name) out.name = String(name);
  if (typeof err.message === 'string') out.message = err.message;
  if (typeof err.stack === 'string') out.stack = err.stack;
  if (err.code !== undefined) out.code = err.code;
  if (err.expected !== undefined) out.expected = err.expected;
  if (err.received !== undefined) out.received = err.received;
  if (err.matcherResult && isObject(err.matcherResult)) {
    const mr = err.matcherResult;
    let messageText;
    try {
      messageText = typeof mr.message === 'function' ? String(mr.message()) : (typeof mr.message === 'string' ? mr.message : undefined);
    } catch {}
    out.matcherResult = {
      matcherName: typeof mr.matcherName === 'string' ? mr.matcherName : undefined,
      message: messageText,
      stack: typeof mr.stack === 'string' ? mr.stack : undefined,
      expected: mr.expected,
      received: mr.received,
      actual: mr.actual,
      pass: typeof mr.pass === 'boolean' ? mr.pass : undefined,
    };
  }
  if (err.cause) {
    out.cause = sanitizeError(err.cause);
  }
  // Copy own enumerable props to preserve custom data
  try {
    for (const key of Object.keys(err)) {
      if (!(key in out)) out[key] = err[key];
    }
  } catch {}
  return out;
};
const sanitizeDetail = (d) => {
  if (typeof d === 'string') return d;
  if (!isObject(d)) return d;
  // Common Jest detail shapes
  const out = {};
  if (d.message) out.message = d.message;
  if (d.stack) out.stack = d.stack;
  if (d.error) out.error = sanitizeError(d.error);
  if (d.matcherResult) out.matcherResult = sanitizeError({ matcherResult: d.matcherResult }).matcherResult;
  if (d.expected !== undefined) out.expected = d.expected;
  if (d.received !== undefined) out.received = d.received;
  // Copy the rest
  try {
    for (const key of Object.keys(d)) {
      if (!(key in out)) out[key] = d[key];
    }
  } catch {}
  return out;
};

class BridgeReporter {
  constructor(globalConfig, options) {
    this.out = process.env.JEST_BRIDGE_OUT || (options && options.outFile) || path.join(process.cwd(), 'coverage', 'jest-run.json');
    this.buf = { startTime: Date.now(), testResults: [], aggregated: null };
  }
  onRunStart() { this.buf.startTime = Date.now(); }
  onTestResult(_test, tr) {
    const mapAssertion = (a) => ({
      title: a.title,
      fullName: a.fullName || [...(a.ancestorTitles || []), a.title].join(' '),
      status: a.status,
      duration: a.duration || 0,
      location: a.location || null,
      failureMessages: (a.failureMessages || []).map(String),
      failureDetails: (a.failureDetails || []).map(sanitizeDetail),
    });
    this.buf.testResults.push({
      testFilePath: tr.testFilePath,
      status: tr.numFailingTests ? 'failed' : 'passed',
      failureMessage: tr.failureMessage || '',
      failureDetails: (tr.failureDetails || []).map(sanitizeDetail),
      testExecError: tr.testExecError ? sanitizeError(tr.testExecError) : null,
      console: tr.console || null,
      perfStats: tr.perfStats || {},
      testResults: (tr.testResults || []).map(mapAssertion),
    });
  }
  onRunComplete(_contexts, agg) {
    this.buf.aggregated = {
      numTotalTestSuites: agg.numTotalTestSuites,
      numPassedTestSuites: agg.numPassedTestSuites,
      numFailedTestSuites: agg.numFailedTestSuites,
      numTotalTests: agg.numTotalTests,
      numPassedTests: agg.numPassedTests,
      numFailedTests: agg.numFailedTests,
      numPendingTests: agg.numPendingTests,
      numTodoTests: agg.numTodoTests,
      startTime: agg.startTime,
      success: agg.success,
      runTimeMs: agg.testResults.reduce((t, r) => t + Math.max(0, (r.perfStats?.end || 0) - (r.perfStats?.start || 0)), 0),
    };
    fs.mkdirSync(path.dirname(this.out), { recursive: true });
    fs.writeFileSync(this.out, JSON.stringify(this.buf), 'utf8');
  }
}
module.exports = BridgeReporter;`;

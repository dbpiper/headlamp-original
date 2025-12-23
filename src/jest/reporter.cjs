/* eslint-disable global-require */
/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable import/no-dynamic-require */

const fs = require('node:fs');
const path = require('node:path');

const print = (payload) => {
  try {
    const line = `[JEST-BRIDGE-EVENT] ${JSON.stringify(payload)}`;
    (process.stderr || process.stdout).write(`${line}\n`);
  } catch {}
};

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
      messageText =
        typeof mr.message === 'function'
          ? String(mr.message())
          : typeof mr.message === 'string'
            ? mr.message
            : undefined;
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
  if (d.matcherResult) {
    out.matcherResult = sanitizeError({ matcherResult: d.matcherResult }).matcherResult;
  }
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
    this.out =
      process.env.JEST_BRIDGE_OUT ||
      (options && options.outFile) ||
      path.join(process.cwd(), 'coverage', 'jest-run.json');
    this.buf = { startTime: Date.now(), testResults: [], aggregated: null };
  }

  onRunStart() {
    this.buf.startTime = Date.now();
  }

  onTestResult(_test, tr) {
    const readConsoleEntries = (testResult) => {
      try {
        const c = testResult && testResult.console ? testResult.console : null;
        if (c && typeof c.getBuffer === 'function') {
          const buf = c.getBuffer();
          return Array.isArray(buf) ? buf : null;
        }
        return Array.isArray(c) ? c : null;
      } catch {
        return null;
      }
    };

    const mapAssertion = (a) => ({
      title: a.title,
      fullName: a.fullName || [...(a.ancestorTitles || []), a.title].join(' '),
      status: a.status,
      timedOut: Boolean(
        a.status === 'failed' &&
          String(a.failureMessages || '')
            .toLowerCase()
            .includes('timed out'),
      ),
      duration: a.duration || 0,
      location: a.location || null,
      failureMessages: (a.failureMessages || []).map(String),
      failureDetails: (a.failureDetails || []).map(sanitizeDetail),
    });
    this.buf.testResults.push({
      testFilePath: tr.testFilePath,
      // Consider suite-level errors as failures even when no individual assertions failed
      status:
        (tr && typeof tr.numFailingTests === 'number' && tr.numFailingTests > 0) ||
        Boolean(tr.testExecError) ||
        Boolean(tr.failureMessage)
          ? 'failed'
          : 'passed',
      timedOut: Boolean(
        (tr.testExecError &&
          /timed out/i.test(
            String(tr.testExecError && (tr.testExecError.message || tr.testExecError)),
          )) ||
          /timed out/i.test(String(tr.failureMessage || '')),
      ),
      failureMessage: tr.failureMessage || '',
      failureDetails: (tr.failureDetails || []).map(sanitizeDetail),
      testExecError: tr.testExecError ? sanitizeError(tr.testExecError) : null,
      console: readConsoleEntries(tr),
      perfStats: tr.perfStats || {},
      testResults: (tr.testResults || []).map(mapAssertion),
    });
    try {
      print({
        type: 'suiteComplete',
        testPath: tr.testFilePath,
        numPassingTests: tr.numPassingTests,
        numFailingTests: tr.numFailingTests,
      });
    } catch {}
  }

  onRunComplete(_contexts, agg) {
    // Compute timed out counts heuristically from test results & errors
    const suiteTimedOut = (r) =>
      Boolean(
        (r.testExecError &&
          /timed out/i.test(
            String(r.testExecError && (r.testExecError.message || r.testExecError)),
          )) ||
          /timed out/i.test(String(r.failureMessage || '')),
      );
    const fileTimeouts = this.buf.testResults.filter(suiteTimedOut);
    const testTimeouts = this.buf.testResults
      .flatMap((r) => r.testResults || [])
      .filter((a) => a && a.timedOut);
    // Recompute suite pass/fail counts to include suite-level errors/timeouts
    const totalSuites = typeof agg.numTotalTestSuites === 'number' ? agg.numTotalTestSuites : 0;
    const failedSuites = this.buf.testResults.filter(
      (r) => r.status === 'failed' || r.testExecError || r.failureMessage,
    ).length;
    const passedSuites = Math.max(0, totalSuites - failedSuites);
    const failedAssertions = typeof agg.numFailedTests === 'number' ? agg.numFailedTests : 0;
    const suiteOnlyFailures = Math.max(0, failedSuites - failedAssertions);
    const failedTestsInclSuiteErrors = failedAssertions + suiteOnlyFailures;

    this.buf.aggregated = {
      numTotalTestSuites: totalSuites,
      numPassedTestSuites: passedSuites,
      numFailedTestSuites: failedSuites,
      numTotalTests: agg.numTotalTests,
      numPassedTests: agg.numPassedTests,
      numFailedTests: failedTestsInclSuiteErrors,
      numPendingTests: agg.numPendingTests,
      numTodoTests: agg.numTodoTests,
      numTimedOutTests: testTimeouts.length,
      numTimedOutTestSuites: fileTimeouts.length,
      startTime: agg.startTime,
      success:
        Boolean(agg.success) &&
        failedSuites === 0 &&
        failedTestsInclSuiteErrors === 0 &&
        fileTimeouts.length === 0,
      runTimeMs: agg.testResults.reduce(
        (t, r) => t + Math.max(0, (r.perfStats?.end || 0) - (r.perfStats?.start || 0)),
        0,
      ),
    };
    fs.mkdirSync(path.dirname(this.out), { recursive: true });
    fs.writeFileSync(this.out, JSON.stringify(this.buf), 'utf8');
  }
}

module.exports = BridgeReporter;

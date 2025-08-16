import * as path from 'node:path';

export const extractBridgePath = (raw: string, cwd: string): string | null => {
  const matches = Array.from(
    raw.matchAll(/Test results written to:\s+([^\n\r]+jest-bridge-[^\s'"]+\.json)/g),
  );
  if (!matches.length) {
    return null;
  }
  const jsonPath = (matches[matches.length - 1]![1] ?? '').trim().replace(/^['"`]|['"`]$/g, '');
  return path.isAbsolute(jsonPath) ? jsonPath : path.resolve(cwd, jsonPath).replace(/\\/g, '/');
};

export const isTransportError = (msg?: string): boolean => {
  const lowercaseMessage = (msg ?? '').toLowerCase();
  return /\bsocket hang up\b|\beconnreset\b|\betimedout\b|\beconnrefused\b|\bwrite epipe\b/.test(
    lowercaseMessage,
  );
};

export const parseMethodPathFromTitle = (title?: string): { method?: string; path?: string } => {
  if (!title) {
    return {};
  }
  const matchResult = title.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+([^\s)]+)/i);
  return matchResult ? { method: matchResult[1]?.toUpperCase(), path: matchResult[2] } : {};
};

export const routeSimilarityScore = (
  hint: { method?: string; path?: string },
  evt: { method?: string; route?: string; url?: string },
): number => {
  if (!hint.path && !hint.method) {
    return 0;
  }
  const methodOk = hint.method && evt.method ? Number(hint.method === evt.method) : 0;
  const route = evt.route || evt.url || '';
  if (!route) {
    return methodOk * 10;
  }
  if (hint.path && route === hint.path) {
    return 500 + methodOk * 50;
  }
  if (hint.path && route.endsWith(hint.path)) {
    return 300 + methodOk * 50;
  }
  if (hint.path && route.includes(hint.path)) {
    return 200 + methodOk * 50;
  }
  return methodOk * 10;
};

export type HttpEvent = {
  readonly timestampMs: number;
  readonly kind?: 'response' | 'abort';
  readonly method?: string;
  readonly url?: string;
  readonly route?: string;
  readonly statusCode?: number;
  readonly durationMs?: number;
  readonly contentType?: string;
  readonly requestId?: string;
  readonly json?: unknown;
  readonly bodyPreview?: string;
  readonly testPath?: string;
  readonly currentTestName?: string;
};

export type AssertionEvt = {
  readonly timestampMs?: number;
  readonly matcher?: string;
  readonly expectedNumber?: number;
  readonly receivedNumber?: number;
  readonly message?: string;
  readonly stack?: string;
  readonly testPath?: string;
  readonly currentTestName?: string;
  readonly expectedPreview?: string;
  readonly actualPreview?: string;
};

export const isHttpStatusNumber = (statusNumber?: number): boolean =>
  typeof statusNumber === 'number' && statusNumber >= 100 && statusNumber <= 599;

// ---- Env-backed knobs ----
export const envNumber = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const HEADLAMP_HTTP_WINDOW_MS = () => envNumber('HEADLAMP_HTTP_WINDOW_MS', 3000);
export const HEADLAMP_HTTP_STRICT_WINDOW_MS = () =>
  envNumber('HEADLAMP_HTTP_STRICT_WINDOW_MS', 600);
export const HEADLAMP_HTTP_MIN_SCORE = () => envNumber('HEADLAMP_HTTP_MIN_SCORE', 1200);
export const HEADLAMP_HTTP_DIFF_LIMIT = () => envNumber('HEADLAMP_HTTP_DIFF_LIMIT', 6);
export const HEADLAMP_HTTP_SHOW_MISS = () => process.env.HEADLAMP_HTTP_MISS === '1';

export const eventsNear = (
  http: readonly HttpEvent[],
  ts?: number,
  testPath?: string,
  windowMs = HEADLAMP_HTTP_WINDOW_MS(),
): readonly HttpEvent[] => {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return [];
  }
  return http.filter((event) => {
    const timeOk =
      typeof event.timestampMs === 'number' && Math.abs(event.timestampMs - ts) <= windowMs;
    const pathOk = !testPath || event.testPath === testPath;
    return timeOk && pathOk;
  });
};

export const scoreHttpForAssertion =
  (assertion: AssertionEvt, titleHint: { method?: string; path?: string }) =>
  (candidateEvent: HttpEvent): number => {
    const tsA = assertion.timestampMs;
    const tsH = candidateEvent.timestampMs;
    const window = isTransportError(assertion.message)
      ? HEADLAMP_HTTP_STRICT_WINDOW_MS()
      : HEADLAMP_HTTP_WINDOW_MS();
    const timeScore =
      typeof tsA === 'number' && typeof tsH === 'number'
        ? Math.max(0, window - Math.abs(tsA - tsH))
        : 0;

    const statusScore =
      typeof assertion.receivedNumber === 'number' &&
      candidateEvent.statusCode === assertion.receivedNumber
        ? 1500
        : typeof assertion.expectedNumber === 'number' &&
            candidateEvent.statusCode === assertion.expectedNumber
          ? 1200
          : (candidateEvent.statusCode ?? 0) >= 400
            ? 800
            : 0;

    const routeScore = routeSimilarityScore(titleHint, candidateEvent);
    const specificity = candidateEvent.route ? 80 : candidateEvent.url ? 40 : 0;

    return timeScore + statusScore + routeScore + specificity;
  };

export const pickRelevantHttp = (
  assertion: AssertionEvt,
  http: readonly HttpEvent[],
  ctx: { readonly testPath?: string; readonly currentTestName?: string; readonly title?: string },
): HttpEvent | undefined => {
  const hint = parseMethodPathFromTitle(ctx.title);
  const nameMatches = (leftName?: string, rightName?: string) =>
    !!leftName &&
    !!rightName &&
    (leftName === rightName || leftName.includes(rightName) || rightName.includes(leftName));
  const sameTest = (
    leftCtx?: { testPath?: string; currentTestName?: string },
    rightCtx?: { testPath?: string; currentTestName?: string },
  ) =>
    !!leftCtx &&
    !!rightCtx &&
    leftCtx.testPath === rightCtx.testPath &&
    nameMatches(leftCtx.currentTestName, rightCtx.currentTestName);

  const strictPool = http.filter(
    (httpEvent) => sameTest(assertion as any, httpEvent as any) || sameTest(ctx, httpEvent as any),
  );

  const windowMs = isTransportError(assertion.message)
    ? HEADLAMP_HTTP_STRICT_WINDOW_MS()
    : HEADLAMP_HTTP_WINDOW_MS();

  let pool = strictPool;
  if (!pool.length) {
    pool = http.filter((event) => {
      const samePath = event.testPath === ctx.testPath;
      const tsA = assertion.timestampMs;
      const tsH = event.timestampMs;
      const inWindow =
        typeof tsA === 'number' && typeof tsH === 'number' && Math.abs(tsH - tsA) <= windowMs;
      return samePath && inWindow;
    });
  }
  if (!pool.length) {
    pool = http.filter((event) => {
      const tsA = assertion.timestampMs;
      const tsH = event.timestampMs;
      return typeof tsA === 'number' && typeof tsH === 'number' && Math.abs(tsH - tsA) <= windowMs;
    });
  }
  if (!pool.length) {
    return undefined;
  }

  const scored = pool
    .map((httpEvent) => ({ h: httpEvent, s: scoreHttpForAssertion(assertion, hint)(httpEvent) }))
    .sort((leftScore, rightScore) => rightScore.s - leftScore.s);

  const [best] = scored;
  const threshold = isTransportError(assertion.message)
    ? Math.max(HEADLAMP_HTTP_MIN_SCORE(), 1400)
    : HEADLAMP_HTTP_MIN_SCORE();
  return best && best.s >= threshold ? best.h : undefined;
};

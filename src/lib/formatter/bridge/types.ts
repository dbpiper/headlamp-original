export type BridgeJSON = {
  readonly startTime: number;
  readonly testResults: ReadonlyArray<{
    readonly testFilePath: string;
    readonly status: 'passed' | 'failed';
    readonly timedOut?: boolean;
    readonly failureMessage: string;
    readonly failureDetails?: readonly unknown[];
    readonly testExecError?: unknown | null;
    readonly console?: ReadonlyArray<{ message?: string; type?: string; origin?: string }> | null;
    readonly testResults: ReadonlyArray<{
      readonly title: string;
      readonly fullName: string;
      readonly status: string;
      readonly timedOut?: boolean;
      readonly duration: number;
      readonly location: { readonly line: number; readonly column: number } | null;
      readonly failureMessages: string[];
      readonly failureDetails?: readonly unknown[];
    }>;
  }>;
  readonly aggregated: {
    readonly numTotalTestSuites: number;
    readonly numPassedTestSuites: number;
    readonly numFailedTestSuites: number;
    readonly numTotalTests: number;
    readonly numPassedTests: number;
    readonly numFailedTests: number;
    readonly numPendingTests: number;
    readonly numTodoTests: number;
    readonly numTimedOutTests?: number;
    readonly numTimedOutTestSuites?: number;
    readonly startTime: number;
    readonly success: boolean;
    readonly runTimeMs?: number;
  };
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

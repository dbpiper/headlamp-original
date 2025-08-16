export type BridgeJSON = {
  readonly startTime: number;
  readonly testResults: ReadonlyArray<{
    readonly testFilePath: string;
    readonly status: 'passed' | 'failed';
    readonly failureMessage: string;
    readonly failureDetails?: readonly unknown[];
    readonly testExecError?: unknown | null;
    readonly console?: ReadonlyArray<{ message?: string; type?: string; origin?: string }> | null;
    readonly testResults: ReadonlyArray<{
      readonly title: string;
      readonly fullName: string;
      readonly status: string;
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
    readonly startTime: number;
    readonly success: boolean;
    readonly runTimeMs?: number;
  };
};

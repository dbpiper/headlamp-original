export type Loc = { readonly file: string; readonly line: number };

export type Chunk =
  | { readonly tag: 'FailureBlock'; readonly title: string; readonly lines: ReadonlyArray<string> }
  | { readonly tag: 'PassFail'; readonly badge: 'PASS' | 'FAIL'; readonly rel: string }
  | { readonly tag: 'Summary'; readonly line: string }
  | { readonly tag: 'Stack'; readonly line: string }
  | { readonly tag: 'Other'; readonly line: string };

export type SourceReader = (absPath: string) => ReadonlyArray<string>;

export type Ctx = {
  readonly cwd: string;
  readonly width: number;
  readonly projectHint: RegExp;
  readonly showStacks: boolean;
  readonly editorCmd: string | undefined;
  readonly readSource: SourceReader;
};

export type RenderCtxSmall = {
  readonly projectHint: RegExp;
  readonly editorCmd: string | undefined;
  readonly showStacks: boolean;
};

export type PrettyFns = {
  readonly drawRule: (label?: string) => string;
  readonly drawFailLine: () => string;
  readonly renderRunLine: (cwd: string) => string;
  readonly buildPerFileOverview: (
    rel: string,
    assertions: ReadonlyArray<{ readonly fullName: string; readonly status: string }>,
  ) => string[];
  readonly buildFileBadgeLine: (rel: string, failedCount: number) => string;
  readonly extractBridgePath: (raw: string, cwd: string) => string | null;
  readonly buildCodeFrameSection: (
    messageLines: readonly string[],
    ctx: RenderCtxSmall,
    synthLoc?: { file: string; line: number } | null,
  ) => string[];
  readonly buildMessageSection: (
    messageLines: readonly string[],
    details: { stacks: string[]; messages: string[] },
    ctx: RenderCtxSmall,
    opts?: { suppressDiff?: boolean; stackPreview?: readonly string[] },
  ) => string[];
  readonly buildPrettyDiffSection: (
    details?: readonly unknown[],
    messageLines?: readonly string[],
  ) => string[];
  readonly buildFallbackMessageBlock?: (
    messageLines: readonly string[],
    details: { messages: readonly string[] },
  ) => string[];
  readonly buildThrownSection?: (details: readonly unknown[]) => string[];
  readonly buildStackSection?: (
    mergedForStack: readonly string[],
    ctx: RenderCtxSmall,
    fallbackLoc?: { file: string; line: number } | null,
  ) => string[];
  readonly deepestProjectLoc: (
    stackLines: readonly string[],
    projectHint: RegExp,
  ) => { file: string; line: number } | null;
  readonly findCodeFrameStart: (lines: readonly string[]) => number;
  readonly linesFromDetails: (details: readonly unknown[] | undefined) => {
    stacks: string[];
    messages: string[];
  };
};

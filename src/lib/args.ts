import * as path from 'node:path';

export type Action =
  | { readonly type: 'coverage'; readonly coverageValue: boolean }
  | { readonly type: 'coverageUi'; readonly value: 'jest' | 'both' }
  | { readonly type: 'coverageAbortOnFailure'; readonly value: boolean }
  | { readonly type: 'jestArg'; readonly value: string }
  | { readonly type: 'jestArgs'; readonly values: readonly string[] }
  | { readonly type: 'vitestArg'; readonly value: string }
  | { readonly type: 'bothArg'; readonly value: string }
  | { readonly type: 'selectionHint' }
  | { readonly type: 'coverageInclude'; readonly values: readonly string[] }
  | { readonly type: 'coverageExclude'; readonly values: readonly string[] }
  | { readonly type: 'coverageEditor'; readonly value: string }
  | { readonly type: 'coverageRoot'; readonly value: string }
  | { readonly type: 'selectionPath'; readonly value: string }
  | { readonly type: 'coverageDetail'; readonly value?: number | 'all' }
  | { readonly type: 'coverageShowCode'; readonly value: boolean }
  | { readonly type: 'coverageMode'; readonly value: 'compact' | 'full' }
  | { readonly type: 'coverageMaxFiles'; readonly value: number }
  | { readonly type: 'coverageMaxHotspots'; readonly value: number }
  | { readonly type: 'coveragePageFit'; readonly value: boolean }
  | { readonly type: 'changed'; readonly value: ChangedMode };

export type ChangedMode = 'all' | 'staged' | 'unstaged';

export const ActionBuilders = {
  coverage: (coverageValue: boolean): Action => ({ type: 'coverage', coverageValue }),
  coverageUi: (value: 'jest' | 'both'): Action => ({ type: 'coverageUi', value }),
  coverageAbortOnFailure: (value: boolean): Action => ({ type: 'coverageAbortOnFailure', value }),
  jestArg: (value: string): Action => ({ type: 'jestArg', value }),
  jestArgs: (values: readonly string[]): Action => ({ type: 'jestArgs', values }),
  vitestArg: (value: string): Action => ({ type: 'vitestArg', value }),
  bothArg: (value: string): Action => ({ type: 'bothArg', value }),
  selectionHint: (): Action => ({ type: 'selectionHint' }),
  coverageInclude: (values: readonly string[]): Action => ({ type: 'coverageInclude', values }),
  coverageExclude: (values: readonly string[]): Action => ({ type: 'coverageExclude', values }),
  coverageEditor: (value: string): Action => ({ type: 'coverageEditor', value }),
  coverageRoot: (value: string): Action => ({ type: 'coverageRoot', value }),
  selectionPath: (value: string): Action => ({ type: 'selectionPath', value }),
  coverageDetail: (value?: number | 'all'): Action =>
    value !== undefined ? { type: 'coverageDetail', value } : { type: 'coverageDetail' },
  coverageShowCode: (value: boolean): Action => ({ type: 'coverageShowCode', value }),
  coverageMode: (value: 'compact' | 'full'): Action => ({ type: 'coverageMode', value }),
  coverageMaxFiles: (value: number): Action => ({ type: 'coverageMaxFiles', value }),
  coverageMaxHotspots: (value: number): Action => ({ type: 'coverageMaxHotspots', value }),
  coveragePageFit: (value: boolean): Action => ({ type: 'coveragePageFit', value }),
  changed: (value: ChangedMode): Action => ({ type: 'changed', value }),
} as const;

type State = { actions: Action[]; skipNext: boolean };
export type Step = readonly [readonly Action[], boolean];
export type RuleEnv = { readonly lookahead?: string; readonly jestFlags: ReadonlySet<string> };
type Opt<T> = { readonly _tag: 'some'; readonly value: T } | { readonly _tag: 'none' };
const Some = <T>(value: T): Opt<T> => ({ _tag: 'some', value });
const None: Opt<never> = { _tag: 'none' } as const;
const isSome = <T>(opt: Opt<T>): opt is { readonly _tag: 'some'; readonly value: T } =>
  opt._tag === 'some';

const step = (actions: readonly Action[], skipNext: boolean = false): Step =>
  [actions, skipNext] as const;

export type Rule = (value: string, env: RuleEnv) => Opt<Step>;
export const rule = {
  when:
    (
      predicate: (value: string, env: RuleEnv) => boolean,
      build: (value: string, env: RuleEnv) => Step,
    ): Rule =>
    (value, env) =>
      predicate(value, env) ? Some(build(value, env)) : None,
  eq: (flag: string, build: () => Step): Rule =>
    rule.when(
      (value) => value === flag,
      () => build(),
    ),
  startsWith: (prefix: string, build: (value: string) => Step): Rule =>
    rule.when(
      (value) => value.startsWith(prefix),
      (value) => build(value),
    ),
  inSet: (select: (env: RuleEnv) => ReadonlySet<string>, build: (value: string) => Step): Rule =>
    rule.when(
      (value, env) => select(env).has(value),
      (value) => build(value),
    ),
  withLookahead: (
    lookaheadFlag: string,
    build: (flagToken: string, lookahead: string) => Step,
  ): Rule =>
    rule.when(
      (value, env) =>
        value === lookaheadFlag && typeof env.lookahead === 'string' && env.lookahead.length > 0,
      (value, env) => build(value, env.lookahead!),
    ),
} as const;

const STRING_EMPTY = '' as const;
const STRING_TRUE = 'true' as const;
const STRING_ONE = '1' as const;
const INDEX_STEP = 1 as const;

export const isTruthy = (value: string): boolean =>
  value === STRING_TRUE || value === STRING_ONE || value === STRING_EMPTY;

export const parseActionsFromTokens = (tokens: readonly string[]): readonly Action[] => {
  const jestOnlyFlags = new Set(['--ci', '--detectOpenHandles', '--forceExit', '--runInBand']);

  const parseCoverageUiString = (raw: string): 'jest' | 'both' => {
    const normalized = String(raw).toLowerCase();
    return normalized === 'jest' ? 'jest' : 'both';
  };

  const rules: readonly Rule[] = [
    // --coverage (enable), and --coverage=true/false
    rule.eq('--coverage', () => step([ActionBuilders.coverage(true)])),
    rule.startsWith('--coverage=', (value) =>
      step([ActionBuilders.coverage(isTruthy((value.split('=')[1] ?? '').trim().toLowerCase()))]),
    ),
    // --coverage.abortOnFailure
    rule.eq('--coverage.abortOnFailure', () => step([ActionBuilders.coverageAbortOnFailure(true)])),
    rule.startsWith('--coverage.abortOnFailure=', (value) =>
      step([
        ActionBuilders.coverageAbortOnFailure(
          isTruthy((value.split('=')[1] ?? '').trim().toLowerCase()),
        ),
      ]),
    ),
    rule.withLookahead('--coverage.abortOnFailure', (_flag, lookahead) =>
      step([ActionBuilders.coverageAbortOnFailure(isTruthy(String(lookahead)))], true),
    ),
    rule.startsWith('--coverage-ui=', (value) =>
      step([ActionBuilders.coverageUi(parseCoverageUiString(value.split('=')[1] ?? 'both'))]),
    ),
    rule.startsWith('--coverageUi=', (value) =>
      step([ActionBuilders.coverageUi(parseCoverageUiString(value.split('=')[1] ?? 'both'))]),
    ),
    rule.withLookahead('--coverage-ui', (_flag, lookahead) =>
      step([ActionBuilders.coverageUi(parseCoverageUiString(String(lookahead)))], true),
    ),
    rule.withLookahead('--coverageUi', (_flag, lookahead) =>
      step([ActionBuilders.coverageUi(parseCoverageUiString(String(lookahead)))], true),
    ),

    rule.eq('--coverage.detail', () => step([ActionBuilders.coverageDetail()])),
    rule.startsWith('--coverage.detail=', (value) => {
      const raw = (value.split('=')[1] ?? '').trim().toLowerCase();
      const parsed = raw === 'all' ? 'all' : Number.isFinite(Number(raw)) ? Number(raw) : undefined;
      return step([ActionBuilders.coverageDetail(parsed)]);
    }),
    rule.withLookahead('--coverage.detail', (_flag, lookahead) => {
      const raw = String(lookahead).trim().toLowerCase();
      const parsed = raw === 'all' ? 'all' : Number.isFinite(Number(raw)) ? Number(raw) : undefined;
      return step([ActionBuilders.coverageDetail(parsed)], true);
    }),

    rule.eq('--coverage.showCode', () => step([ActionBuilders.coverageShowCode(true)])),
    rule.startsWith('--coverage.showCode=', (value) => {
      const flagValue = (value.split('=')[1] ?? '').trim().toLowerCase();
      return step([
        ActionBuilders.coverageShowCode(
          flagValue === 'true' || flagValue === '1' || flagValue === '',
        ),
      ]);
    }),
    rule.withLookahead('--coverage.showCode', (_flag, lookahead) =>
      step([ActionBuilders.coverageShowCode(isTruthy(String(lookahead)))], true),
    ),

    rule.startsWith('--coverage.mode=', (value) => {
      const raw = (value.split('=')[1] ?? '').trim().toLowerCase();
      const mode = raw === 'compact' ? 'compact' : 'full';
      return step([ActionBuilders.coverageMode(mode)]);
    }),
    rule.withLookahead('--coverage.mode', (_flag, lookahead) =>
      step(
        [
          ActionBuilders.coverageMode(
            String(lookahead).trim().toLowerCase() === 'compact' ? 'compact' : 'full',
          ),
        ],
        true,
      ),
    ),
    rule.eq('--coverage.compact', () => step([ActionBuilders.coverageMode('compact')])),

    rule.startsWith('--coverage.maxFiles=', (value) => {
      const maxFilesCount = Number(value.split('=')[1] ?? '');
      return step(
        Number.isFinite(maxFilesCount) ? [ActionBuilders.coverageMaxFiles(maxFilesCount)] : [],
      );
    }),
    rule.startsWith('--coverage.maxHotspots=', (value) => {
      const maxHotspotsCount = Number(value.split('=')[1] ?? '');
      return step(
        Number.isFinite(maxHotspotsCount)
          ? [ActionBuilders.coverageMaxHotspots(maxHotspotsCount)]
          : [],
      );
    }),
    rule.eq('--coverage.pageFit', () => step([ActionBuilders.coveragePageFit(true)])),
    rule.startsWith('--coverage.pageFit=', (value) =>
      step([
        ActionBuilders.coveragePageFit(isTruthy((value.split('=')[1] ?? '').trim().toLowerCase())),
      ]),
    ),
    rule.withLookahead('--coverage.pageFit', (_flag, lookahead) =>
      step([ActionBuilders.coveragePageFit(isTruthy(String(lookahead)))], true),
    ),

    rule.withLookahead('--testPathPattern', (flag, lookahead) =>
      step([ActionBuilders.jestArgs([flag, lookahead])], true),
    ),
    rule.startsWith('--testPathPattern=', (value) => step([ActionBuilders.jestArg(value)])),
    rule.inSet(
      (env) => env.jestFlags,
      (value) => step([ActionBuilders.jestArg(value)]),
    ),

    rule.when(
      (value) => value === '--watch' || value === '-w',
      () => step([ActionBuilders.vitestArg('--watch'), ActionBuilders.jestArg('--watch')]),
    ),
    rule.eq('--watchAll', () => step([ActionBuilders.jestArg('--watchAll')])),

    rule.startsWith('--coverage.include=', (value) =>
      step([
        ActionBuilders.coverageInclude(
          (value.split('=')[1] ?? '')
            .split(',')
            .map((segment) => segment.trim())
            .filter(Boolean),
        ),
      ]),
    ),
    rule.withLookahead('--coverage.include', (_flag, lookahead) =>
      step(
        [
          ActionBuilders.coverageInclude(
            lookahead
              .split(',')
              .map((segment) => segment.trim())
              .filter(Boolean),
          ),
        ],
        true,
      ),
    ),
    rule.startsWith('--coverage.exclude=', (value) =>
      step([
        ActionBuilders.coverageExclude(
          (value.split('=')[1] ?? '')
            .split(',')
            .map((segment) => segment.trim())
            .filter(Boolean),
        ),
      ]),
    ),
    rule.withLookahead('--coverage.exclude', (_flag, lookahead) =>
      step(
        [
          ActionBuilders.coverageExclude(
            lookahead
              .split(',')
              .map((segment) => segment.trim())
              .filter(Boolean),
          ),
        ],
        true,
      ),
    ),
    rule.startsWith('--coverage.editor=', (value) =>
      step([ActionBuilders.coverageEditor((value.split('=')[1] ?? '').trim())]),
    ),
    rule.startsWith('--coverage.root=', (value) =>
      step([ActionBuilders.coverageRoot((value.split('=')[1] ?? '').trim())]),
    ),

    // --changed flag: selects changed files via git (all|staged|unstaged)
    rule.eq('--changed', () => step([ActionBuilders.changed('all')])),
    rule.startsWith('--changed=', (value) => {
      const raw = (value.split('=')[1] ?? '').trim().toLowerCase();
      const mode: ChangedMode =
        raw === 'staged' ? 'staged' : raw === 'unstaged' ? 'unstaged' : 'all';
      return step([ActionBuilders.changed(mode)]);
    }),
    rule.withLookahead('--changed', (_flag, lookahead) => {
      const raw = String(lookahead).trim().toLowerCase();
      const mode: ChangedMode =
        raw === 'staged' ? 'staged' : raw === 'unstaged' ? 'unstaged' : 'all';
      return step([ActionBuilders.changed(mode)], true);
    }),

    rule.withLookahead('-t', (flag, lookahead) =>
      step(
        [
          ActionBuilders.bothArg(flag),
          ActionBuilders.bothArg(lookahead),
          ActionBuilders.selectionHint(),
        ],
        true,
      ),
    ),
    rule.withLookahead('--testNamePattern', (flag, lookahead) =>
      step(
        [
          ActionBuilders.bothArg(flag),
          ActionBuilders.bothArg(lookahead),
          ActionBuilders.selectionHint(),
        ],
        true,
      ),
    ),
  ] as const;

  const init: State = { actions: [], skipNext: false };

  const final = tokens.reduce<State>((state, token, index) => {
    if (state.skipNext) {
      return { actions: state.actions, skipNext: false };
    }
    const tokenValue = token ?? STRING_EMPTY;
    const nextToken = tokens[index + INDEX_STEP];
    let env: RuleEnv = { jestFlags: jestOnlyFlags };
    if (typeof nextToken === 'string' && nextToken.length > 0) {
      env = { jestFlags: jestOnlyFlags, lookahead: nextToken };
    }

    const firstMatch = (rs: readonly Rule[], value: string, envForRules: RuleEnv) => {
      for (const ruleFn of rs) {
        const match = ruleFn(value, envForRules);
        if (isSome(match)) {
          return match;
        }
      }
      return None as Opt<Step>;
    };

    const matched = firstMatch(rules, tokenValue, env);

    const isTestFileToken = (candidate: string) =>
      /\.(test|spec)\.[tj]sx?$/.test(candidate) || /(^|\/)tests?\//.test(candidate);
    const isPathLike = (candidate: string) =>
      /[\\/]/.test(candidate) || /\.(m?[tj]sx?)$/i.test(candidate);

    const [matchedActions, shouldSkipNext] = isSome(matched)
      ? matched.value
      : (() => {
          const base = [ActionBuilders.bothArg(tokenValue)];
          const withSelection =
            isTestFileToken(tokenValue) || isPathLike(tokenValue)
              ? [
                  ...base,
                  ActionBuilders.selectionHint(),
                  ...(isPathLike(tokenValue) ? [ActionBuilders.selectionPath(tokenValue)] : []),
                ]
              : base;
          return step(withSelection);
        })();

    return { actions: [...state.actions, ...matchedActions], skipNext: shouldSkipNext };
  }, init);

  return final.actions as readonly Action[];
};

export type ParsedArgs = {
  readonly vitestArgs: readonly string[];
  readonly jestArgs: readonly string[];
  readonly collectCoverage: boolean;
  readonly coverageUi: 'jest' | 'both';
  readonly coverageAbortOnFailure: boolean;
  readonly selectionSpecified: boolean;
  readonly selectionPaths: readonly string[];
  readonly includeGlobs: readonly string[];
  readonly excludeGlobs: readonly string[];
  readonly editorCmd?: string;
  readonly workspaceRoot?: string;
  readonly coverageDetail?: number | 'all' | 'auto';
  readonly coverageShowCode: boolean;
  readonly coverageMode: 'compact' | 'full' | 'auto';
  readonly coverageMaxFiles?: number;
  readonly coverageMaxHotspots?: number;
  readonly coveragePageFit: boolean;
  readonly changed?: ChangedMode;
};

type Contrib = {
  readonly vitest: readonly string[];
  readonly jest: readonly string[];
  readonly coverage: boolean;
  readonly coverageUi?: ParsedArgs['coverageUi'];
  readonly coverageAbortOnFailure?: boolean;
  readonly selection?: boolean;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly editorCmd?: string;
  readonly workspaceRoot?: string;
  readonly selectionPaths?: readonly string[];
  readonly coverageDetail?: number | 'all' | 'auto';
  readonly coverageShowCode?: boolean;
  readonly coverageMode?: 'compact' | 'full' | 'auto';
  readonly coverageMaxFiles?: number;
  readonly coverageMaxHotspots?: number;
  readonly coveragePageFit?: boolean;
  readonly changed?: ChangedMode;
};

const emptyContrib: Contrib = {
  vitest: [],
  jest: [],
  coverage: false,
  coverageDetail: 'auto',
  coverageMode: 'auto',
};

const toContrib = (action: Action): Contrib => {
  switch (action.type) {
    case 'coverage':
      return { vitest: [], jest: [], coverage: action.coverageValue };
    case 'coverageUi':
      return { vitest: [], jest: [], coverage: false, coverageUi: action.value };
    case 'coverageAbortOnFailure':
      return { vitest: [], jest: [], coverage: false, coverageAbortOnFailure: action.value };
    case 'jestArgs':
      return { vitest: [], jest: action.values, coverage: false };
    case 'selectionHint':
      return { vitest: [], jest: [], coverage: false, selection: true };
    case 'coverageInclude':
      return { vitest: [], jest: [], coverage: false, include: action.values };
    case 'coverageExclude':
      return { vitest: [], jest: [], coverage: false, exclude: action.values };
    case 'coverageEditor':
      return { vitest: [], jest: [], coverage: false, editorCmd: action.value };
    case 'coverageRoot':
      return { vitest: [], jest: [], coverage: false, workspaceRoot: action.value };
    case 'selectionPath':
      return { vitest: [], jest: [], coverage: false, selectionPaths: [action.value] };
    case 'coverageDetail': {
      const detailValue: Contrib['coverageDetail'] = action.value ?? 'auto';
      return { vitest: [], jest: [], coverage: false, coverageDetail: detailValue };
    }
    case 'coverageShowCode':
      return { vitest: [], jest: [], coverage: false, coverageShowCode: action.value };
    case 'coverageMode':
      return { vitest: [], jest: [], coverage: false, coverageMode: action.value };
    case 'coverageMaxFiles':
      return { vitest: [], jest: [], coverage: false, coverageMaxFiles: action.value };
    case 'coverageMaxHotspots':
      return { vitest: [], jest: [], coverage: false, coverageMaxHotspots: action.value };
    case 'coveragePageFit':
      return { vitest: [], jest: [], coverage: false, coveragePageFit: action.value };
    case 'changed':
      return { vitest: [], jest: [], coverage: false, changed: action.value };
    case 'jestArg':
      return { vitest: [], jest: [action.value], coverage: false };
    case 'vitestArg':
      return { vitest: [action.value], jest: [], coverage: false };
    case 'bothArg':
      return { vitest: [action.value], jest: [action.value], coverage: false };
    default: {
      const neverGuard: never = action;
      return neverGuard;
    }
  }
};

export const combineContrib = (left: Contrib, right: Contrib): Contrib => {
  const base: Contrib = {
    vitest: left.vitest.concat(right.vitest),
    jest: left.jest.concat(right.jest),
    coverage: left.coverage || right.coverage,
    include: [...(left.include ?? []), ...(right.include ?? [])],
    exclude: [...(left.exclude ?? []), ...(right.exclude ?? [])],
    selection: Boolean(left.selection || right.selection),
    selectionPaths: [...(left.selectionPaths ?? []), ...(right.selectionPaths ?? [])],
  };
  const next: Contrib = { ...base } as Contrib;
  const editor = right.editorCmd ?? left.editorCmd;
  if (editor !== undefined) {
    (next as unknown as { editorCmd: string }).editorCmd = editor;
  }
  const root = right.workspaceRoot ?? left.workspaceRoot;
  if (root !== undefined) {
    (next as unknown as { workspaceRoot: string }).workspaceRoot = root;
  }
  if (right.coverageUi !== undefined) {
    return { ...next, coverageUi: right.coverageUi } as Contrib;
  }
  if (left.coverageUi !== undefined) {
    return { ...next, coverageUi: left.coverageUi } as Contrib;
  }
  return {
    ...next,
    ...(right.changed !== undefined || left.changed !== undefined
      ? { changed: right.changed ?? left.changed }
      : {}),
    ...(right.coverageAbortOnFailure !== undefined || left.coverageAbortOnFailure !== undefined
      ? { coverageAbortOnFailure: right.coverageAbortOnFailure ?? left.coverageAbortOnFailure }
      : {}),
    ...(right.coverageDetail !== undefined || left.coverageDetail !== undefined
      ? { coverageDetail: right.coverageDetail ?? left.coverageDetail }
      : {}),
    ...(right.coverageShowCode !== undefined || left.coverageShowCode !== undefined
      ? { coverageShowCode: right.coverageShowCode ?? left.coverageShowCode }
      : {}),
    ...(right.coverageMode !== undefined || left.coverageMode !== undefined
      ? { coverageMode: right.coverageMode ?? left.coverageMode }
      : {}),
    ...(right.coverageMaxFiles !== undefined || left.coverageMaxFiles !== undefined
      ? { coverageMaxFiles: right.coverageMaxFiles ?? left.coverageMaxFiles }
      : {}),
    ...(right.coverageMaxHotspots !== undefined || left.coverageMaxHotspots !== undefined
      ? { coverageMaxHotspots: right.coverageMaxHotspots ?? left.coverageMaxHotspots }
      : {}),
    ...(right.coveragePageFit !== undefined || left.coveragePageFit !== undefined
      ? { coveragePageFit: right.coveragePageFit ?? left.coveragePageFit }
      : {}),
  } as Contrib;
};

export const DEFAULT_INCLUDE = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'] as const;
export const DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/coverage/**',
  '**/dist/**',
  '**/build/**',
  '**/migrations/**',
  '**/__mocks__/**',
] as const;

export const deriveArgs = (argv: readonly string[]): ParsedArgs => {
  const vitestArgs: string[] = ['run'];
  const jestArgs: string[] = ['--detectOpenHandles', '--forceExit', '--runInBand'];
  let collectCoverage = false;
  let coverageUi: ParsedArgs['coverageUi'] = 'both';
  let coverageAbortOnFailure = false;
  let coverageShowCode = Boolean(process.stdout.isTTY);
  let coverageMode: ParsedArgs['coverageMode'] = 'auto';
  const coverageMaxFilesLocalInit: number | undefined = undefined;
  const coverageMaxHotspotsLocalInit: number | undefined = undefined;
  let coverageMaxFilesLocal: number | undefined = coverageMaxFilesLocalInit;
  let coverageMaxHotspotsLocal: number | undefined = coverageMaxHotspotsLocalInit;
  let coveragePageFit = Boolean(process.stdout.isTTY);

  const uiEnv = (process.env.COVERAGE_UI ?? '').toLowerCase();
  if (uiEnv === 'both' || uiEnv === 'jest') {
    coverageUi = uiEnv as ParsedArgs['coverageUi'];
  }

  const contrib = parseActionsFromTokens(argv).map(toContrib).reduce(combineContrib, emptyContrib);
  vitestArgs.push(...contrib.vitest);
  jestArgs.push(...contrib.jest);
  collectCoverage ||= contrib.coverage;
  coverageUi = contrib.coverageUi ?? coverageUi;
  coverageAbortOnFailure = contrib.coverageAbortOnFailure ?? coverageAbortOnFailure;
  coverageShowCode = contrib.coverageShowCode ?? coverageShowCode;
  const coverageDetailComputed: ParsedArgs['coverageDetail'] | undefined =
    contrib.coverageDetail ?? (contrib.selection ? 'auto' : undefined);
  coverageMode = contrib.coverageMode ?? (contrib.selection ? 'compact' : 'auto');
  coverageMaxFilesLocal = contrib.coverageMaxFiles ?? coverageMaxFilesLocal;
  coverageMaxHotspotsLocal = contrib.coverageMaxHotspots ?? coverageMaxHotspotsLocal;
  coveragePageFit = contrib.coveragePageFit ?? coveragePageFit;

  if (collectCoverage) {
    jestArgs.push(
      '--coverage',
      '--coverageProvider=babel',
      '--coverageReporters=lcov',
      '--coverageReporters=json',
      '--coverageReporters=text-summary',
      '--coverageDirectory=coverage/jest',
    );
  }

  const selectionLooksLikeTestPath = (contrib.selectionPaths ?? []).some(
    (selectionPath) =>
      /\.(test|spec)\.[tj]sx?$/i.test(selectionPath) || /(^|\/)tests?\//i.test(selectionPath),
  );
  const inferredFromSelection = (contrib.selectionPaths ?? [])
    .map((pathToken) => {
      const normalized = path.normalize(pathToken).replace(/\\/g, '/');
      const isDir = !/\.(m?[tj]sx?)$/i.test(normalized);
      const base = isDir
        ? normalized.replace(/\/+$/, '')
        : path.dirname(normalized).replace(/\\/g, '/');
      return base.length ? `${base}/**/*` : '**/*';
    })
    .filter((glob, index, arr) => arr.indexOf(glob) === index);

  const includeGlobs = (contrib.include ?? []).length
    ? (contrib.include as string[])
    : selectionLooksLikeTestPath
      ? [...DEFAULT_INCLUDE]
      : inferredFromSelection.length
        ? inferredFromSelection
        : [...DEFAULT_INCLUDE];
  const excludeGlobs = (contrib.exclude ?? []).length
    ? (contrib.exclude as string[])
    : [...DEFAULT_EXCLUDE];

  const out: ParsedArgs = {
    vitestArgs,
    jestArgs,
    collectCoverage,
    coverageUi,
    coverageAbortOnFailure,
    selectionSpecified: Boolean(contrib.selection),
    selectionPaths: [...(contrib.selectionPaths ?? [])],
    includeGlobs,
    excludeGlobs,
    coverageShowCode,
    ...(coverageDetailComputed !== undefined ? { coverageDetail: coverageDetailComputed } : {}),
    coverageMode,
    ...(coverageMaxFilesLocal !== undefined ? { coverageMaxFiles: coverageMaxFilesLocal } : {}),
    ...(coverageMaxHotspotsLocal !== undefined
      ? { coverageMaxHotspots: coverageMaxHotspotsLocal }
      : {}),
    coveragePageFit,
    ...(contrib.editorCmd !== undefined ? { editorCmd: contrib.editorCmd } : {}),
    ...(contrib.workspaceRoot !== undefined ? { workspaceRoot: contrib.workspaceRoot } : {}),
    ...(contrib.changed !== undefined ? { changed: contrib.changed } : {}),
  };
  return out;
};

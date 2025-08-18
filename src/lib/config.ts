import { loadConfig } from 'c12';

export type ChangedMode = 'all' | 'staged' | 'unstaged' | 'branch' | 'lastCommit';

export type HeadlampConfig = {
  readonly bootstrapCommand?: string;
  readonly coverage?: boolean;
  readonly coverageUi?: 'jest' | 'both';
  readonly coverageAbortOnFailure?: boolean;
  readonly onlyFailures?: boolean;
  readonly showLogs?: boolean;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly editorCmd?: string;
  readonly workspaceRoot?: string;
  readonly coverageDetail?: number | 'all' | 'auto';
  readonly coverageShowCode?: boolean;
  readonly coverageMode?: 'compact' | 'full' | 'auto';
  readonly coverageMaxFiles?: number;
  readonly coverageMaxHotspots?: number;
  readonly coveragePageFit?: boolean;
  readonly changed?: 'all' | 'staged' | 'unstaged' | 'branch' | 'lastCommit';
  readonly jestArgs?: readonly string[];
  readonly vitestArgs?: readonly string[];
  // New nested contextual sections (preferred)
  readonly coverageSection?: {
    readonly abortOnFailure?: boolean;
    readonly mode?: 'compact' | 'full' | 'auto';
    readonly pageFit?: boolean;
  };
  readonly changedSection?: {
    readonly depth?: number;
  } & Partial<Record<ChangedMode, { readonly depth?: number }>>;
};

export const loadHeadlampConfig = async (): Promise<HeadlampConfig> => {
  const { config } = await loadConfig<HeadlampConfig>({
    name: 'headlamp',
    defaults: {},
  });
  return (config || {}) as HeadlampConfig;
};

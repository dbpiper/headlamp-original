# Headlamp CLI

Coverage-first, runner-agnostic test UX for Jest/Vitest. Delegates execution to your runner, focuses on better selection and coverage insights.

## Install

Only in /Users/david/src/headlamp/src/lib: PLACEHOLDER
Only in /Users/david/src/headlamp/src/lib: \_exec.ts
Files /Users/david/src/gigworx-node/scripts/cli/coverage-print.ts and /Users/david/src/headlamp/src/lib/coverage-print.ts differ
Files /Users/david/src/gigworx-node/scripts/cli/discovery.ts and /Users/david/src/headlamp/src/lib/discovery.ts differ
Only in /Users/david/src/headlamp/src/lib: env-utils.ts
Only in /Users/david/src/headlamp/src/lib: fast-related.ts
Files /Users/david/src/gigworx-node/scripts/cli/graph-distance.ts and /Users/david/src/headlamp/src/lib/graph-distance.ts differ
Files /Users/david/src/gigworx-node/scripts/cli/index.ts and /Users/david/src/headlamp/src/lib/index.ts differ
Files /Users/david/src/gigworx-node/scripts/cli/program.ts and /Users/david/src/headlamp/src/lib/program.ts differ

## Usage

removed
removed

- Delegates to your local Jest/Vitest install
- Renders improved coverage tables and hotspots
- Selects tests by import-graph when you pass production paths

## Why

- Keep Jest/Vitest as-is. Get a better UI/UX for coverage and selection.

## Status

Alpha. API/CLI flags may change.
und hotspots

- `--coverage.mode=compact|full|auto`: compact table vs full per-file details
- `--coverage.maxFiles`, `--coverage.maxHotspots`: limit rows to fit your terminal
- `--coverage.pageFit=true|false`: adapt output to terminal rows

Pass all your regular Jest flags (e.g. `-t`, `--testNamePattern`, paths). Headlamp strips/adjusts coverage-related flags when listing tests.

## Configuration

Headlamp supports a project-level config file. The config is explicit and contextual:

- Base defaults: always applied (safe, non-surprising)
- Coverage-context defaults: only applied if coverage is active (i.e., you passed `--coverage` or you set `coverage: true` in config)
- Changed-context defaults: only applied if changed selection is active (i.e., you passed `--changed=…` or set a default mode in config)

CLI always overrides config. No environment variables or hidden presets are used.

### Supported filenames (repo root)

- `headlamp.config.ts`
- `headlamp.config.js` / `headlamp.config.mjs` / `headlamp.config.cjs`
- `headlamp.config.json` / `headlamp.config.yaml` / `headlamp.config.yml`

### Base defaults (always applied)

These are applied to every run and should be non-controversial project choices:

- `bootstrapCommand: string` – command or npm script to run before tests
- `jestArgs: string[]` – extra args passed to Jest (e.g., `['--runInBand']`)

Example:

```ts
// headlamp.config.ts
export default {
  bootstrapCommand: 'test:jest:bootstrap',
  jestArgs: ['--runInBand'],
};
```

### Coverage-context defaults

Applied only when coverage is active (triggered by `--coverage` on the CLI or `coverage: true` in config). Prefer the nested `coverage` section:

```ts
export default {
  coverage: {
    abortOnFailure: true, // -> --coverage.abortOnFailure
    mode: 'auto', // -> --coverage.mode=auto
    pageFit: true, // -> --coverage.pageFit=true
  },
};
```

Optional extras (honored when coverage is active):

- `editorCmd` -> `--coverage.editor`
- `include: string[]` -> `--coverage.include=a,b,c`
- `exclude: string[]` -> `--coverage.exclude=a,b,c`
- `coverageDetail: number | 'all' | 'auto'` -> `--coverage.detail`
- `coverageShowCode: boolean` -> `--coverage.showCode`
- `coverageMaxFiles: number` -> `--coverage.maxFiles`
- `coverageMaxHotspots: number` -> `--coverage.maxHotspots`

Back-compat: legacy top-level fields (`coverageAbortOnFailure`, `coverageMode`, `coveragePageFit`, etc.) are still recognized, but the nested `coverage` section is preferred.

### Changed-context defaults

Applied only when changed selection is active (triggered by `--changed=…` on the CLI, or by specifying a default mode in config). Prefer the nested `changed` section:

```ts
export default {
  changed: {
    depth: 20, // default depth for all modes -> --changed.depth=20
    branch: {
      depth: 10, // per-mode override when --changed=branch
    },
    staged: {
      depth: 8,
    },
    unstaged: {
      depth: 6,
    },
    all: {
      depth: 12,
    },
  },
};
```

If you also want to enforce a default mode for everyone, you can set a string at the legacy top-level: `changed: 'branch'`. Headlamp will emit `--changed=branch` unless the CLI already specified a mode. Otherwise, prefer to let scripts opt-in on the CLI and keep config focused on depth/details.

### Precedence and gating rules

- CLI always wins. If you pass `--coverage.mode=full`, it overrides the config’s `coverage.mode`.
- Coverage extras only apply when coverage is active.
- Changed depth only applies when changed selection is active. If a per‑mode depth exists, it’s used; otherwise we fall back to the default `changed.depth`.

### Example configs and scripts

Config (headlamp.config.ts):

```ts
export default {
  // Base
  bootstrapCommand: 'test:jest:bootstrap',
  jestArgs: ['--runInBand'],

  // Coverage-context
  coverage: {
    abortOnFailure: true,
    mode: 'auto',
    pageFit: true,
  },

  // Changed-context
  changed: {
    depth: 20,
    branch: { depth: 10 },
  },
};
```

Scripts:

```json
{
  "scripts": {
    "test": "headlamp --runInBand",
    "test:coverage": "headlamp --coverage --runInBand",
    "test:dev": "npm run test -- --changed=branch --coverage --onlyFailures"
  }
}
```

Resulting behavior:

- `headlamp --runInBand`: base defaults only; no coverage/changed extras.
- `headlamp --coverage --runInBand`: applies coverage abortOnFailure/mode/pageFit; changed depth is not applied.
- `headlamp --changed=branch --coverage --onlyFailures`: applies per‑mode changed depth (10) and coverage group; `onlyFailures` is opt‑in via CLI.

## Examples

- Show coverage with detailed hotspots, auto-fit to terminal rows:

```bash
npx headlamp --coverage
```

- Focus on specific production files and run only directly-related tests:

```bash
npx headlamp --coverage src/services/user.ts src/components/UserCard.tsx
```

## Bootstrap command

Use `--bootstrapCommand` to run setup work before tests (e.g., database migrations/seeding). If omitted, no bootstrap runs.

- Single token value is treated as an npm script name and run as `npm run -s <name>`.
- Values containing whitespace are treated as full commands and executed via the system shell.

Examples:

```bash
# 1) Run an npm script before tests
npx headlamp --bootstrapCommand test:jest:bootstrap

# 2) Run an npm script with its own args
npx headlamp --bootstrapCommand "db:migrate -- --reset"

# 3) Run an arbitrary command (e.g., sequelize migrations for test env)
npx headlamp --bootstrapCommand "sequelize db:migrate --env test"

# 4) Seed a test database via a node script
npx headlamp --bootstrapCommand "node scripts/seed-test-db.js"
```

This bootstrap step executes once before Jest is started. If the bootstrap exits non‑zero, the run aborts with an error.

## Output flags

- `--onlyFailures[=true|false]`:
  - When enabled, the CLI prints only failing tests during execution across all views, while still printing the final test summary (files/tests/time) at the end.
  - Supported forms: `--onlyFailures`, `--onlyFailures=true`, `--onlyFailures=false`.
  - Works with other selection flags (e.g., `-t`, `--changed`).

Examples:

```bash
# Show only failures during the run, but still print the final summary
npx headlamp --onlyFailures

# Combine with changed-file selection
npx headlamp --changed --onlyFailures
```

- `--showLogs[=true|false]`:
  - When enabled, Headlamp prints a dedicated "Logs" section under each failing test and failing file with the full console output captured by the runner.
  - By default (without this flag), Headlamp shows a condensed "Console errors" snippet with only the most relevant error messages. `--showLogs` includes all console entries (log/info/warn/error).
  - Supported forms: `--showLogs`, `--showLogs=true`, `--showLogs=false`.
  - Works alongside `--onlyFailures`, coverage flags, and selection flags.

Examples:

```bash
# Always include the full console output for each failure
npx headlamp --showLogs

# Combine with only failures visible during the run
npx headlamp --onlyFailures --showLogs
```

## Changed-file selection

- `--changed[=mode]` selects tests by files changed in your working tree or branch.
  - Modes:
    - `all` (default when `--changed` is passed without a value): includes staged + unstaged + untracked files.
    - `staged`: only staged changes.
    - `unstaged`: only unstaged + untracked files.
    - `branch`: union of
      - files changed on the current branch relative to the default branch (via merge-base), and
      - your current uncommitted changes (staged, unstaged tracked, and untracked files).
      - Default branch is resolved via `origin/HEAD` when available, falling back to `origin/main` or `origin/master`.
    - `lastCommit`: files changed in the last commit (`git diff --name-only HEAD^ HEAD`). Useful on main to scope to the most recent change.
  - Effects:
    - Uses changed production files as seeds to discover related tests by import-graph.
    - Coverage tables prioritize and annotate files related to selection/changed files.
  - Additional flags:
    - `--changed.depth=<n>`: cap the transitive import scan depth when refining related tests from changed production files. Default: 5. Increase to include more indirectly-related tests (slower), decrease for speed.

Examples:

```bash
# Staged changes only
npx headlamp --changed=staged

# All working tree changes
npx headlamp --changed

# Diff current branch against default branch (merge-base)
npx headlamp --changed=branch

# Combine with coverage
npx headlamp --coverage --changed=branch
```

Depth examples:

```bash
# Scan imports up to 10 levels deep when resolving related tests for changed files
npx headlamp --changed=all --changed.depth=10

# With branch mode
npx headlamp --changed=branch --changed.depth=12
```

## Coverage flags

- `--coverage`: enables coverage collection and prints merged coverage output after test execution. Uses your project's Jest/Vitest setup and reads coverage JSON from Jest.
  - Prints a compact per-file table with hotspots and optionally detailed per-file breakdowns.
  - Honors file selection and include/exclude globs when rendering coverage tables.
  - When `--changed` is specified, coverage views factor in those changed files as selection seeds, influencing relevancy ordering and the “changed-related” highlighting.
- `--coverage.abortOnFailure`: if tests fail, exit immediately with the test exit code and skip coverage printing. Useful in CI when failures should short-circuit.
- `--coverage.ui=jest|both`:
  - `jest`: write Istanbul text report to `coverage/merged/coverage.txt` only.
  - `both` (default): write both `coverage.txt` and `coverage-summary.txt`.
- Display and filtering options:
  - `--coverage.mode=compact|full|auto` (default: `auto`): choose compact table-only or full per-file details.
  - `--coverage.detail=<n>|all|auto` (default: `auto`): number of uncovered lines per file to show; `all` shows everything.
  - `--coverage.showCode=true|false` (default: `true` when TTY): show code snippets for uncovered lines in full mode.
  - `--coverage.maxFiles=<n>`: limit number of files in printed tables.
  - `--coverage.maxHotspots=<n>`: limit hotspots per file in compact mode.
  - `--coverage.pageFit=true|false` (default: `true` when TTY): fit output to terminal rows.

Examples:

```bash
# Abort on failing tests without printing coverage
npx headlamp --coverage --coverage.abortOnFailure

# Show compact coverage limited to 50 files and 5 hotspots per file
npx headlamp --coverage --coverage.mode=compact --coverage.maxFiles=50 --coverage.maxHotspots=5
```

## Editor links

Headlamp prints clickable links (OSC 8) to open files at hotspots. Set `--coverage.editor` to override the default editor URL template if needed.

## API

You can import pieces programmatically:

```ts
import { printCompactCoverage, resolveImportWithRoot } from 'headlamp';
```

## Status

Alpha. Expect changes. Feedback welcome.

## License

MIT

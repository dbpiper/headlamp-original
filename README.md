# Headlamp CLI

Coverage-first, runner-agnostic test UX for Jest. Delegates execution to your runner, focuses on better selection and coverage insights.

## Install

Use via npx (recommended):

```bash
npx headlamp --help
```

Or install locally:

```bash
npm i -D headlamp
```

## Usage

- Delegates to your local Jest install
- Renders improved coverage tables and hotspots
- Selects tests by import-graph when you pass production paths

Quick examples:

```bash
# Run tests with coverage
npx headlamp --coverage

# Run only tests related to selected production files
npx headlamp src/services/user.ts src/components/UserCard.tsx
```

## CLI flags

Pass your regular Jest flags (e.g. `-t`, `--testNamePattern`, paths). Headlamp forwards them, and strips/adjusts coverage-related flags when listing tests.

### General

- `--bootstrapCommand <cmd>`: run once before tests (npm script name or full shell command)
- `--onlyFailures[=true|false]`: show only failing tests during live output; always shows final summary
- `--showLogs[=true|false]`: include full console output under failing tests/files

### Concurrency

- `--sequential[=true|false]`: serialize execution
  - Effect: adds Jest `--runInBand` and runs Headlamp’s per‑project execution with stride 1 (no parallel projects)

### Selection

- `paths...`: any file/dir paths; production paths trigger related test discovery by import graph
- `-t <pattern>` / `--testNamePattern <pattern>`: filter by test name
- `--changed[=all|staged|unstaged|branch|lastCommit]`: select tests related to changed files
- `--changed.depth=<n>`: cap transitive import scan depth for changed-file discovery (default: 5)

### Coverage

- `--coverage`: enable coverage collection and merged reporting
- `--coverage.ui=jest|both` (alias: `--coverage-ui`): output mode for Istanbul text reports (default: `both`)
- `--coverage.abortOnFailure`: exit immediately with test code and skip coverage print on failures
- Display/detail options:
  - `--coverage.mode=compact|full|auto` (default: `auto`)
  - `--coverage.detail=<n>|all|auto` (default: `auto`)
  - `--coverage.showCode=true|false` (default: `true` on TTY)
  - `--coverage.maxFiles=<n>`
  - `--coverage.maxHotspots=<n>`
  - `--coverage.pageFit=true|false` (default: `true` on TTY)
  - Globbing filters: `--coverage.include=a,b,c`, `--coverage.exclude=a,b,c`

## Configuration

Project-level file at repo root. CLI always overrides config. No env vars or hidden presets.

### Supported filenames

- `headlamp.config.ts`
- `headlamp.config.js` / `headlamp.config.mjs` / `headlamp.config.cjs`
- `headlamp.config.json` / `headlamp.config.yaml` / `headlamp.config.yml`

### Base defaults (always applied)

- `bootstrapCommand: string`
- `jestArgs: string[]`
- `sequential?: boolean` – serialize tests across Jest and Headlamp

### Coverage-context defaults (applied only when coverage is active)

Prefer the nested `coverage` section:

```ts
export default {
  coverage: {
    abortOnFailure: true, // -> --coverage.abortOnFailure
    mode: 'auto', // -> --coverage.mode=auto
    pageFit: true, // -> --coverage.pageFit=true
  },
};
```

Additional recognized fields when coverage is active:

- `editorCmd` -> `--coverage.editor`
- `include`, `exclude` -> `--coverage.include`, `--coverage.exclude`
- `coverageDetail`, `coverageShowCode`, `coverageMaxFiles`, `coverageMaxHotspots`

### Changed-context defaults (applied only when changed selection is active)

```ts
export default {
  changed: {
    depth: 20, // default for all modes -> --changed.depth=20
    branch: { depth: 10 },
    staged: { depth: 8 },
    unstaged: { depth: 6 },
    all: { depth: 12 },
  },
};
```

You may also set a top‑level default mode (e.g., `changed: 'branch'`); CLI still wins.

### Full example

```ts
// headlamp.config.ts
export default {
  // Base
  bootstrapCommand: 'test:jest:bootstrap',
  sequential: true, // serialize tests (maps to Jest --runInBand and single-project stride)
  jestArgs: ['--runInBand'], // optional: redundant when sequential is true

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

## Scripts

```json
{
  "scripts": {
    "test": "headlamp --sequential",
    "test:coverage": "headlamp --coverage --sequential",
    "test:dev": "npm run test -- --changed=branch --coverage --onlyFailures"
  }
}
```

## Bootstrap command

Use `--bootstrapCommand` to run setup work before tests (e.g., database migrations/seeding). If omitted, no bootstrap runs.

- Single token: treated as an npm script name and run as `npm run -s <name>`
- With spaces: treated as a full command and executed via the system shell

Examples:

```bash
npx headlamp --bootstrapCommand test:jest:bootstrap
npx headlamp --bootstrapCommand "sequelize db:migrate --env test"
```

## Examples

```bash
# Abort on failing tests without printing coverage
npx headlamp --coverage --coverage.abortOnFailure

# Show compact coverage limited to 50 files and 5 hotspots per file
npx headlamp --coverage --coverage.mode=compact --coverage.maxFiles=50 --coverage.maxHotspots=5

# Sequential run to avoid DB deadlocks
npx headlamp --sequential
```

## Editor links

Headlamp prints clickable links (OSC 8) to open files at hotspots. Set `--coverage.editor` to override the default editor URL template if needed.

## API

Programmatic use:

```ts
import { printCompactCoverage, resolveImportWithRoot } from 'headlamp';
```

## Status

Alpha. Expect changes. Feedback welcome.

## License

MIT

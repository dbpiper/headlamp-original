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

## Examples

- Show coverage with detailed hotspots, auto-fit to terminal rows:

```bash
npx headlamp --coverage
```

- Focus on specific production files and run only directly-related tests:

```bash
npx headlamp --coverage src/services/user.ts src/components/UserCard.tsx
```

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

## Coverage flags

- `--coverage`: enables coverage collection and prints merged coverage output after test execution. Uses your project's Jest/Vitest setup and reads coverage JSON from Jest.
  - Prints a compact per-file table with hotspots and optionally detailed per-file breakdowns.
  - Honors file selection and include/exclude globs when rendering coverage tables.
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

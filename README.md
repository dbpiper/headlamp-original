# Headlamp CLI

Coverage-first, runner-agnostic test UX for Jest/Vitest. Delegates execution to your runner, focuses on better selection and coverage insights.

## Install

Only in /Users/david/src/headlamp/src/lib: PLACEHOLDER
Only in /Users/david/src/headlamp/src/lib: _exec.ts
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

## Editor links

Headlamp prints clickable links (OSC 8) to open files at hotspots. Set `--coverage.editor` to override the default editor URL template if needed.

## API

You can import pieces programmatically:

```ts
import { printCompactCoverage, resolveImportWithRoot } from "headlamp";
```

## Status

Alpha. Expect changes. Feedback welcome.

## License

MIT

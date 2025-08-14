# Headlamp

Coverage-first, runner-agnostic test UX for Jest. Headlamp delegates test execution to your existing runner and focuses on clearer selection and better coverage insights.

## Install

```bash
npm i -D headlamp
```

## Quick start

```bash
npx headlamp --coverage [jest args]
```

- Uses your local Jest install; pass your normal flags after `headlamp`
- Renders improved coverage tables and hotspots in the terminal
- Select files via CLI args; Headlamp smartly chooses tests to run and what coverage to show

## Features

- Coverage-first terminal UI: per-file summaries, hotspots, missed functions/branches, editor links
- Intelligent selection:
  - Provide production paths; Headlamp finds direct tests by import graph
  - Falls back to resilient discovery when Jest listing times out
- Alias-aware import resolution: tsconfig/jsconfig paths, Jest moduleNameMapper, Babel module-resolver, Metro extraNodeModules
- Zero lock-in: delegates to Jest; Vitest support is planned but not required to use coverage UI

## CLI flags (selected)

- `--coverage`: enable coverage collection and UI
- `--coverage-ui=jest|both`: choose minimal (jest) or extended (both) coverage UI
- `--coverage.detail=<n|all|auto>`: deep-dive per-file hotspots (n = count)
- `--coverage.showCode=true|false`: show snippet around hotspots
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

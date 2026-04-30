# E2E Contract

This repository uses `.e2e/run.sh` as the project-local runtime entry point.
The runner clears stale artifacts, executes the release-grade test pipeline
(build → typecheck → unit/component/contract category suites → headless
product-shell smoke → optional live smoke), records logs under
`.e2e/results/`, and writes `.e2e/artifact.json` in CTRF format with one entry
per real evidence source.

Run the host-neutral gate with:

```bash
npm run e2e
```

The gate is self-contained in this repository. It does not depend on local
agent skills or an external validator checkout.

Generated artifacts under `.e2e/artifact.json` and `.e2e/results/` are runtime
evidence and are intentionally ignored by git.

## Test Categories

The source of truth for ordinary test classification is `tests/catalog.json`.

- `unit`: pure logic tests with no Obsidian runtime, filesystem, process, or
  provider boundary.
- `component`: plugin components exercised with controlled adapters, job
  managers, or Obsidian shims.
- `contract`: provider protocols, CLI command shapes, exported test surfaces,
  and architecture invariants.
- `e2e`: default project-local product-shell smoke. It installs the built plugin
  package into a disposable Vault filesystem and boots the packaged `main.js`
  against a recording Obsidian API shim. This checks package/install/lifecycle
  boundaries, but it is not a full Obsidian GUI run.
- `live`: opt-in check against a real local Vault install. It verifies plugin
  files under `.obsidian/plugins/parallel-reader/` and does not launch Obsidian,
  call a provider, or run GUI interactions. Run with `TEST_LIVE=1` and set
  `OBSIDIAN_VAULT_PATH` when the default iCloud Vault path is not the target.

Useful commands:

```bash
npm run e2e
npm run test:unit
npm run test:component
npm run test:contract
npm run test:e2e
TEST_LIVE=1 npm run test:live
```

The `.e2e` gate emits one CTRF entry per real evidence source so risk-tag
coverage maps to actual runs:

| Entry | Risk tags |
|-------|-----------|
| `build and typecheck` | `boundary_io, wiring, regression` |
| `unit category` | `regression` |
| `component category` | `data_integrity, wiring, resource_lifecycle, regression` |
| `contract category` | `contract, wiring, regression` |
| `headless product-shell e2e smoke` | `boundary_io, wiring, resource_lifecycle, regression` |
| `live Vault install smoke` (skipped unless `TEST_LIVE=1`) | `boundary_io, contract, regression` |

`npm test` remains a developer-facing convenience that runs the same build,
typecheck, and category suites without the e2e/live legs.

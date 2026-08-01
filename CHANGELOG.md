# Changelog

All notable changes to this project are documented here. Format is a flat,
conventional-commit-prefixed bullet list per release (not strict Keep a
Changelog) to match this repo's existing commit style. Entries for `1.0.0`
through `1.0.24` were derived from `git log` between each release tag; entries
are intentionally brief and only cover what the commit history can verify.

The release workflow (`.github/workflows/release.yml`) reads the section for
the tag being released and uses it as the GitHub release body via
`gh release create --notes-file`. Add a `## [<version>] - <date>` section
here **before** tagging a release, or the release job will fail its
changelog-guard step.

## [Unreleased]

- ci: guard the release workflow so a pushed tag must match `manifest.json`'s
  version and must exist as a key in `versions.json`, failing before any
  publish/upload step (S5)
- ci: use this CHANGELOG's per-version section as the GitHub release body
  instead of `--generate-notes` (S5)
- build: `scripts/bump-version.mjs` gains a `--tag` flag that commits and tags
  the version bump in one step, instead of leaving commit+tag as separate
  manual actions (S5)
- docs: point install instructions at the official community plugin registry;
  fix `manifest.json` identity fields (author, drop stale `fundingUrl`) (S2)
- ci(coverage): stop reporting a fabricated 100% branch-coverage gate (S1a)
- test(coverage): load `main.ts` / `src/*.ts` directly via Node type stripping
  instead of an esbuild bundle, so branch and function coverage are real
  (32 -> ~1200 measured branches, 12 -> ~320 functions); set thresholds to the
  measured floor and add a CI assertion on the absolute totals (S1b)
- fix: the summary card highlight no longer stays on the previous note's card
  after switching files, and no longer jumps to the card above the one you
  clicked (S3)
- fix: offer Retry on timeout, rate-limit, schema and unrecognised generation
  errors — previously only network errors could be retried from the notice (S4)
- fix: the stale-cards banner is rebuilt from the warning colour instead of the
  error red it was painted on, raising its contrast from ~1.4:1, and gains an
  icon so the state is not signalled by colour alone (S6)
- fix: the active summary card is now visually distinct from a hovered one
  (both previously repainted to the sidebar's own background), activation no
  longer nudges card text by 1px, keyboard focus is distinguishable from hover,
  and icon buttons no longer show a duplicate OS tooltip (S7)
- fix: clearing the cache from Settings now refreshes the panel, matching the
  command; a failed card edit or delete no longer leaves the UI showing a
  change that was not saved (S8)
- fix: the editor scroll listener is released on unload instead of leaking the
  plugin instance on every in-place update, and pending settings and cache
  writes are flushed when Obsidian quits (S9)
- fix: localise the three clipboard/action failure notices that were hardcoded
  in English despite translations existing in all seven locales (S10)
- test: replace two architecture guards that could never match with a real
  cache-debounce test (S11)
- a11y: honour `prefers-reduced-motion` for the loading spinner and card
  scroll-sync animation
- fix: opening or switching to a note with cached cards highlights the card the
  editor is already on, instead of showing no highlight until you scroll
- fix: a card edit or delete that finishes after you switched notes no longer
  repaints the newly opened note with the previous note's cards
- fix: a rejected cache write is rolled back in memory, so an edit the UI
  reported as failed can no longer reappear when the note is reopened
- fix: cache writes are serialized, so a failed write during batch generation
  can no longer discard summaries that were saved successfully alongside it
- fix: quitting Obsidian now waits for a debounced settings or cache write that
  is already in flight, not just for one that has yet to start
- fix: settings writes are queued, so two changes made in quick succession
  cannot land out of order and revert the newer one
- fix: opening a note within a moment of clicking a card in another note no
  longer leaves the new note without a highlighted card until you scroll
- a11y: the active card's title carries an underline, so "you are here" is no
  longer signalled by colour alone
- build: `scripts/bump-version.mjs --tag` refuses to tag when the tag already
  exists, when the CHANGELOG section is missing, or when unrelated changes are
  staged, and commits only the release files
- fix: the initial card-highlight sync now prefers the Markdown leaf that is
  actually focused when the same note is open in two leaves (a split),
  instead of always reading whichever leaf the workspace happened to
  enumerate first
- fix: a card edit or delete superseded by a concurrent mutation on the same
  card now shows a notice instead of silently doing nothing; it still fails
  closed and does not persist, only the missing feedback was fixed

## [1.0.24] - 2026-06-16

- feat: provider/lifecycle robustness, onboarding nudge, CI coverage gate
- fix: avoid stringifying locale objects
- fix: address codex review — drop false-positive fallback keywords, tighten
  stream-error detection

## [1.0.23] - 2026-05-19

- feat: expand i18n language support
- perf: eliminate per-card document rescans and redundant hashing
- refactor: remove dead code and over-broad exports
- test: add c8 coverage harness with source-map remapping

## [1.0.22] - 2026-05-14

- style: apply Biome formatter to `cli.test.js` (no functional change)

## [1.0.21] - 2026-05-14

- fix: pass `--verbose` with `stream-json` for Claude CLI 2.1.131+
- fix: clear Obsidian review unused bindings

## [1.0.20] - 2026-05-09

- fix: harden CLI backend smoke checks
- ci: make release upload idempotent

## [1.0.19] - 2026-05-09

- chore: prepare 1.0.19 release (no functional change noted in history)

## [1.0.18] - 2026-05-08

- fix: address Obsidian plugin review scan issues

## [1.0.17] - 2026-05-05

- feat(error-ui): structured `CliProcessError` + `ErrorKind`-driven UI dispatch
- feat(cli): enrich CLI timeout diagnostics + idle timeout + debug logging

## [1.0.16] - 2026-05-03

- chore: bump `minAppVersion` to 1.7.2 to match the `revealLeaf` API
  requirement

## [1.0.15] - 2026-05-02

- refactor(settings): collapsible sections + smart auto-expand

## [1.0.14] - 2026-05-02

- feat: toggle right sidebar instead of detaching tab

## [1.0.13] - 2026-05-02

- fix: regressions in 1.0.12 — sidebar render guard + open-view toggle

## [1.0.12] - 2026-05-02

- fix: address 10 P2 behavioral and concurrency findings

## [1.0.11] - 2026-05-02

- fix: address 13 review findings (security, UX, i18n)

## [1.0.10] - 2026-04-30

- fix: add cancel action to batch prompt
- fix: localize batch prompt confirmation and remaining action labels
- fix: confirm before overwriting exports
- fix: count batch generation failures
- ci: add e2e contract gate; enforce self-contained release gate

## [1.0.9] - 2026-04-27

- fix: add `void` operator to all floating promises in callbacks

## [1.0.8] - 2026-04-27

- fix: address CR findings — bump script, test runner, temp cleanup
- build: remove `main.js` from git tracking; add version bump script; add
  tag-triggered release workflow

## [1.0.7] - 2026-04-27

- fix: remove unsupported `--max-tokens` flag from Claude CLI args

## [1.0.6] - 2026-04-27

- fix: address CR findings — test runner, CI dedup, error cause
- fix: update CI to use `npm test` instead of a hardcoded test file list
- refactor: split `view.ts`, the settings tab, and `main.ts` into focused
  modules

## [1.0.5] - 2026-04-27

> Note: `1.0.4` was never tagged/released; `versions.json` retains an orphan
> entry for it, harmless because it shares `minAppVersion` with `1.0.14` so
> Obsidian's updater can never select it.

- fix: eliminate unsafe casts in `scroll.ts` and CLI/provider code
- fix: close abort signal race window in streaming fetch
- fix: prevent modal confirmation promise from resolving twice
- fix: add logging to silent catch blocks
- fix: pass `--max-tokens` to Claude Code CLI to prevent output truncation
- fix: salvage truncated LLM JSON and make errors copyable

## [1.0.3] - 2026-04-27

- feat: add generate button to empty state panel
- feat: expose streaming timeout setting
- feat: validate batch folder input
- feat: support cancellable batch generation
- fix: address remaining Obsidian review bot required issues
- fix: clean up streaming abort listener; parse multiline SSE events

## [1.0.2] - 2026-04-26

- feat: add folder-level batch summarization command
- feat: add streaming timeout protection
- fix: address all required issues from the Obsidian plugin review bot
- docs: simplify installation guide and CLI backend description

## [1.0.1] - 2026-04-26

- fix: remove `authorUrl` pointing to repo (rejected by marketplace)
- fix: raise CLI timeout from 120s to 300s
- fix: parse Claude Code JSON array output and drop `--model` flag
- docs: modern English README with badges and star history

## [1.0.0] - 2026-04-26

- Initial release: split-view reading with a source note on the left and
  LLM-generated summary cards on the right, provider architecture, scroll
  sync, and regeneration guard.

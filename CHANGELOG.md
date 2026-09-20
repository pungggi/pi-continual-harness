# Changelog

All notable changes to **pi-continual-harness** are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/).

Releases are tag-driven (`vX.Y.Z`) and published by GitHub Actions via npm
Trusted Publishing. This file begins at 0.7.0; earlier releases are recorded in
the git tags (`git tag -l`) and the [GitHub release history](https://github.com/pungggi/pi-continual-harness/releases).

## [0.10.0] — 2026-09-18

The merge-capable dedupe proposer: fuzzy-corrections take 1. Spec and research
grounding in [docs/PLAN-dedupe-merge.md](docs/PLAN-dedupe-merge.md).

### Added

- **`dedupe` proposer merges instead of deleting** — two active items sharing
  the key fields (kind, owner model, durable layer: scope + project slug) with
  token overlap ≥ the threshold merge into the higher-importance keeper: one
  audited `update` (evidence = line-wise union, capped at 2000 chars) + one
  `delete` per duplicate (`merged into h_x (overlap …)`). The keeper's content
  is never prose-merged (ACE); injection is content-only, so the prompt block
  is unchanged. Identical evidence degenerates to a plain delete.
- **Config keys** `dedupe: { "threshold": 0.6, "merge": true }` in
  `harness.json` — threshold valid in `(0,1]` (bad values degrade to `0.6`),
  `merge: false` restores the pre-0.10 delete-only behavior.
- **`/refine --threshold <t>`** — one-shot threshold override for the run
  (affects the `dedupe` proposer; invalid values are ignored with a warning).
- **`ProposeInput.config`** — `runRefine` now threads the loaded `harness.json`
  into every proposer (optional, additive), so proposers read tuned knobs
  without file I/O.
- **Public API**: `planDedupe(state, opts)` (the pure planner), `DedupeOptions`
  (with a `similarity?` seam for the future semantic upgrade), `DEFAULT_DEDUPE`,
  `EVIDENCE_MERGE_CAP`, `unionEvidence`, `DEDUPE_THRESHOLD` re-exported from
  the package entry.
- **`SimilarityResult` abstain seam** — `DedupeOptions.similarity` may return
  `{ score, abstain }` instead of a plain number: an abstaining pair is treated
  as NOT duplicates (keep both), so a semantic engine with conformal-style
  uncertainty (e.g. pi-jev, local-only for now) can decline to
  merge on uncertainty. `SimilarityResult` is re-exported from the package
  entry; plain numeric comparators keep working unchanged.

### Changed

- The `dedupe` proposer's default behavior (was: delete-only, hardcoded 0.6).
  Rollback path: set `"dedupe": { "merge": false }`.

## [0.9.0] — 2026-09-17

The project-scope split (issue #7). Scope becomes a property of each item, the
durable file becomes durable **layers**, and one opt-in flag makes `/refine`
output survive into new sessions without export/import ceremony.

### Added

- **Per-item durable scope** — `HarnessItem.scope: "global" | "project"`
  (+ `project` slug). Scope decides which durable layer an item is exported to
  / imported from; it never filters per-turn injection.
  - **`/harness move <id> <global|project>`** — flip an item's layer
    (audited update delta, `/tree`-rollback-able; `project` stamps the current
    session's slug). Autocompletes ids then scope values.
  - **`/harness split`** — the interactive migration helper: steers the agent
    to classify every active item global-vs-project and apply the result as one
    `harness_mutate` batch of scope-only updates (visible, audited,
    rollback-able — the push-mem pattern).
  - **Layered durable I/O** — `/harness export` (no path) partitions items
    into `~/.pi/agent/harness-state.md` + `harness-state/<slug>.md`;
    `/harness import` (no path) merges global first then the current project's
    file (project wins id collisions; `--prune` is union-scoped across
    layers). Explicit paths keep classic single-file semantics. Project items
    carry a `scope: project (<slug>)` sub-line so any copy round-trips.
    `/refine --commit` now exports the layers too. `/harness status` shows
    both layers + the scope split.
  - **`scope` on `harness_mutate` create/update deltas** — server-side slug
    stamping from the session cwd (the tool never sees raw slugs).
- **Opt-in durable sync: `"autoImport": true`** (`src/durable.ts`) — bundles
  both directions: `session_start` layered auto-import (loss-free merge,
  silent when nothing changes — imports are now idempotent and skip the
  persist when the live store already matches the files) + `turn_end` layered
  auto-export whenever the store version changed since the last export. Every
  action is visible and uses the same `harness-state` entries (`/tree`
  rollback covers them).

### Changed

- **`durableScope` is deprecated** (no-op): durable I/O is always layered on
  per-item scope now. The key still parses so existing configs keep loading;
  migration is one layered `/harness import` + `/harness move`/`split`.
- Import merge is **idempotent**: an import that changes nothing persists
  nothing (no session-tree noise from repeated or auto imports).
- Layered import handles the same id in **both** layers (project copy wins,
  no duplicate items).

[0.9.0]: https://github.com/pungggi/pi-continual-harness/compare/v0.8.1...v0.9.0

## [0.8.1] — 2026-09-13

The completions release. `/harness` now registers `getArgumentCompletions`, so
subcommands stop being one long crammed command description and become a
filtered autocomplete menu instead. Handler logic is unchanged — purely UX.

### Added

- **`/harness` argument autocomplete** (`src/harness.ts`) — two levels:
  - `/harness <partial>` lists the seven subcommands (import, export, status,
    prune, keep, drop, push-mem), each with a one-line description, filtered
    case-insensitively as you type (matching the handler's `toLowerCase()`
    tolerance).
  - `/harness <sub> …` completes what comes next per subcommand: flags
    (`--prune`, `--decay`, `--all`, `--kind`, `--model` — already-used flags
    are not re-offered), `--kind` values (`prompt|memory|skill|subagent`),
    `--model` values (`active` plus the distinct owner models in the store),
    and `keep`/`drop` item ids straight from the live store with a
    `kind · content-preview` description row.
  - Path/number/free-text arguments return no menu, leaving the editor's own
    completion alone.
- Completion rows carry the full replacement text (pi replaces the whole
  argument string on selection), so multi-token completion round-trips exactly.
- The `/harness` command description is now a compact one-liner instead of the
  full subcommand + flag grammar.

## [0.8.0] — 2026-08-10

The bounded-injection release. The harness ACCUMULATES notes, but the system
prompt is finite — so selection is now ON BY DEFAULT: injected items are
importance-ordered, capped per kind, and bounded by a total token budget. The
store itself is unchanged (nothing is ever lost — only what is *surfaced*
changes), and the whole policy is opt-out via `injection.enabled: false`.

### Added

- **Injection selection policy (on by default)** — `src/select.ts` decides
  WHICH active items for the active model get surfaced each turn, and in what
  order. Pure and fully unit-tested; `inject.ts` is now thin glue over it.
  Policy: (1) filter to active + owner-model items (strict per-model isolation,
  unchanged); (2) order by importance desc, ties stable on store index; (3) cap
  via `maxPerKind` (balanced sections — no single kind drowns the block) then
  `maxTokens` (total budget, filled round-robin across kinds by importance rank
  so one kind can't starve the others; an item that doesn't fit is *skipped*, not
  a hard stop, so a large item never blocks smaller higher-priority ones).
- **Config: `injection`** in `harness.json` — `{ enabled, maxTokens, maxPerKind,
  charsPerToken }`, always resolved by `loadConfig`. Shipped defaults: `enabled:
  true`, `maxTokens: 1500`, `maxPerKind: 10`, `charsPerToken: 4` — generous
  enough to be a NO-OP for small stores (nothing trimmed) and protective as the
  harness accumulates. Opt out with `injection.enabled: false` → legacy "all
  items, in store order".
- **Transparency footer** — when the policy drops items, the injected block ends
  with a one-line `_(N item(s) not shown — below the injection budget…)_` note,
  so a bounded block is never silently truncated.
- **Public API** — `selectForInjection`, `normalizeInjection`, `estimateTokens`,
  `DEFAULT_INJECTION`, and the `InjectionConfig` / `NormalizedInjection` types
  are re-exported from the package entry for companion packages and tests.

### Changed

- `renderHarnessBlock(ownerKey?, cfg?)` now renders the selected subset (defaults
  apply when `cfg` is omitted, so direct callers — including existing tests —
  get the new policy). `before_agent_start` reads `injection` from config and
  passes it through.
- Default injection is now importance-ordered. This reorders (and, for large
  stores, trims) the supplemental block, but changes no data: items remain in the
  store, `/tree` rollback is unaffected, and the durable round-trip is
  unchanged. Set `injection.enabled: false` to restore the pre-0.8 block exactly.

### Docs

- README: new "Injection selection (on by default)" section + `injection` in the
  config block; Status updated. MANUAL: injection-selection section. ROADMAP:
  Phase 7. 25 new tests (`test/select.test.ts` + injection/config/integration
  coverage); 137 total, typecheck clean.

## [0.7.0] — 2026-08-09

The per-model isolation release. Every item is bound to an exact `provider/id`
and injected only for the model it belongs to — a brand-new model id starts from
a blank harness, and one model's notes never leak into another's context.

### Added

- **Per-model isolation (`ownerModel`).** Every item now carries an
  `ownerModel` (`"provider/id"`, or `""` for an orphan) and is injected only for
  the model it belongs to. Binding is at the exact id by design — a new version
  is a clean slate.
  - Creates are stamped automatically: `before_agent_start` caches the active
    model (the model-facing tools receive no `ctx`), then `harness_mutate` and
    direct-apply proposers stamp creates from it.
  - **Orphan adoption** is the migration path: items with no owner (legacy
    session snapshots, old durable files, or created while the model was
    unknown) are adopted by the active model on first contact — persisted as a
    normal `harness-state` entry, so `/tree` rollback covers it.
  - `harness_list({ model? })` — defaults to the active model's items; `"*"`
    returns every model; an explicit `"provider/id"` filters.
- **`/harness push-mem --model <provider/id|active>`** — scope a pi-mem push to
  one model's items (`active` resolves to the model driving the command).

### Changed

- **Durable round-trip preserves owner** via a per-item `model:` line; an
  untagged item degrades to an orphan and is adopted on import/first contact.
- Injection, `harness_list`, and the outcome loop are model-scoped; the `dedupe`
  proposer no longer compares items across models.
- `/harness status` shows whole-store kind counts, annotated with the active
  model's share.

### Fixed

- **`harness_mutate` isolation** (PR review): `update`/`delete` are now scoped
  to the active model too — an agent on model A can no longer mutate model B's
  item by id (atomic rollback with a clear error). Cross-model maintenance paths
  (`dedupe`, `/harness keep|drop|prune`) pass no actor and are unaffected.
- **Durable owner semantics** (PR review): an absent `model:` tag on an existing
  item now orphans it (→ adopted by the active model) instead of silently
  keeping the old owner — "durable wins" now covers owner uniformly.
- `session_start` resets the cached active-model key across fork/resume.

### Docs

- README + MANUAL model-binding sections; MANUAL updated for the review fixes
  (`harness_mutate` actor scoping, model-aware `dedupe`, model-scoped outcome,
  whole-store `status`); ROADMAP Phase 6; stale `0.5.x` version strings
  corrected; this CHANGELOG introduced.
- Cross-linked the [pi-harness-model-proposer](https://github.com/pungggi/pi-harness-model-proposer)
  companion.

### Internal

- 19 files changed (+876/−52 over 0.6.2). **112 tests** (+25), typecheck clean;
  new `test/model-binding.test.ts`. Durable format and tool schemas extended
  backward-compatibly (missing `ownerModel` → orphan → adopted).

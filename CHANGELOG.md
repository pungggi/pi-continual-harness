# Changelog

All notable changes to **pi-continual-harness** are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/).

Releases are tag-driven (`vX.Y.Z`) and published by GitHub Actions via npm
Trusted Publishing. This file begins at 0.7.0; earlier releases are recorded in
the git tags (`git tag -l`) and the [GitHub release history](https://github.com/pungggi/pi-continual-harness/releases).

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

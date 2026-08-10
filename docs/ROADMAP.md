# Roadmap — pi-continual-harness

Living implementation plan for the self-improvement loop. Phased so each phase
is independently shippable, fully tested, and low-risk before the next begins.

## Guiding constraints (do not regress)

- **Manual by default** — no autonomous mutation unless explicitly opt-in.
- **Structured, evidence-backed deltas** — every mutation is visible in the transcript.
- **Branch-local state + `/tree` rollback** is the safety net.
- **Compose, don't reinvent** — pi-reflect (offline), pi-mem (storage).

## Phase 0 — DONE (0.2.0)

Two-way durable seam: `parseDurable()` + `reconstructFromDurable()` +
`/harness import|export|status`. The pi-reflect round-trip closes:
`/refine --commit → harness-state.md → /reflect edits → /harness import → store`.

## Phase 1 — DONE (main; unreleased)

- **A. Prune** — `/harness prune [--decay <days>]`; `decayAndPrune()` first ages
  importance (−step for items older than N days) then drops below floor.
- **B (phase 1). Human signal** — `/harness keep|drop <id>` via `bumpImportance()`.

Shipped: store unit tests + `/harness` command smoke tests. **Effort:** ~70 lines. **Risk:** low.

## Phase 2 — DONE (main; unreleased)

- Config at `~/.pi/agent/harness.json` + a `loadConfig()` reader (`src/config.ts`).
- **F. Project-local durable path** — `durableScope: "global"|"project"`;
  `resolveDurablePath()` derives a stable slug from `cwd`.
- **C-reminder.** Opt-in `turn_end` reminder (`src/remind.ts`) every N turns —
  notify only, never mutates.

Shipped: config loader + slug derivation + reminder cadence tests (14 new). **Effort:** ~190 lines. **Risk:** low.

## Phase 3 — DONE (main; unreleased)

- **C auto-refine** — opt-in `turn_end` auto-refine (`src/auto-refine.ts`), behind
  `autoRefine: { enabled, everyTurns, commit }` in config (default off, 100).
  Reuses the exact `runRefine()` routine (extracted from `/refine`), so it
  inherits all safety props: audited `REFINE_ENTRY` tagged `source: "auto"`,
  branch-local snapshots, `/tree` rollback. Visible: notifies before firing.
  **Effort:** ~110 lines. **Risk:** medium (autonomy) — mitigated by opt-in +
  cadence + audit + visibility + rollback.

## Phase 4 — DONE (main; unreleased)

- **D. Pluggable proposer** — `DeltaProposer` interface + registry
  (`src/proposer.ts`). `runRefine()` is now proposer-driven: it resolves a
  proposer, calls `propose({ evidence, state, lookback })`, then either applies
  returned deltas directly (persisted via `harness-state` entries, so `/tree`
  rollback covers them) or sends a steering message. Two proposers shipped:
  `steering` (default, behavior-preserving) and `dedupe` (rule-based: drops
  near-duplicate active items by token Jaccard, keeping higher-importance).
  Selectable via `/refine --proposer <name>` or `proposer` in config; the
  registry is re-exported from the package entry (`registerProposer`).
  **Effort:** ~230 lines (proposer.ts + runRefine refactor + tests). **Risk:**
  medium — mitigated by keeping the default behavior-preserving and the
  hidden-model-spend variant out of scope (documented as a future decision).

## Phase 5 — DONE (main; unreleased)

- **E. pi-mem push** — `/harness push-mem [--all|--kind <kind>]` composes with
  pi-mem by **steering** the agent to call pi-mem's `save_memory` for each
  active item. No dependency on pi-mem — tool-agnostic and soft-fail (the agent
  says "install pi-mem" if no memory tool is present). Default scope is the
  memory kind (the clean 1:1 mapping); `--all` / `--kind` override. The harness
  store is read-only for a push. **Effort:** ~55 lines. **Risk:** low.
- **B (phase 2). Outcome loop** — opt-in `turn_end` reference-promotion hook
  (`src/outcome.ts`) behind `outcomeImportance: { enabled, bump }` in config
  (default off, 0.03). When the agent cites an active item by its `[h_xxxx]`
  tag, importance is bumped (+bump, clamped, persisted via the same
  `harness-state` entries → branch-local / `/tree` rollback) and `updatedAt` is
  touched (so promoted items survive time-based decay). This closes the outcome
  half of the fitness loop: useful items rise, ignored items keep decaying.
  **Hard scope cut:** CORRECTION/demotion from outcomes is genuinely fuzzy and
  high-false-positive, so it is intentionally NOT autonomized — demotion stays
  with the existing audited primitives (`/harness drop`, `prune --decay`, the
  `dedupe` proposer); a fuzzy `corrections` proposer is the natural future
  extension via the Phase 4 registry.
  **Effort:** ~95 lines. **Risk:** medium (autonomy) — mitigated by opt-in +
  promotion-only + persist/rollback + visibility.

## Phase 6 — DONE (main; unreleased)

- **Model binding (per-model isolation).** Every item now carries an
  `ownerModel` (`"provider/id"`), and an item is injected **only** for the
  exact model it belongs to — so switching to a brand-new model id starts from
  a blank harness and one model's notes never pollute another's context.
  Binding is at the exact id by design (a new version is a clean slate).
  - New items are stamped automatically: `before_agent_start` caches the active
    model (the model-facing tools have no `ctx` of their own), and
    `harness_mutate` / direct-apply proposers stamp creates from it.
  - **Orphan adoption** is the migration path: items with no owner (legacy
    snapshots, old durable files, created while the model was unknown) are
    adopted by the active model on first contact — persisted as a normal
    `harness-state` entry, so `/tree` rollback covers it.
  - The **durable round-trip preserves owner** (a `model:` line per item);
    `dedupe` no longer compares across models; the outcome loop only bumps the
    active model's cited items.
  - Manual commands (`export`/`import`/`keep`/`drop`/`prune`/`push-mem`/`status`)
    keep whole-store control; isolation is enforced only at the automatic
    context layer (injection, listing, create-stamping, outcome).

  **Effort:** ~370 lines across 8 source files (schema, store, inject bridge,
  tools, refine, outcome, proposer, harness) + docs + 19 new tests. **Risk:**
  medium (behavioural change to injection + a new persisted field + durable
  format) — mitigated by: backward-compatible schema (missing → orphan →
  adopted), strict turn-start caching (the active model is always known before
  any tool runs), and a full durable round-trip that degrades to the adopt
  policy if pi-reflect strips the tag.

## Phase 7 — DONE (main; unreleased)

- **Bounded injection (selection on by default).** The harness accumulates
  notes, but the system prompt is finite — so `src/select.ts` now decides WHICH
  active items for the active model get surfaced each turn, and in what order.
  The store is unchanged; only what is *surfaced* changes.
  - Policy (pure, deterministic, unit-tested): filter to active + owner-model
    items (per-model isolation, unchanged); order by importance desc (stable on
    store index); cap via `maxPerKind` (balanced sections) then `maxTokens`
    (total budget, filled round-robin across kinds by importance rank; an item
    that doesn't fit is skipped, not a hard stop).
  - **ON BY DEFAULT** with generous defaults (`maxTokens: 1500`, `maxPerKind:
    10`) that are a no-op for small stores and protective for large ones. Opt
    out with `injection.enabled: false` → legacy "all items, in store order".
  - **Transparency footer** when items are dropped; **public API**
    (`selectForInjection`, `normalizeInjection`, `estimateTokens`,
    `DEFAULT_INJECTION`, types) re-exported for companions/tests.
  **Effort:** ~170 lines (`select.ts` + `inject.ts`/`config.ts` wiring + docs)
  + 25 tests. **Risk:** medium (a new default for injected content) — mitigated
  by: the store is never changed by selection (nothing lost), `/tree` rollback
  and the durable round-trip are untouched, defaults trim nothing for small
  stores, and a one-key opt-out restores the pre-0.8 block exactly.

## Future extensions (not on the phase plan)

Two items were flagged during the phases as deferred decisions. Neither needs
core changes — both are reachable through the already-public **proposer
registry** (`registerProposer()`). Recorded here so they're not lost in phase
prose.

- **Dedicated-model proposer.** A `DeltaProposer` that makes its own (hidden)
  LLM call to produce deltas directly, instead of delegating to the agent via a
  steering message. **The enabler landed on main:** `/refine` now injects a
  one-shot `complete(prompt, opts?)` into `ProposeInput` (built from
  `ctx.modelRegistry` + `ctx.model`, honoring `ctx.signal` and a per-call token
  budget) and records any `modelCall` telemetry a proposer returns in the
  `harness-refinement` audit entry. What remains is the proposer *logic*
  (prompt → JSON deltas → parse → validate → sanitize → telemetry), which is a
  companion-package decision: the tradeoff it introduces (non-visible model
  spend) is resolved by making the spend **audited** (model/tokens/latency in
  the branchable audit entry) rather than shipping it invisible in-core.
- **Fuzzy `corrections` proposer.** A rule/heuristic proposer that demotes
  importance from outcome signals (items the agent corrected or contradicted).
  Phase 5 made the autonomous outcome loop **promotion-only** because
  correction-side signals are high-false-positive; demotion-from-outcomes is
  the natural future extension, and it belongs in the proposer registry
  (auditable, selectable, reviewable) rather than as a silent `turn_end`
  mutation.

These are open backlog, not commitments. The broader composition space
(auto-push to pi-mem on a cadence, bi-directional pi-mem sync) is similarly
open-ended exploration, not a near-term plan.

A third, narrower future extension opened up by Phase 7:

- **Relevance-aware injection.** Phase 7 ships importance + budget selection;
  the natural next step is to fold in *relevance to the current user turn* —
  blending the importance score with a keyword-overlap score against the latest
  user message (reusing the `tokenize` / `tokenOverlap` helpers already in
  `proposer.ts`). `selectForInjection` is pure and takes the candidate set, so a
  relevance scorer can be layered in without touching `inject.ts`; the tradeoff
  to resolve is whether to apply it always or only as a tiebreaker within the
  budget (so a high-importance note is never bumped out by a keyword match).

## Out of scope (compose instead)

Durable storage engines (pi-mem), offline deep refinement (pi-reflect),
live sub-agent orchestration (pi-boss / pi-room).

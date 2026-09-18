# Plan — merge-capable dedupe (`fuzzy corrections`, take 1) → 0.10.0

Direct-implementation spec for upgrading the `dedupe` proposer: configurable
similarity threshold + **deterministic merge** of records that share key
fields, replacing blind delete. Locked decisions (user):

1. **Upgrade `dedupe` in place** — no new proposer name.
2. **Merge ON by default** — `merge: false` restores delete-only.
3. **Threshold in config + `--threshold` CLI flag** on `/refine`.

Grounding: this delivers the merge/dedupe half of the ROADMAP "fuzzy
corrections" extension. Correction-side demotion from outcome signals stays
open.

## Research grounding

**Shipped in v1** (the deterministic core — no ML):

- **ACE — Agentic Context Engineering** (arXiv [2510.04618](https://arxiv.org/abs/2510.04618)) — the merge
  itself: itemized, deterministic merges instead of destructive rewrites;
  never prose-merge content (anti-collapse); evidence union is the merge
  record.
- **Continual Harness** (arXiv [2605.09998](https://arxiv.org/abs/2605.09998)) — reset-free online CRUD over
  the four components; `/tree` rollback as the safety net.

**Upgrade paths** (Cactus / Needle research, <https://cactuscompute.com/research>;
all post-0.10.0, companion-package territory — none block this plan):

- **Auto-tuned threshold** — *Just Enough Learning: GRPO-Guided Controllers
  for Hyperparameter Sweeps* (Justin H. Lee, Henry Ndubuaku — ICLR 2026
  Workshop RSI, [OpenReview kKWSQsYgpa](https://openreview.net/forum?id=kKWSQsYgpa)).
  `dedupe.threshold` is a hand-set hyperparameter; the paper's pitch — a small
  RL controller approaching hand-tuned quality at amortized cost — maps to
  per-(model × kind) threshold tuning. The training signal is **already being
  logged**: audit rationales record the Jaccard score of every merge decision,
  and the Phase 5 outcome loop records which merged keepers get cited
  (false-merge detection). v1 keeps the threshold manual and logs the signal.
- **Semantic similarity** — *Parameter-Efficient Transformer Embeddings via
  Functional Factorization* (Henry Ndubuaku — arXiv
  [2505.02266](https://arxiv.org/abs/2505.02266), ICML 2026). Token Jaccard
  misses paraphrases ("always run tests before committing" vs "run the test
  suite prior to commit"); the paper is the technique behind Needle's
  parameter-efficient embedding mode, which a companion package could run
  locally and inject as cosine similarity through the `similarity` seam below.
- **Better tokenization** — *Token-Aware Chunked Encoding* (Parkirat Sandhu
  et al. — ICLR 2026). `tokenize` lowercases and splits on non-alnum, so code
  identifiers (`applyDeltas`), paths (`src/store.ts`) and flags (`--proposer`)
  collapse — and harness content is exactly that kind of text. A
  token-aware splitter (identifier splitting, path segments as tokens) is a
  measurable, ML-free upgrade to the same Jaccard gate.
- **Confidence-gated merging** — *Calibration-Aware Activation Sparsity for
  Instruction-Tuned LLMs* (Noah Cylich, Karen Mosoyan, Henry Ndubuaku — ICML
  2026), plus Needle's calibrated act/confirm/refuse routing. If merge
  false-positives appear, the conservative extension is a two-band policy:
  overlap ≥ threshold → auto-merge (act); a gray zone below it → surfaced for
  review (confirm). Calibration is what makes a confirm band meaningful
  rather than arbitrary. v1 stays single-band and deterministic.

---

## 1. Merge gate — when are two records "the same"?

A candidate `c` merges into a keeper `k` iff ALL hold (first three are the
existing dedupe gate, kept verbatim):

| # | Condition | Why |
|---|---|---|
| 1 | `c.active && k.active` | existing filter — inactive items are never touched |
| 2 | `c.kind === k.kind` | existing — a prompt note ≠ a memory fact |
| 3 | `c.ownerModel === k.ownerModel` | existing — per-model isolation (orphans `""` still merge with orphans) |
| 4 | **NEW** same durable placement: `(c.scope ?? "global") === (k.scope ?? "global")` and equal `project` slug when project-scoped | merging across layers would silently change durable placement / cross-project visibility |
| 5 | `tokenOverlap(c.content, k.content) >= threshold` | the similarity threshold — default `0.6` (today's `DEDUPE_THRESHOLD`), now tunable |

Algorithm shape is unchanged: active items sorted importance-desc (stable —
ties keep store order), greedy scan, candidates compared **against keepers
only** → still contradiction-free (a keeper is never dropped). A candidate
matching several keepers joins the **best-overlap** one (existing `best` loop).

## 2. Merge semantics (deterministic, ACE-style)

Per refine run, `planDedupe` emits:

- **One `update` per keeper that absorbed ≥1 duplicate**:
  `{ op: "update", id: keeper.id, evidence: <union> }` — `content`,
  `importance`, `active`, `ownerModel`, `scope` are all **omitted**
  (unchanged). Rationale: the keeper (higher importance = higher fitness)
  stays the canonical content; **never prose-merge content** (ACE
  anti-collapse rule). Injection is content-only, so the prompt block and its
  budget are untouched by merges.
- **One `delete` per absorbed duplicate**:
  `{ op: "delete", id: dup.id, reason: \`merged into ${keeper.id} (overlap ${sim.toFixed(2)})\` }`.
- Delta order: all updates first, then deletes (ids are disjoint; either
  order is safe, this is conventional).
- `merge: false` → drop the update deltas; result is byte-for-byte today's
  delete-only behavior.

**Evidence union** (the merge record):

```
unionEvidence(keeper, ...dups):
  lines = (keeper.evidence + each dup.evidence).split("\n").map(trim)
  drop empty lines; drop exact duplicate lines (first occurrence wins,
  keeper's lines first)
  join "\n"; if length > EVIDENCE_MERGE_CAP (2000) → truncate + append
  "\n[…merged evidence truncated…]"
```

- **One update with the final union, not one per dup**: `applyOne` replaces
  `evidence` wholesale — per-dup updates would clobber each other. Compute the
  union against the original state.
- Skip the update entirely when `union === keeper.evidence` (identical
  evidence → merge degenerates to delete-only for that pair; no no-op deltas).
- `updatedAt` is touched server-side by `applyOne` → merged keepers survive
  time-based decay. `createdAt` of the keeper is preserved. **No importance
  bump** (unlike `outcomeImportance`) — the unioned evidence is the record.
- Store calls: `runRefine` already invokes `applyDeltas` **without**
  `actorModel` (cross-model maintenance path — `assertOwnsItem` allows it;
  store.ts's comment even names the dedupe proposer).

## 3. Config — `src/config.ts`

```ts
export interface NormalizedDedupe { threshold: number; merge: boolean; }
// HarnessConfig gains:
dedupe?: NormalizedDedupe;   // resolved by loadConfig, always populated
```

- `DEFAULT_CONFIG.dedupe = { threshold: 0.6, merge: true }`.
- `mergeConfig`: `threshold: coerceThreshold(over.dedupe?.threshold)`,
  `merge: over.dedupe?.merge !== false`.
- `coerceThreshold(raw)`: finite number in **(0, 1]** → `raw`; anything else
  (0, negative, >1, NaN, strings) → `0.6`. Mirrors `coerceBump` — the value
  is a comparison operand and must never leak a non-number.
- `threshold: 1` is valid and means "identical token sets only".

## 4. Proposer — `src/proposer.ts`

- Keep `export const DEDUPE_THRESHOLD = 0.6` (default, back-compat export).
- New exports:

```ts
export interface DedupeOptions {
  threshold: number;
  merge: boolean;
  /** Similarity function in [0,1]; defaults to tokenOverlap. The seam for the
   *  semantic upgrade path (see Research grounding): a companion package
   *  injects cosine similarity over embeddings without forking planDedupe. */
  similarity?: (a: string, b: string) => number;
}
export function planDedupe(state: HarnessState, opts: DedupeOptions): ProposedDelta[];
```

  `planDedupe` is pure (no I/O, no config reads) — the unit-test surface.
- `ProposeInput` gains **optional** `config?: HarnessConfig` (additive; public
  API change is non-breaking). `runRefine` passes the loaded config so
  proposers read tuned knobs without file I/O. Import is type-only → no cycle
  (proposer → config → store; store imports types only).
- `dedupeProposer.propose({ state, config })` =
  `planDedupe(state, config?.dedupe ?? { threshold: DEDUPE_THRESHOLD, merge: true })`.
- Rationales (audit trail style, one per delta):
  - delete: `dedupe: "X…" ≈ keeper "Y…" (Jaccard 0.71); merged into h_keep.`
  - update: `merged N duplicate(s) into h_keep; evidence unioned (M sources).`

## 5. Wiring — `src/refine.ts`

- `RefineOptions` gains `threshold?: number`.
- `parseArgs`: accept `--threshold <n>` and `--threshold=<n>`; validate
  number in (0,1]; invalid → ignored + `ctx.ui.notify` warning
  ("invalid --threshold ignored (expected 0 < t ≤ 1)"). Unknown flags stay
  silently ignored as today.
- `runRefine`: `const config = await loadConfig();` then

```ts
const proposerConfig = options.threshold !== undefined
  ? { ...config, dedupe: { ...config.dedupe, threshold: options.threshold } }
  : config;
// ... proposer.propose({ evidence, state, lookback, config: proposerConfig, ... })
```

- `--threshold` only affects rule-based dedupe (documented; steering ignores).
- Update the `/refine` command description: `... [--proposer steering|dedupe] [--threshold 0.75]`.
- `loadConfig` is cached — `/refine` reading it is a no-op cost; steering
  behavior unchanged. Auto-refine reuses `runRefine` → inherits everything.

## 6. Exports — `src/index.ts`

Re-export from proposer.js: `planDedupe`, `type DedupeOptions`,
`DEDUPE_THRESHOLD` (additive; companion packages can layer their own policy).

## 7. Tests

**`test/proposer.test.ts`** (extend; existing dedupe tests keep passing by
passing explicit options):

- merge path: near-dup pair → exactly `[update(keeper), delete(dup)]`; update
  carries **only** `id` + `evidence` (content/importance untouched); delete
  reason names keeper + overlap.
- one keeper absorbs two dups → **1** update (3-way union) + 2 deletes.
- evidence union dedupes identical lines; cap → truncation marker present.
- `union === keeper.evidence` → delete only, no update delta.
- threshold respected: 0.55-overlap pair → nothing at 0.6, merge at 0.5;
  threshold 1 → identical-token-sets only.
- scope gate: global vs project → no merge; project vs project with different
  slug → no merge; same slug → merge.
- `merge: false` → delete-only, matching the legacy expectations verbatim.
- chain a≈b≈c (existing test): keeper absorbs both; union covers all three.
- cross-kind / cross-owner / inactive: unchanged (existing tests, now run
  against both merge modes).

**`test/config.test.ts`**: `dedupe` defaults (0.6 / true); explicit
`merge: false` respected; threshold coercion table (0, -0.5, 1.5, "0.7",
NaN → 0.6; 1 → 1).

**`test/refine-complete.test.ts`** (or new `refine-dedupe.test.ts`, following
its mock pattern): spy proposer via `registerProposer` asserts
`input.config.dedupe` is populated; `--threshold 0.75` reaches it; invalid
`--threshold abc` ignored + warning notified; end-to-end: `/refine --proposer
dedupe` on a mock store with a dup pair applies update+delete and appends the
`REFINE_ENTRY` audit with both rationales.

**`test/store.test.ts`** (only if not already covered generically): a
`[update, delete]` batch on disjoint ids applies atomically; a failure after
the update rolls both back.

## 8. Docs

- **README**: Proposers table `dedupe` row → merge description + `merge: false`
  escape hatch; Configuration sample gains `"dedupe": { "threshold": 0.6,
  "merge": true }` + bullet; Usage gains a `--threshold` example.
- **docs/MANUAL.md**: `/refine` flags + config key (match its existing style).
- **docs/ROADMAP.md**: Future-extensions "fuzzy corrections" bullet — mark the
  merge-dedupe half delivered in 0.10.0 (Phase 8 entry), corrections-from-
  outcomes still open.
- **CHANGELOG.md**: `## [0.10.0]` — Added (threshold config + flag, evidence
  union merge), Changed (dedupe default is merge — was delete-only).

## 9. Implementation order & release

1. `proposer.ts` (`DedupeOptions`, `planDedupe`, wrapper, `ProposeInput.config`)
   + `proposer.test.ts`.
2. `config.ts` (`NormalizedDedupe`, coercion) + `config.test.ts`.
3. `refine.ts` (config load + pass-through, `--threshold`, description) +
   wiring tests.
4. `index.ts` exports; README / MANUAL / ROADMAP / CHANGELOG; `package.json`
   → 0.10.0.

Per AGENTS.md: branch `feat/dedupe-merge`, `npm test && npm run typecheck`
green, PR → squash-merge → tag `v0.10.0` → CI (OIDC) publishes.

## Non-goals (explicit)

- No schema change to `HarnessItem` / `Delta` (merge uses existing ops only —
  old session snapshots replay unchanged).
- No content prose-merging, no importance bump on merge, no embeddings in v1
  (token Jaccard via the `similarity` seam; the Needle-embedding upgrade is a
  companion-package experiment — see Research grounding).
- Correction-side demotion from outcome signals: still open (ROADMAP).

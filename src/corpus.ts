// Calibration corpus exporter — the S1 half of the pi-reflex consumer contract
// (formerly pi-jev; CONTRACT-harness.md §4 in that project; issue #12 here).
//
// Turns the session's OWN audit trail — `harness-state` snapshots and
// `harness-refinement` entries — into two JSONL corpora for calibrating and
// evaluating a semantic decision engine (pi-reflex) against real harness
// decisions:
//
//   dedupe-pairs.jsonl  one record per compared item pair
//     - label "dup"     parsed from dedupe delete reasons (merged / near-
//                       duplicate); the run's ground truth
//     - label "not_dup" same-key-field pairs with token overlap in
//                       [NOT_DUP_FLOOR, threshold) that the planner did NOT
//                       merge; heuristic negatives, needs_review until a human
//                       confirms (the planner's threshold, not a label, decided)
//   lifecycle.jsonl     one record per item lifecycle event, classified from
//                       consecutive snapshot diffs:
//     created (id appears) · kept (+0.1) · dropped (−0.1) · cited (small
//     positive bump, the outcome loop's default +0.03) · pruned (removed with
//     last importance < IMPORTANCE_FLOOR) · deleted (removed otherwise)
//
// Pure: takes an entry iterable (e.g. ctx.sessionManager.getBranch()), returns
// records; no I/O here. The `/harness export-corpus` subcommand is thin glue.
//
// CONTRACT INVARIANT (local-only): records describe item CONTENTS. Export
// writes local files and nothing else — no network, no telemetry. The corpus
// leaves the machine only if the user pushes it.
//
// Determinism: same entries in, same records out (stable order, hashes of
// content only). Overlaps are rounded to 4 decimals for stable JSON.

import { createHash } from "node:crypto";
import { IMPORTANCE_FLOOR, REFINE_ENTRY, STATE_ENTRY } from "./store.js";
import { DEDUPE_THRESHOLD, durableLayer, tokenOverlap } from "./proposer.js";
import { DEFAULT_REF_BUMP } from "./config.js";
import { KEEP_DROP_BUMP } from "./types.js";
import type { AnyEntry, ComponentKind, HarnessItem, HarnessState } from "./types.js";

// ---- record types (contract §4; `v` follows the contract's major.minor) -----

export type LifecycleEvent = "created" | "cited" | "kept" | "dropped" | "pruned" | "deleted";

export interface LifecycleRecord {
  v: 1;
  kind: "lifecycle";
  item_kind: ComponentKind;
  /** sha256 of the item's content, prefixed — contents are not carried here. */
  content_hash: string;
  event: LifecycleEvent;
  /** Post-event importance. */
  importance: number;
}

export interface DedupePairRecord {
  v: 1;
  kind: "dedupe_pair";
  /** Keeper (dup label) / first-by-store-order (not_dup) content. */
  a: string;
  /** Duplicate (dup label) / second-by-store-order (not_dup) content. */
  b: string;
  label: "dup" | "not_dup";
  similarity: number;
  source: "tokenOverlap";
  /** Present on "not_dup" records: the label is inferred from non-merge, not
   *  human-confirmed. */
  needs_review?: true;
  meta: { kinds: ComponentKind[]; owners: string[] };
}

export interface CorpusResult {
  pairs: DedupePairRecord[];
  lifecycle: LifecycleRecord[];
}

/** Options for buildCorpus. */
export interface CorpusOptions {
  /** The CONFIGURED outcome-loop citation bump (harness.json
   *  `outcomeImportance.bump`; default 0.03 = DEFAULT_REF_BUMP). Classification
   *  is config-aware: keep/drop (±0.1) are checked FIRST, so a configured
   *  bump of exactly 0.1 collides and keep/drop win — documented behavior. */
  citeBump?: number | undefined;
}

// ---- tuning knobs -----------------------------------------------------------

/** Overlap floor for "not_dup" candidates: below it a pair is uninformative. */
export const NOT_DUP_FLOOR = 0.3;
// keep/drop bump magnitude: KEEP_DROP_BUMP (types.ts) — the single constant
// /harness keep|drop bumps by AND this classifier reads back out of snapshot
// diffs (the former harness.ts/corpus.ts hand-synced pair).
/** Classification tolerance around each bump (float safety, clamped bumps). */
const BUMP_TOL = 0.02;
/** Smallest importance delta worth classifying at all. */
const EPSILON = 0.005;

// ---- helpers ----------------------------------------------------------------

/** Parse a dedupe delete reason ("merged into h_x (overlap 0.71)" or the
 *  delete-only "near-duplicate of h_x (overlap 0.71)"). */
export function parseDedupeDelete(
  reason: string,
): { keeperId: string; overlap: number } | undefined {
  const m =
    /^(?:merged into|near-duplicate of) (h_[A-Za-z0-9_]+) \(overlap (0?\.\d+|1(?:\.0+)?)\)$/.exec(
      reason,
    );
  if (!m) return undefined;
  return { keeperId: m[1]!, overlap: Number(m[2]) };
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

function hash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

// ---- the shared audit-trail walk ---------------------------------------------

/** One `harness-refinement` audit entry, annotated with the snapshots around
 *  it (see walkAuditTrail for the attribution semantics). */
export interface RefineAuditStep {
  /** Manual vs auto (the audit entry's `source`). */
  source?: string | undefined;
  /** Which proposer ran. */
  proposer?: string | undefined;
  /** Direct-applied deltas (the entry's `appliedDeltas`; [] on legacy entries). */
  appliedDeltas: unknown[];
  /** Post-run state — the LAST harness-state snapshot on the branch so far.
   *  A run that applied deltas appends its snapshot immediately before its
   *  audit entry; a no-op run writes none, so "last" is correct either way. */
  current?: HarnessState | undefined;
  /** Pre-run state — the snapshot before `current` (undefined before the
   *  second snapshot). */
  pre?: HarnessState | undefined;
}

/** Walk the session branch's audit trail once, in order, notifying on every
 *  `harness-state` snapshot transition and every `harness-refinement` entry.
 *  THE shared walk (status.ts aggregates from it; buildCorpus builds records
 *  from it) — the two formerly carried two copies of the same traversal,
 *  implicit-EMPTY-baseline fix included, which had already drifted once.
 *
 *  Baseline note: a fresh session persists no empty harness-state entry, so
 *  the first snapshot's transition is reported against an implicit empty
 *  state (review #27) — without this, its `created` events are silently
 *  dropped. */
export function walkAuditTrail(
  entries: Iterable<unknown>,
  handlers: {
    onTransition?: (prev: HarnessState, next: HarnessState) => void;
    onRefine?: (step: RefineAuditStep) => void;
  },
): void {
  const snapshots: HarnessState[] = [];
  for (const raw of entries) {
    const entry = raw as AnyEntry;
    if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data?.state) {
      const next = entry.data.state;
      const prev = snapshots.at(-1) ?? { items: [] };
      handlers.onTransition?.(prev, next);
      snapshots.push(next);
      continue;
    }
    if (entry.type === "custom" && entry.customType === REFINE_ENTRY && entry.data) {
      handlers.onRefine?.({
        source: entry.data.source,
        proposer: entry.data.proposer,
        appliedDeltas: Array.isArray(entry.data.appliedDeltas) ? entry.data.appliedDeltas : [],
        current: snapshots.at(-1),
        pre: snapshots.at(-2),
      });
    }
  }
}

// ---- lifecycle ---------------------------------------------------------------

/** One classified lifecycle transition, with the item it happened to.
 *  Exported so the status report (src/status.ts) can aggregate events with
 *  owner-model attribution; `buildCorpus` maps these onto contract records. */
export interface LifecycleTransition {
  event: LifecycleEvent;
  /** Post-transition item (for removals: the removed item as last seen). */
  item: HarnessItem;
}

/** Classify one snapshot → next-snapshot transition into lifecycle events.
 *  `citeBump` is the CONFIGURED outcome-loop bump (see CorpusOptions). */
export function classifyTransition(
  prev: HarnessState,
  next: HarnessState,
  citeBump: number,
): LifecycleTransition[] {
  const out: LifecycleTransition[] = [];
  const prevById = new Map(prev.items.map((i) => [i.id, i]));
  const nextById = new Map(next.items.map((i) => [i.id, i]));

  for (const item of next.items) {
    const before = prevById.get(item.id);
    if (!before) {
      out.push({ event: "created", item });
      continue;
    }
    const d = item.importance - before.importance;
    if (Math.abs(d) < EPSILON) continue;
    // keep/drop FIRST: a configured citation bump of exactly ±0.1 collides and
    // keep/drop win (documented in CorpusOptions).
    if (Math.abs(d - KEEP_DROP_BUMP) <= BUMP_TOL) out.push({ event: "kept", item });
    else if (Math.abs(d + KEEP_DROP_BUMP) <= BUMP_TOL) out.push({ event: "dropped", item });
    else if (citeBump > 0 && Math.abs(d - citeBump) <= BUMP_TOL) out.push({ event: "cited", item });
    // else: explicit harness_mutate importance set — not a lifecycle signal.
  }
  for (const item of prev.items) {
    if (nextById.has(item.id)) continue;
    const event = item.importance < IMPORTANCE_FLOOR ? "pruned" : "deleted";
    out.push({ event, item });
  }
  return out;
}

function diffSnapshots(
  prev: HarnessState,
  next: HarnessState,
  citeBump: number,
  out: LifecycleRecord[],
): void {
  for (const t of classifyTransition(prev, next, citeBump)) {
    out.push(lifecycle(t.item, t.event, t.item.importance));
  }
}

function lifecycle(item: HarnessItem, event: LifecycleEvent, importance: number): LifecycleRecord {
  return {
    v: 1,
    kind: "lifecycle",
    item_kind: item.kind,
    content_hash: hash(item.content),
    event,
    importance,
  };
}

// ---- dedupe pairs --------------------------------------------------------------

/** Emit pair records for one dedupe refinement run.
 *
 *  `current` is the store state AT AUDIT TIME — a run that applied nothing
 *  writes NO harness-state snapshot, so "last snapshot" is correct whether or
 *  not this run wrote one (no-merge runs: current IS the pre-run state).
 *  `pre` (previous snapshot, only meaningful when the run applied deletes)
 *  supplies DELETED items' contents; keepers are read from `current`.
 *
 *  `deltas` comes from the audit entry's `appliedDeltas` (0.11.0+). Legacy
 *  entries carry only a numeric count — pass [] there: dup reconstruction is
 *  impossible without delete reasons, but not_dup candidates still emit. */
function collectDedupePairs(
  current: HarnessState,
  pre: HarnessState,
  deltas: unknown[],
  seen: Set<string>,
  out: DedupePairRecord[],
): void {
  const currentById = new Map(current.items.map((i) => [i.id, i]));
  const preById = new Map(pre.items.map((i) => [i.id, i]));

  const deletes = (deltas as Array<{ op?: string; id?: string; reason?: string }>).filter(
    (d) => d && d.op === "delete" && d.id && typeof d.reason === "string",
  );
  const deletedIds = new Set(deletes.map((d) => d.id!));

  for (const d of deletes) {
    const parsed = parseDedupeDelete(d.reason!);
    if (!parsed) continue;
    const keeper = currentById.get(parsed.keeperId) ?? preById.get(parsed.keeperId);
    const dup = preById.get(d.id!);
    if (!keeper || !dup) continue;
    pushPair(out, seen, keeper.content, dup.content, "dup", round4(parsed.overlap), {
      kinds: [keeper.kind],
      owners: [keeper.ownerModel, dup.ownerModel],
    });
  }

  // not_dup candidates: everything the planner COULD have compared (same key
  // fields, active, not deleted this run) but did not merge, with an
  // informative overlap. Always relative to the CURRENT state.
  const candidates = current.items.filter((i) => i.active && !deletedIds.has(i.id));
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      if (a.kind !== b.kind) continue;
      if (a.ownerModel !== b.ownerModel) continue;
      if (durableLayer(a) !== durableLayer(b)) continue;
      const sim = tokenOverlap(a.content, b.content);
      if (sim < NOT_DUP_FLOOR || sim >= DEDUPE_THRESHOLD) continue;
      pushPair(
        out,
        seen,
        a.content,
        b.content,
        "not_dup",
        round4(sim),
        { kinds: [a.kind], owners: [a.ownerModel] },
        true,
      );
    }
  }
}

function pushPair(
  out: DedupePairRecord[],
  seen: Set<string>,
  a: string,
  b: string,
  label: DedupePairRecord["label"],
  similarity: number,
  meta: DedupePairRecord["meta"],
  needsReview = false,
): void {
  const key = `${label}\x00${a}\x00${b}`;
  if (seen.has(key)) return; // one record per unique pair across runs
  seen.add(key);
  const rec: DedupePairRecord = {
    v: 1,
    kind: "dedupe_pair",
    a,
    b,
    label,
    similarity,
    source: "tokenOverlap",
    meta,
  };
  if (needsReview) rec.needs_review = true;
  out.push(rec);
}

// ---- entry-point ---------------------------------------------------------------

/**
 * Build the calibration corpora from an ordered session-branch entry iterable
 * (e.g. `ctx.sessionManager.getBranch()`). Pure and deterministic.
 *
 * Walk notes:
 *  - A dedupe run that APPLIED deltas appends its post-run `harness-state`
 *    snapshot immediately before its `harness-refinement` audit entry, so at
 *    an audit entry the last snapshot is the CURRENT state either way.
 *  - A no-merge run writes NO snapshot: the last snapshot is an older state
 *    that is still the current store (candidates emit from it).
 *  - Legacy audit entries (pre-0.11.0) carry `applied` as a COUNT with no
 *    delta details: dup reconstruction is skipped, candidates still emit.
 */
export function buildCorpus(entries: Iterable<unknown>, opts: CorpusOptions = {}): CorpusResult {
  const citeBump = opts.citeBump ?? DEFAULT_REF_BUMP;
  const pairs: DedupePairRecord[] = [];
  const lifecycle: LifecycleRecord[] = [];
  const seen = new Set<string>();
  walkAuditTrail(entries, {
    onTransition: (prev, next) => diffSnapshots(prev, next, citeBump, lifecycle),
    onRefine: (step) => {
      if (step.proposer !== "dedupe") return;
      if (!step.current) return; // no state seen yet — nothing to compare
      collectDedupePairs(step.current, step.pre ?? { items: [] }, step.appliedDeltas, seen, pairs);
    },
  });
  return { pairs, lifecycle };
}

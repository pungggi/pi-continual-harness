// Calibration corpus exporter — the S1 half of the pi-jev consumer contract
// (CONTRACT-harness.md §4 in the pi-jev project; issue #12 here).
//
// Turns the session's OWN audit trail — `harness-state` snapshots and
// `harness-refinement` entries — into two JSONL corpora for calibrating and
// evaluating a semantic decision engine (pi-jev) against real harness
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
import { DEDUPE_THRESHOLD, tokenOverlap } from "./proposer.js";
import type { ComponentKind, HarnessItem, HarnessState } from "./types.js";

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

// ---- tuning knobs -----------------------------------------------------------

/** Overlap floor for "not_dup" candidates: below it a pair is uninformative. */
export const NOT_DUP_FLOOR = 0.3;
/** keep/drop bump magnitude (harness.ts handleBump). */
const KEEP_DROP_BUMP = 0.1;
/** Classification tolerance around ±0.1 (float safety, clamped bumps). */
const BUMP_TOL = 0.02;
/** Cited: positive bump in (0, 0.06] that is not a keep (outcome default 0.03;
 *  a keep clamped at importance 1.0 lands at +0.05 and still reads as cited). */
const CITE_MAX = 0.06;
/** Smallest importance delta worth classifying at all. */
const EPSILON = 0.005;

// ---- helpers ----------------------------------------------------------------

/** Loose entry shape, kept decoupled from pi's internal session types. */
type AnyEntry = {
  type?: string;
  customType?: string;
  data?: {
    state?: HarnessState;
    proposer?: string;
    applied?: unknown[];
  };
};

/** Parse a dedupe delete reason ("merged into h_x (overlap 0.71)" or the
 *  delete-only "near-duplicate of h_x (overlap 0.71)"). */
export function parseDedupeDelete(
  reason: string,
): { keeperId: string; overlap: number } | undefined {
  const m = /^(?:merged into|near-duplicate of) (h_[A-Za-z0-9_]+) \(overlap (0?\.\d+|1(?:\.0+)?)\)$/.exec(
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

/** Durable placement, mirroring planDedupe's private key: only items in the
 *  same layer were ever compared by the planner. */
function durableLayer(i: HarnessItem): string {
  return i.scope === "project" ? `project:${i.project ?? ""}` : "global";
}

// ---- lifecycle ---------------------------------------------------------------

/** Classify one snapshot → next-snapshot transition into lifecycle records. */
function diffSnapshots(prev: HarnessState, next: HarnessState, out: LifecycleRecord[]): void {
  const prevById = new Map(prev.items.map((i) => [i.id, i]));
  const nextById = new Map(next.items.map((i) => [i.id, i]));

  for (const item of next.items) {
    const before = prevById.get(item.id);
    if (!before) {
      out.push(lifecycle(item, "created", item.importance));
      continue;
    }
    const d = item.importance - before.importance;
    if (Math.abs(d) < EPSILON) continue;
    if (Math.abs(d - KEEP_DROP_BUMP) <= BUMP_TOL) out.push(lifecycle(item, "kept", item.importance));
    else if (Math.abs(d + KEEP_DROP_BUMP) <= BUMP_TOL)
      out.push(lifecycle(item, "dropped", item.importance));
    else if (d > 0 && d <= CITE_MAX) out.push(lifecycle(item, "cited", item.importance));
    // else: explicit harness_mutate importance set — not a lifecycle signal.
  }
  for (const item of prev.items) {
    if (nextById.has(item.id)) continue;
    const event = item.importance < IMPORTANCE_FLOOR ? "pruned" : "deleted";
    out.push(lifecycle(item, event, item.importance));
  }
}

function lifecycle(item: HarnessItem, event: LifecycleEvent, importance: number): LifecycleRecord {
  return { v: 1, kind: "lifecycle", item_kind: item.kind, content_hash: hash(item.content), event, importance };
}

// ---- dedupe pairs --------------------------------------------------------------

/** Emit pair records for one dedupe refinement run. `pre` is the snapshot
 *  before the run (dup contents live there), `post` the snapshot the run wrote
 *  (keeper contents, post-merge evidence). Non-merge runs (applied = []) still
 *  yield "not_dup" candidates from `pre`. */
function collectDedupePairs(
  pre: HarnessState,
  post: HarnessState,
  applied: unknown[],
  seen: Set<string>,
  out: DedupePairRecord[],
): void {
  const preById = new Map(pre.items.map((i) => [i.id, i]));
  const postById = new Map(post.items.map((i) => [i.id, i]));

  const deletes = (applied as Array<{ op?: string; id?: string; reason?: string }>).filter(
    (d) => d.op === "delete" && d.id && typeof d.reason === "string",
  );
  const deletedIds = new Set(deletes.map((d) => d.id!));

  for (const d of deletes) {
    const parsed = parseDedupeDelete(d.reason!);
    if (!parsed) continue;
    const keeper = postById.get(parsed.keeperId) ?? preById.get(parsed.keeperId);
    const dup = preById.get(d.id!);
    if (!keeper || !dup) continue;
    pushPair(
      out,
      seen,
      keeper.content,
      dup.content,
      "dup",
      round4(parsed.overlap),
      { kinds: [keeper.kind], owners: [keeper.ownerModel, dup.ownerModel] },
    );
  }

  // not_dup candidates: everything the planner COULD have compared (same key
  // fields, both active, neither deleted this run) but did not merge, with an
  // informative overlap. The run's threshold is not recorded in the audit
  // entry, so the shipped default decides the boundary.
  const candidates = pre.items.filter((i) => i.active && !deletedIds.has(i.id));
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
  const rec: DedupePairRecord = { v: 1, kind: "dedupe_pair", a, b, label, similarity, source: "tokenOverlap", meta };
  if (needsReview) rec.needs_review = true;
  out.push(rec);
}

// ---- entry-point ---------------------------------------------------------------

/**
 * Build the calibration corpora from an ordered session-branch entry iterable
 * (e.g. `ctx.sessionManager.getBranch()`). Pure and deterministic.
 *
 * Walk order note: a dedupe run appends its post-run `harness-state` snapshot
 * BEFORE its `harness-refinement` audit entry, so at an audit entry the last
 * two snapshots are (pre-run, post-run).
 */
export function buildCorpus(entries: Iterable<unknown>): CorpusResult {
  const pairs: DedupePairRecord[] = [];
  const lifecycle: LifecycleRecord[] = [];
  const seen = new Set<string>();
  const snapshots: HarnessState[] = [];
  for (const raw of entries) {
    const entry = raw as AnyEntry;
    if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data?.state) {
      const next = entry.data.state;
      const prev = snapshots.at(-1);
      if (prev) diffSnapshots(prev, next, lifecycle);
      snapshots.push(next);
      continue;
    }
    if (
      entry.type === "custom" &&
      entry.customType === REFINE_ENTRY &&
      entry.data?.proposer === "dedupe"
    ) {
      const post = snapshots.at(-1);
      const pre = snapshots.at(-2) ?? { items: [] };
      if (post) collectDedupePairs(pre, post, entry.data.applied ?? [], seen, pairs);
    }
  }
  return { pairs, lifecycle };
}

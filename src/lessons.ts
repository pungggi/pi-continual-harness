// lessons.ts — harnessing-level recursion (Harness², arXiv 2610.14224 §2.3).
//
// Harness² separates two loops: task-level recursion improves the harness for
// the CURRENT task, while harnessing-level recursion lets the IMPROVEMENT
// PROCESS ITSELF learn from what past refinements revealed. Its library rule:
// "lessons are retained only when supported by execution contrasts" — never
// from the mere fact that an edit was proposed.
//
// This module is our online-sized take on that rule, built entirely from
// signals we already persist:
//  - item support counters (citations from the outcome loop, keeps/drops from
//    /harness keep|drop) — the "execution contrast" proxy: adoption followed
//    by observed use (or by the human explicitly rejecting it);
//  - harness-refinement audit entries on the branch — which refine runs
//    produced durable deltas vs. no-ops.
//
// Two consumers:
//  - buildLessonsDigest() → injected into the /refine steering prompt (and any
//    other proposer via ProposeInput.lessons), so the improver starts from
//    what past improvement actually yielded.
//  - recentIneffectiveRuns() → the history gate for auto-refine (skip a
//    cadenced refine when the last N runs were all no-ops).
//
// Everything here is PURE over (state, branch entries): no I/O, no config,
// fully unit-testable, and silent when there is nothing supportable to say.

import type { HarnessItem, HarnessState } from "./types.js";
import { preview } from "./list.js";
import { REFINE_ENTRY, STATE_ENTRY } from "./store.js";

/** Char cap on one item line inside the digest (bounded prompt block). */
const DIGEST_PREVIEW_CHARS = 90;

/** One-line, whitespace-flattened preview (shared style with list rows). */
function flat(text: string, max: number): string {
  return preview(text, max);
}

/** What a harness-refinement entry records (subset we consume). */
export interface RefineRun {
  /** Manual /refine vs. cadenced auto-refine. */
  source?: string | undefined;
  /** Which proposer ran. */
  proposer?: string | undefined;
  /** Deltas applied DIRECTLY by the proposer (0 for the steering path at
   *  entry-creation time — effectiveness is then inferred from a following
   *  harness-state entry, see classifyRuns). */
  applied?: number | undefined;
  /** ms epoch (entry data startedAt). */
  at?: number | undefined;
  /** True when a harness-state mutation landed AFTER this refine entry and
   *  before the next one — the steering agent actually mutated. */
  followedByStateChange?: boolean | undefined;
}

/** Annotate runs with followedByStateChange by co-walking state entries.
 *
 *  Attribution subtlety (review r4341960980): runRefine writes a direct-apply
 *  run's harness-state snapshot BEFORE that run's own audit entry, so a state
 *  entry sitting between run k and run k+1 may belong to EITHER. Disambiguate
 *  by ownership: if run k+1 direct-applied (applied > 0), exactly one of those
 *  state entries is its own snapshot and must NOT be credited to run k.
 *  Leftover entries credit run k (its steering mutation — or a human keep/drop
 *  in between, an acceptable false credit: it only ever LIFTS the gate, never
 *  makes it skip). */
export function classifyRuns(entries: Iterable<unknown>): RefineRun[] {
  const runs: RefineRun[] = [];
  let pending: RefineRun | undefined;
  // harness-state entries seen since `pending`'s audit entry.
  let stateAfter = 0;
  const flush = (nextApplied?: number): void => {
    if (pending) {
      const ownedByNext = (nextApplied ?? 0) > 0 ? 1 : 0;
      pending.followedByStateChange = stateAfter - ownedByNext > 0;
      runs.push(pending);
    }
    pending = undefined;
    stateAfter = 0;
  };
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as { type?: string; customType?: string; data?: Record<string, unknown> };
    if (e.type === "custom" && e.customType === STATE_ENTRY) {
      if (pending) stateAfter += 1;
      continue;
    }
    if (e.type === "custom" && e.customType === REFINE_ENTRY) {
      const next: RefineRun = {
        source: e.data?.source as string | undefined,
        proposer: e.data?.proposer as string | undefined,
        applied: e.data?.applied as number | undefined,
        at: e.data?.startedAt as number | undefined,
      };
      // Flush the previous run knowing whether the new one direct-applied.
      flush(next.applied);
      pending = next;
    }
  }
  flush(); // last run: any state entry after its audit is attributable to it
  return runs;
}

/** A run is EFFECTIVE when the proposer applied deltas directly, or the
 *  steering agent mutated state right after. No-ops are everything else. */
export function isEffectiveRun(r: RefineRun): boolean {
  return (r.applied ?? 0) > 0 || r.followedByStateChange === true;
}

/**
 * History gate (auto-refine): true when the LAST `n` refine runs (fewer if
 * the branch holds fewer) were ALL ineffective — a cadenced refine over the
 * same quiet trajectory would most likely be another no-op. n <= 0 always
 * returns false (gate off).
 */
export function recentIneffectiveRuns(entries: Iterable<unknown>, n: number): boolean {
  if (n <= 0) return false;
  const runs = classifyRuns(entries);
  if (runs.length === 0) return false;
  const last = runs.slice(-n);
  return last.length === n && last.every((r) => !isEffectiveRun(r));
}

// ---- the digest -----------------------------------------------------------

/** Positive support score: citations weigh double keeps (organic use is a
 *  stronger contrast than a human nudge), drops are negative. */
function supportScore(i: HarnessItem): number {
  const s = i.support;
  if (!s) return 0;
  return 2 * (s.citations ?? 0) + (s.keeps ?? 0) - 2 * (s.drops ?? 0);
}

export interface DigestOptions {
  /** Max supported items listed (default 5). */
  maxSupported?: number;
  /** Max struggling items listed (default 3). */
  maxStruggling?: number;
  /** Refine runs summarized (default 6). */
  runsWindow?: number;
  /** Hard character cap on the whole digest (default 1200). */
  maxChars?: number;
  /** Model-binding key (see vmodel.resolveBindingKey): only items OWNED by
   *  this model are named (review r4341960955) — the digest must respect the
   *  same per-model isolation as injection, otherwise a fresh model is fed
   *  foreign notes and told to delete ids it cannot mutate
   *  (assertOwnsItem rejects them). Undefined = no owner filter (callers that
   *  know the actor — runRefine — always pass it, `""` for an unknown model). */
  ownerKey?: string | undefined;
}

/** Cap an assembled digest: drop trailing sections until it fits. */
function cap(sections: string[], maxChars: number): string {
  const out: string[] = [];
  let total = 0;
  for (const s of sections) {
    if (total + s.length > maxChars && out.length > 0) break;
    out.push(s);
    total += s.length;
  }
  return out.join("\n");
}

/**
 * Build the lessons digest injected into the refine steering prompt. Every
 * line is evidence-gated (Harness²'s retention rule): supported items must
 * have organic citations or keeps, struggling items must show explicit
 * negative signal (drops) — never-cited-but-never-dropped items are NOT
 * named (no signal is not a negative signal). Returns "" when there is
 * nothing supportable to say, so the prompt stays unchanged for fresh stores.
 * Pure.
 */
export function buildLessonsDigest(
  state: HarnessState,
  entries: Iterable<unknown>,
  opts: DigestOptions = {},
): string {
  const sections: string[] = [];
  const active = state.items.filter(
    (i) => i.active && (opts.ownerKey === undefined || i.ownerModel === opts.ownerKey),
  );

  // 1. Supported — proven useful since adoption.
  const supported = active
    .filter((i) => supportScore(i) > 0)
    .sort((a, b) => supportScore(b) - supportScore(a))
    .slice(0, opts.maxSupported ?? 5);
  if (supported.length > 0) {
    sections.push(
      [
        `Proven useful (do not duplicate; strengthen only with new evidence):`,
        ...supported.map((i) => {
          const s = i.support!;
          const bits = [
            s.citations ? `cited ${s.citations}×` : "",
            s.keeps ? `kept ${s.keeps}×` : "",
          ].filter(Boolean);
          return `- [${i.id}] (${bits.join(", ")}): ${flat(i.content, DIGEST_PREVIEW_CHARS)}`;
        }),
      ].join("\n"),
    );
  }

  // 2. Struggling — explicit NEGATIVE net signal only (drops strictly
  //    outweigh any later use). An item dropped once and then cited again
  //    (score 0) or cited more than dropped (score > 0) is contested, not
  //    rejected — later execution evidence outranks the drop (review
  //    r4341960962). Net-neutral items are never named (no signal ≠ negative).
  const struggling = active
    .filter((i) => (i.support?.drops ?? 0) > 0 && supportScore(i) < 0)
    .sort((a, b) => (b.support!.drops ?? 0) - (a.support!.drops ?? 0))
    .slice(0, opts.maxStruggling ?? 3);
  if (struggling.length > 0) {
    sections.push(
      [
        `Rejected signals (candidates to delete or rewrite — past drops, no use since):`,
        ...struggling.map(
          (i) =>
            `- [${i.id}] (dropped ${i.support!.drops}×): ${flat(i.content, DIGEST_PREVIEW_CHARS)}`,
        ),
      ].join("\n"),
    );
  }

  // 3. Refine-run history — how productive past improvement was.
  const runs = classifyRuns(entries);
  const window = opts.runsWindow ?? 6;
  const recent = runs.slice(-window);
  if (recent.length > 0) {
    const effective = recent.filter(isEffectiveRun).length;
    const noOps = recent.length - effective;
    const line =
      noOps === 0
        ? `Refine history: all ${recent.length} recent run(s) produced durable deltas — keep proposing surgical, evidence-backed edits.`
        : `Refine history: ${noOps} of the last ${recent.length} run(s) proposed nothing durable — only record a correction when the trajectory clearly supports it; say so and do nothing otherwise.`;
    sections.push(line);
  }

  if (sections.length === 0) return "";
  const header = "## Lessons from past refines (evidence-gated — apply when relevant)";
  return cap([header, ...sections], opts.maxChars ?? 1200);
}

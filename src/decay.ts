// Trial decay — the expiry half of the provenance trust boundary (0.21.0).
//
// Provenance gates how unverified items are PRESENTED (label) and how they
// contend for the injection budget (priority), but on their own they never
// retire anything: an agent-authored note with no owner confirmation and no
// organic use lives in the store forever, and a long-lived self-improving
// session accumulates them without bound (the "self-grown checklist ate the
// time it saved" failure). Trial decay closes that loop with the signals the
// store already carries:
//
//   ON TRIAL   — active, provenance "agent" (unverified), and no positive
//                support yet (no citations from the outcome loop, no human
//                /harness keep). Cited/kept items have been re-grounded in
//                later trajectories, so they are off the hook.
//   DECAY      — a stale on-trial item (createdAt older than `afterDays`)
//                loses `step` importance per cadence fire. The clock is
//                CREATION, deliberately: every update path touches updatedAt
//                (content rewrites, importance nudges, dedupe merges, durable
//                imports), so an updatedAt-keyed trial only ever reaped
//                ABANDONED notes — a session that kept touching its own
//                notes never accumulated staleness (the review's finding:
//                that is exactly the self-maintenance failure this pass
//                exists to bound). createdAt is the one timestamp no delta
//                can rewind; the only exemptions are EARNED (a citation or
//                a keep), and the owner trust path is the durable file's
//                provenance line (hand-delete → trusted → off trial).
//   EXPIRE     — when the next step would land below IMPORTANCE_FLOOR, the
//                item is deleted outright (the trial failed). Owner-authored
//                items are never touched: the trusted core is the owner's to
//                prune (/harness prune --decay), not this loop's.
//
// Like auto-refine and the outcome loop, this is an autonomous mutation path,
// so it is opt-in (`trialDecay` in harness.json), cadence-gated on completed
// turns, persisted through the same harness-state entries (/tree rollback),
// and visible (one notify per fire that changed something). The decision
// logic is pure (planTrialDecay) and unit-tested without a live pi runtime.

import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_TRIAL_AFTER_DAYS,
  DEFAULT_TRIAL_EVERY_TURNS,
  DEFAULT_TRIAL_STEP,
  loadConfig,
} from "./config.js";
import { IMPORTANCE_FLOOR, applyTrialDecay, getState, makePersist } from "./store.js";
import { makeTurnCadence } from "./cadence.js";
import type { HarnessItem, TrialAction, TrialDecayPlan } from "./types.js";

// Re-exported for convenience: the plan types live in types.ts beside the
// item/delta types every other module shares, and the pass defaults live in
// config.ts beside every other tunable's default.
export {
  DEFAULT_TRIAL_AFTER_DAYS,
  DEFAULT_TRIAL_EVERY_TURNS,
  DEFAULT_TRIAL_STEP,
} from "./config.js";
export type { TrialAction, TrialDecayPlan };

/** ms per day — the unit `afterDays` converts from. */
const MS_PER_DAY = 86_400_000;

/** True when the item has EARNED retention: cited by the agent in later
 *  trajectories (outcome loop) or explicitly kept by the human. Drops are
 *  not positive support — a dropped item still decays (the human signal is
 *  already negative, decay just finishes what /harness drop started). */
export function hasPositiveSupport(item: HarnessItem): boolean {
  return (item.support?.citations ?? 0) > 0 || (item.support?.keeps ?? 0) > 0;
}

/** True when the item is ON TRIAL: active, agent-authored (unverified), and
 *  not yet supported. These are the only items trial decay ever considers. */
export function isOnTrial(item: HarnessItem): boolean {
  return item.active && item.provenance === "agent" && !hasPositiveSupport(item);
}

/** Options for the pure planner. */
export interface TrialDecayOptions {
  /** ms epoch "now" (defaults to Date.now() — pass explicitly in tests). */
  now?: number;
  /** Staleness gate in days, measured from each item's CREATION (default 14). */
  afterDays?: number | undefined;
  /** Importance lost per pass (default 0.05). */
  step?: number | undefined;
}

/**
 * Plan one trial-decay pass. PURE: state in, decisions out — the store is
 * untouched, so this is fully unit-testable and the caller decides what to do
 * with the plan (the turn_end handler applies it via store.applyTrialDecay).
 * Eligibility is `isOnTrial` + `createdAt` older than `afterDays` (see the
 * module header for why creation, not last update, is the trial clock); the
 * next importance is `max(0, importance - step)`, and an item whose next
 * value lands below IMPORTANCE_FLOOR expires (is deleted) instead of
 * decaying.
 */
export function planTrialDecay(items: HarnessItem[], opts: TrialDecayOptions = {}): TrialDecayPlan {
  const now = opts.now ?? Date.now();
  const afterDays = opts.afterDays ?? DEFAULT_TRIAL_AFTER_DAYS;
  const step = opts.step ?? DEFAULT_TRIAL_STEP;
  const cutoff = now - afterDays * MS_PER_DAY;
  const actions: TrialAction[] = [];
  for (const item of items) {
    if (!isOnTrial(item)) continue;
    if (item.createdAt > cutoff) continue; // fresh trial: created recently
    const to = Math.max(0, item.importance - step);
    if (to < IMPORTANCE_FLOOR) {
      actions.push({ op: "expire", id: item.id, from: item.importance });
    } else {
      actions.push({ op: "decay", id: item.id, from: item.importance, to });
    }
  }
  return { actions, stale: actions.length };
}

// ---- the opt-in turn_end pass -----------------------------------------------

// The trial-decay cadence counter (shared implementation — see cadence.ts).
const cadence = makeTurnCadence();

// Session-scoped: item ids whose decay already notified once this session.
// A long sweep (one item stepping 0.5 → floor across several passes) would
// otherwise re-notify every pass — notifications are context too (the same
// lesson that motivated the pass). An item's FIRST decay notifies; every
// expiry notifies; silent afterwards. Reset with the cadence at
// session_start.
const decayNotified = new Set<string>();

/** Test/session hook: reset the cadence and the notify memory (fresh
 *  session → fresh window, un-notified items). */
export function resetTrialDecay(): void {
  cadence.reset();
  decayNotified.clear();
}

/**
 * Decide whether a trial-decay pass is due this turn. Side-effectful on the
 * cadence only (seed/advance/reset), mirroring evaluateAutoRefine: the first
 * observed completed turn seeds the baseline, aborted/error turns are inert,
 * and a fired pass resets the count.
 */
export function evaluateTrialDecay(
  enabled: boolean,
  everyTurns: number,
  outcome?: string,
): boolean {
  if (!enabled) return false;
  return cadence.tick(everyTurns, outcome);
}

/** turn_end handler — plan + apply one trial-decay pass (opt-in). Exported
 *  so the thin entry (entry.ts) can delegate via dynamic import. */
export async function handleTrialDecayTurnEnd(
  pi: ExtensionAPI,
  event: TurnEndEvent,
  ctx: ExtensionContext,
): Promise<void> {
  const config = await loadConfig();
  // Optional chaining + defaults even though loadConfig always populates the
  // block: the type says optional, and a companion calling with a partial
  // config must never crash the turn_end chain.
  const every = config.trialDecay?.everyTurns ?? DEFAULT_TRIAL_EVERY_TURNS;
  if (!evaluateTrialDecay(config.trialDecay?.enabled === true, every, event.outcome)) return;

  const plan = planTrialDecay(getState().items, {
    afterDays: config.trialDecay?.afterDays,
    step: config.trialDecay?.step,
  });
  const { expired } = applyTrialDecay(plan, makePersist(pi));
  // Notify memory: first decay per item per session + every expiry.
  const firstDecays = plan.actions.filter(
    (a) => a.op === "decay" && !decayNotified.has(a.id),
  ) as Array<{ op: "decay"; id: string; from: number; to: number }>;
  for (const a of firstDecays) decayNotified.add(a.id);
  if (expired === 0 && firstDecays.length === 0) return; // nothing new to say

  const step = config.trialDecay?.step ?? DEFAULT_TRIAL_STEP;
  const parts: string[] = [];
  if (firstDecays.length > 0) {
    parts.push(
      `${firstDecays.length} stale unverified item(s) now decaying (−${step.toFixed(2)} per pass)`,
    );
  }
  if (expired > 0) {
    parts.push(`${expired} expired (trial failed — below the importance floor, deleted)`);
  }
  ctx.ui.notify(
    `Trial decay: ${parts.join("; ")}. Confirm a useful item with /harness keep <id> so it stops decaying.`,
    "info",
  );
}

/** Subscribe to turn_end and run the trial-decay pass (opt-in). Test-facing
 *  registration path (the thin entry delegates to the handler directly). */
export function registerTrialDecay(pi: ExtensionAPI): void {
  pi.on("turn_end", (event, ctx) => handleTrialDecayTurnEnd(pi, event, ctx));
}

// turn_end auto-refine (Phase 3 of the roadmap). This is the package's ONE
// autonomous-self-mutation path, so it is locked behind an explicit opt-in:
//
//   ~/.pi/agent/harness.json
//   { "autoRefine": { "enabled": true, "everyTurns": 100, "commit": false } }
//
// When enabled and the cadence elapses, it runs the SAME runRefine() routine as
// /refine — no parallel mutation logic — so it inherits all the safety
// properties: structured evidence-backed deltas, an audited REFINE_ENTRY
// (tagged source: "auto"), branch-local snapshots, and /tree rollback.
//
// Two pi ≥ 0.87/0.99 upgrades (0.12.0):
//
//  - Classifier gate (opt-in via autoRefine.gate + classifier.model): before
//    spending a refine, ask ONE cheap yes/no classifier question over the
//    recent trajectory. "No durable correction" skips the refine entirely —
//    cadence becomes signal, not just time. Soft-fails to the plain cadence on
//    any classifier error (the gate can skip work, never block it).
//
//  - Boundary delivery: the steering message is no longer sent as a synthetic
//    user message; runRefine returns it undelivered and this handler persists
//    it as a structural custom-message entry with `{ entries, continue: true }`
//    — the actionable turn_end boundary. One guaranteed next provider request,
//    no steering queue and no follow-up scheduling side effects. Falls back to
//    sendUserMessage when the boundary cannot continue (event.context.
//    canContinue false, e.g. after an error turn).
//
// It stays visible: it notifies before firing, and the boundary draft (and the
// gate decision) appear in the transcript. The decision logic is factored into
// evaluateAutoRefine() so it is unit-testable without a live pi runtime.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AUTO_EVERY_TURNS, type HarnessConfig, loadConfig } from "./config.js";
import { runRefine, gatherEvidence, DEFAULT_LOOKBACK_TURNS } from "./refine.js";
import { buildClassify, buildGateRequest, gateDecision } from "./classify.js";

// turnIndex of the last auto-refine (or the seeded baseline). -1 = unseen.
let lastTurn = -1;

/** Test hook: reset internal counter. */
export function resetAutoRefine(): void {
  lastTurn = -1;
}

/**
 * Decide whether to auto-refine this turn. Side-effectful: the first observed
 * turn seeds the baseline (no refine then); each fired refine resets it, which
 * also prevents the refine turn itself from immediately re-triggering.
 */
export function evaluateAutoRefine(config: HarnessConfig, turnIndex: number): boolean {
  if (!config.autoRefine?.enabled) return false;
  const every = config.autoRefine.everyTurns ?? DEFAULT_AUTO_EVERY_TURNS;
  if (every <= 0) return false;
  if (lastTurn < 0) {
    lastTurn = turnIndex;
    return false;
  }
  if (turnIndex - lastTurn >= every) {
    lastTurn = turnIndex;
    return true;
  }
  return false;
}

/** The boundary draft custom type for auto-refine steering messages. */
export const AUTO_REFINE_ENTRY = "harness.auto-refine-request";

/** Build the boundary draft carrying a steering message. Pure — testable. */
export function buildRefineDraft(steeringMessage: string): {
  type: "custom_message";
  customType: string;
  content: string;
  display: boolean;
} {
  return { type: "custom_message", customType: AUTO_REFINE_ENTRY, content: steeringMessage, display: true };
}

/** Structural slice of pi's ProjectedSessionEntry (sourceEntry + messages). */
export interface ProjectedLike {
  sourceEntry?: { type?: string; customType?: string; id?: string };
  messages?: unknown[];
}

/** A context_edit boundary draft (pi ≥ 0.87): omit one entry from future
 *  provider context — raw history, usage, and UI history stay untouched. */
export interface OmissionDraft {
  type: "context_edit";
  targetId: string;
  replacement: null;
}

/**
 * Context-edit drafts omitting every LIVE prior auto-refine request from
 * future provider context (pi ≥ 0.87 ContextEditEntry). Invariant: at most
 * ONE auto-refine request is ever model-visible — the newest. Already-omitted
 * drafts surface in the projection with empty `messages` and are skipped, so
 * the operation is idempotent and never stacks redundant edits. Raw history
 * (and the HTML export) keeps every draft: /tree rollback still applies.
 */
export function buildOmissionDrafts(projected: Iterable<ProjectedLike>): OmissionDraft[] {
  const drafts: OmissionDraft[] = [];
  for (const p of projected) {
    const src = p.sourceEntry;
    if (src?.type !== "custom_message" || src.customType !== AUTO_REFINE_ENTRY) continue;
    if ((p.messages?.length ?? 0) === 0) continue; // already omitted → skip
    if (typeof src.id === "string") drafts.push({ type: "context_edit", targetId: src.id, replacement: null });
  }
  return drafts;
}

/** Subscribe to turn_end and run /refine on the configured cadence. */
export function registerAutoRefine(pi: ExtensionAPI): void {
  pi.on("turn_end", async (event, ctx) => {
    const config = await loadConfig();
    if (!evaluateAutoRefine(config, event.turnIndex)) return;
    const every = config.autoRefine?.everyTurns ?? DEFAULT_AUTO_EVERY_TURNS;

    // Opt-in classifier gate: cheap yes/no before spending the refine.
    if (config.autoRefine?.gate) {
      const classify = buildClassify(ctx, config.classifier?.model);
      if (classify) {
        const evidence = gatherEvidence(ctx, DEFAULT_LOOKBACK_TURNS);
        const res = await classify(buildGateRequest(evidence));
        const decision = gateDecision(res);
        if (!decision.proceed) {
          ctx.ui.notify(`Auto-refine: skipped — ${decision.because}.`, "info");
          return;
        }
        ctx.ui.notify(`Auto-refine: gate passed (${decision.because}).`, "info");
      }
      // No resolvable classifier → plain cadence behavior (documented soft-fail).
    }

    ctx.ui.notify(`Auto-refine: running /refine (every ${every} turns, opt-in).`, "info");
    try {
      const result = await runRefine(
        pi,
        ctx,
        {
          commit: config.autoRefine?.commit ?? false,
          ...(config.proposer ? { proposer: config.proposer } : {}),
          delivery: "boundary",
        },
        "auto",
      );
      // Boundary delivery: persist the steering message as a structural entry
      // and guarantee one next provider request. Only when the boundary CAN
      // continue — otherwise fall back to the legacy steering send.
      if (result.steeringMessage) {
        if (event.context?.canContinue === false) {
          pi.sendUserMessage(result.steeringMessage);
          return;
        }
        // Hygiene (pi ≥ 0.87 context edits): omit every LIVE prior auto-refine
        // request from future provider context, so at most one draft (the new
        // one) is ever model-visible. Already-omitted drafts are skipped by
        // buildOmissionDrafts; raw history and /tree rollback are untouched.
        // Kill-switch: autoRefine.omitStaleDrafts: false.
        const omissions =
          config.autoRefine?.omitStaleDrafts === false
            ? []
            : buildOmissionDrafts(event.context?.contextEntries ?? []);
        return {
          entries: [...event.entries, ...omissions, buildRefineDraft(result.steeringMessage)],
          continue: true,
        };
      }
    } catch (err) {
      ctx.ui.notify(`Auto-refine failed: ${(err as Error).message}`, "error");
    }
  });
}

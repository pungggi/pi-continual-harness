// Pluggable delta proposers (Phase 4 of the roadmap).
//
// /refine is split into two stages:
//   1. PROPOSE — given trajectory evidence + current state, decide what deltas
//      to apply (or what to ask the agent to do).
//   2. APPLY   — either send a steering message (the agent reasons + calls
//      harness_mutate) or apply returned deltas directly.
//
// This file owns stage 1. The default `steeringProposer` preserves the
// original behavior exactly (delegates to the agent via a steering message,
// reusing the agent loop — model-agnostic, fully visible). Alternate proposers
// produce deltas directly:
//   - `dedupeProposer` (rule-based): drops near-duplicate active items by token
//     overlap, keeping the higher-importance one. Pure function of state —
//     deterministic, no model call, fully testable.
//
// The interface supports a dedicated-model proposer — one that makes its own
// hidden LLM call to produce deltas directly, instead of delegating to the
// agent via a steering message. This package does NOT ship one (hidden model
// spend is a tradeoff the roadmap keeps as a separate decision), but it DOES
// inject a one-shot `complete` into ProposeInput when a model is available, so a
// companion package can register one. The closure is built by runRefine from
// ctx.modelRegistry; telemetry a proposer returns is recorded in the refine
// audit entry, so the spend stays visible (audited, not hidden).
//
// Extension is open: call registerProposer() from your own extension to add a
// named proposer, then select it via /refine --proposer <name> or config.

import type { Delta, HarnessItem, HarnessState } from "./types.js";

/** Options for the one-shot model completion injected into ProposeInput. */
export interface CompleteOptions {
  /** Resolve and use this model id ("provider/id" or a bare id) instead of the
   *  active session model. Falls back to the active model if unresolvable. */
  modelId?: string;
  /** System prompt wrapping the user prompt. */
  systemPrompt?: string;
  /** Max output tokens for the completion (maps to the provider maxTokens). */
  maxOutputTokens?: number;
}

/** Result of a one-shot model completion. */
export interface CompleteResult {
  /** The assistant's text response. */
  text: string;
  /** The resolved model label ("provider/id"), for accurate audit telemetry. */
  model?: string;
  /** Token usage, when the provider reports it (for the audit trail). */
  usage?: { input: number; output: number };
}

/** Telemetry from a dedicated model call, surfaced in the refine audit entry so
 *  hidden model spend is visible (which model, tokens, latency, ok/error). */
export interface ModelCallTelemetry {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  ok: boolean;
  error?: string;
}

/** Inputs to a proposer. */
export interface ProposeInput {
  /** Recent trajectory evidence (the same string /refine gathers). */
  evidence: string;
  /** Current harness state as a defensive copy; mutations are ignored — use
   *  the returned deltas to change state. */
  state: HarnessState;
  /** Lookback window in turns. */
  lookback: number;
  /** One-shot model completion, injected by runRefine when a model is available.
   *  Dedicated-model proposers call this to make a hidden completion; rule-based
   *  and steering proposers ignore it. Undefined when no model is resolvable, so
   *  a model proposer can no-op (and record an audited failure) rather than throw. */
  complete?: (prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>;
}

/** A single delta plus a human-readable reason for the audit trail. */
export interface ProposedDelta {
  delta: Delta;
  rationale: string;
}

export interface ProposeResult {
  /** Deltas the proposer produced directly (rule-based / model proposers). */
  deltas?: ProposedDelta[];
  /**
   * A steering message for the agent, when the proposer delegates reasoning to
   * the agent loop (the default). runRefine sends this via sendUserMessage.
   * A proposer MAY return both — deltas are applied first, then steering sent.
   */
  steeringMessage?: string;
  /** Telemetry from a dedicated model call, recorded in the refine audit entry so
   *  hidden model spend is visible. Set by dedicated-model proposers; ignored by
   *  rule-based/steering ones. */
  modelCall?: ModelCallTelemetry;
}

/** A strategy for turning evidence + state into (or toward) harness deltas. */
export interface DeltaProposer {
  readonly name: string;
  propose(input: ProposeInput): Promise<ProposeResult>;
}

// ---- default: steering (delegates reasoning to the agent) ------------------

function buildSteeringPrompt(evidence: string, lookback: number): string {
  return [
    `/refine (online self-improvement, last ${lookback} turns as evidence)`,
    "",
    "Review the trajectory evidence below. Identify DURABLE, REUSABLE corrections — things that will help in future turns, not one-off fixes. Then update the Continual Harness state.",
    "",
    "Steps:",
    "1. Call harness_list to see the current state.",
    "2. Call harness_mutate with small, surgical CRUD deltas. Every create MUST include concrete evidence from the trajectory. Prefer updating existing items over creating duplicates; delete items that are wrong, stale, or contradicted.",
    "3. Keep prompt notes terse and behavioral. Memory facts should be specific. Skill/sub-agent entries should describe reusable patterns, not one task.",
    "",
    "Constraints: never rewrite the whole store; ground every change in evidence; if nothing durable is worth recording, say so and do nothing.",
    "",
    "## Trajectory evidence",
    evidence,
  ].join("\n");
}

/** Default proposer: delegates reasoning to the agent via a steering message. */
export const steeringProposer: DeltaProposer = {
  name: "steering",
  async propose({ evidence, lookback }): Promise<ProposeResult> {
    return { steeringMessage: buildSteeringPrompt(evidence, lookback) };
  },
};

// ---- rule-based alternate: dedupe -----------------------------------------

export const DEDUPE_THRESHOLD = 0.6;

/** Tokenize for overlap comparison: lowercase alnum tokens. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

/** Jaccard token overlap in [0,1]. 0 if either side has no tokens. */
export function tokenOverlap(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function truncate(s: string, n = 48): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Rule-based proposer: drops near-duplicate ACTIVE items (same kind, Jaccard
 * token overlap >= DEDUPE_THRESHOLD), keeping the higher-importance one.
 *
 * Greedy and contradiction-free: items are considered in importance-descending
 * order; the first item is always a keeper, and each later item is compared
 * only against keepers, so a keeper is never subsequently dropped.
 */
export const dedupeProposer: DeltaProposer = {
  name: "dedupe",
  async propose({ state }): Promise<ProposeResult> {
    const ordered = state.items
      .filter((i) => i.active)
      .sort((a, b) => b.importance - a.importance);
    const keepers: HarnessItem[] = [];
    const proposals: ProposedDelta[] = [];
    for (const cand of ordered) {
      let dup: HarnessItem | undefined;
      let best = 0;
      for (const k of keepers) {
        if (k.kind !== cand.kind) continue;
        // Per-model isolation: each model keeps its own copy, so two near-
        // identical items bound to different models are NOT duplicates.
        if (k.ownerModel !== cand.ownerModel) continue;
        const sim = tokenOverlap(k.content, cand.content);
        if (sim >= DEDUPE_THRESHOLD && sim > best) {
          best = sim;
          dup = k;
        }
      }
      if (dup) {
        proposals.push({
          delta: {
            op: "delete",
            id: cand.id,
            reason: `near-duplicate of ${dup.id} (overlap ${best.toFixed(2)})`,
          },
          rationale: `dedupe: "${truncate(cand.content)}" ≈ keeper "${truncate(dup.content)}" (Jaccard ${best.toFixed(2)}); kept higher-importance ${dup.id}.`,
        });
      } else {
        keepers.push(cand);
      }
    }
    return proposals.length ? { deltas: proposals } : {};
  },
};

// ---- registry -------------------------------------------------------------

const registry = new Map<string, DeltaProposer>([
  ["steering", steeringProposer],
  ["dedupe", dedupeProposer],
]);

/** Register (or replace) a named proposer. For external extensions. */
export function registerProposer(p: DeltaProposer): void {
  registry.set(p.name, p);
}

/** Look up a proposer by name; falls back to the steering default. */
export function getProposer(name: string | undefined): DeltaProposer {
  return registry.get(name ?? "steering") ?? steeringProposer;
}

export function listProposers(): string[] {
  return [...registry.keys()];
}

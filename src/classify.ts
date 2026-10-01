// Classifier adapter (pi ≥ 0.99). Wraps ctx.modelRegistry.classify() — cheap
// typed yes/no or score questions answered from next-token label probabilities
// (local llama.cpp) or a hosted Jev model — behind two package seams:
//
//  1. autoRefine gate (auto-refine.ts): when the cadence elapses, ask ONE bool
//     question over the recent trajectory ("did it contain a durable, reusable
//     correction?") and skip the refine when the answer is no. Soft-fails to the
//     old cadence behavior on any classifier error, so a flaky classifier never
//     blocks refinement.
//  2. dedupe confirmation (proposer.ts): a precision filter on candidate merge
//     pairs — see classifyConfirmPairs().
//
// The pi-ai classifier shapes (ClassifierContext/ClassifierQuestion/…) are kept
// OUT of the public proposer interface: ClassifyFn below is a minimal structural
// contract so proposers stay testable without pi runtime types.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** One yes/no question in a ClassifyFn request. */
export interface ClassifyBoolQuestion {
  instructions: string;
  /** Criteria text for the yes answer. */
  trueCriteria: string;
  /** Criteria text for the no answer. */
  falseCriteria: string;
}

/** A parsed answer per question key. */
export interface ClassifyBoolAnswer {
  /** The classifier's decision. */
  value: boolean;
  /** [0,1] confidence when the engine reports one. */
  confidence?: number;
}

/** Result of a ClassifyFn call: one answer per question key, or an error. */
export interface ClassifyBoolResult {
  ok: boolean;
  answers: Record<string, ClassifyBoolAnswer>;
  /** Resolved classifier label ("provider/id") for telemetry. */
  model?: string;
  /** Token usage when the engine reports it (for the audit trail). */
  usage?: { input: number; output: number };
  error?: string;
}

/**
 * Batched yes/no classification seam injected into ProposeInput when a
 * classifier model is configured AND resolvable. Structural on purpose —
 * the adapter below is the only place that knows pi-ai's shapes.
 */
export type ClassifyFn = (input: {
  state: Record<string, unknown>;
  questions: Record<string, ClassifyBoolQuestion>;
}) => Promise<ClassifyBoolResult>;

/** Structural slice of ctx.modelRegistry used here. */
interface RegistryLike {
  classify?: (model: unknown, context: unknown, options?: unknown) => Promise<ClassifyRawResult>;
  findOfType?: (type: "classifier", provider: string, id: string) => unknown | undefined;
  getModelsOfType?: (type: "classifier") => readonly unknown[];
}

/** Raw pi-ai ClassifierResult slice (never rejects, but stopReason may be error). */
interface ClassifyRawResult {
  answers?: Record<string, { type?: string; choice?: unknown; score?: number; probability?: number; confidence?: number }>;
  stopReason?: string;
  errorMessage?: string;
}

/** Raw classifier-model slice (Model<ClassifierApi>). */
interface ClassifierModelLike {
  provider?: string;
  id?: string;
}

/**
 * Resolve a classifier model from a configured id ("provider/id" or bare id).
 * Returns undefined when unconfigured or unresolvable — every feature keyed on
 * it then degrades to its no-classifier behavior.
 */
export function resolveClassifierModel(
  registry: RegistryLike | undefined,
  configured?: string,
): ClassifierModelLike | undefined {
  if (!configured || !registry) return undefined;
  const slash = configured.indexOf("/");
  if (slash > 0 && typeof registry.findOfType === "function") {
    const byPair = registry.findOfType("classifier", configured.slice(0, slash), configured.slice(slash + 1));
    if (byPair) return byPair as ClassifierModelLike;
  }
  const all =
    typeof registry.getModelsOfType === "function"
      ? [...registry.getModelsOfType("classifier")]
      : [];
  return (all.find((m) => {
    const cm = m as ClassifierModelLike;
    return cm.id === configured || `${cm.provider}/${cm.id}` === configured;
  }) ?? undefined) as ClassifierModelLike | undefined;
}

/** Build the ClassifyFn adapter over a resolved classifier model. */
export function makeClassifyFn(
  registry: RegistryLike,
  model: ClassifierModelLike,
  signal?: AbortSignal,
): ClassifyFn {
  const label = `${model.provider}/${model.id}`;
  return async ({ state, questions }) => {
    if (typeof registry.classify !== "function") {
      return { ok: false, answers: {}, model: label, error: "modelRegistry.classify unavailable" };
    }
    // Map our minimal bool contract onto pi-ai's ClassifierBoolQuestion.
    const piQuestions: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(questions)) {
      piQuestions[key] = {
        type: "bool",
        instructions: q.instructions,
        criteria: { true: q.trueCriteria, false: q.falseCriteria },
      };
    }
    let raw: ClassifyRawResult;
    try {
      raw = (await registry.classify(model, { state, questions: piQuestions }, signal ? { signal } : undefined)) as ClassifyRawResult;
    } catch (err) {
      // classify "never rejects", but stay defensive around transport edges.
      return { ok: false, answers: {}, model: label, error: (err as Error).message };
    }
    const usage =
      typeof (raw as { usage?: { input?: number; output?: number } }).usage?.input === "number" &&
      typeof (raw as { usage?: { input?: number; output?: number } }).usage?.output === "number"
        ? {
            input: (raw as { usage?: { input: number; output: number } }).usage!.input,
            output: (raw as { usage?: { input: number; output: number } }).usage!.output,
          }
        : undefined;
    if (raw.stopReason && raw.stopReason !== "stop") {
      return {
        ok: false,
        answers: {},
        model: label,
        ...(usage ? { usage } : {}),
        error: raw.errorMessage ?? `stopReason ${raw.stopReason}`,
      };
    }
    const answers: Record<string, ClassifyBoolAnswer> = {};
    for (const [key, a] of Object.entries(raw.answers ?? {})) {
      let value: boolean | undefined;
      let confidence: number | undefined;
      if (a?.type === "bool") {
        // Bool answers carry the probability of TRUE.
        value = (a.probability ?? 0) >= 0.5;
        confidence = a.probability;
      } else if (a?.type === "choice") {
        value = a.choice === true || a.choice === "true";
        confidence = a.confidence;
      } else if (a?.type === "score") {
        value = (a.score ?? 0) >= 0.5;
        confidence = a.confidence;
      }
      if (value !== undefined) {
        answers[key] = { value, ...(typeof confidence === "number" ? { confidence } : {}) };
      }
    }
    return { ok: true, answers, model: label, ...(usage ? { usage } : {}) };
  };
}

/**
 * Resolve the ClassifyFn for a session from config + ctx, or undefined.
 * The single construction point shared by refine (ProposeInput.classify) and
 * the auto-refine gate.
 */
export function buildClassify(
  ctx: ExtensionContext,
  configuredModel?: string,
): ClassifyFn | undefined {
  const registry = ctx.modelRegistry as RegistryLike | undefined;
  const model = resolveClassifierModel(registry, configuredModel);
  if (!registry || !model) return undefined;
  return makeClassifyFn(registry, model, ctx.signal);
}

/**
 * The auto-refine gate question: did the recent trajectory contain a durable,
 * reusable correction worth a /refine pass? Pure builder — unit-testable.
 * Keeps the state payload bounded (the caller already bounds evidence bytes).
 */
export function buildGateRequest(evidence: string): {
  state: Record<string, unknown>;
  questions: Record<string, ClassifyBoolQuestion>;
} {
  return {
    state: { trajectory: evidence },
    questions: {
      gate: {
        instructions:
          "You are gating an online self-improvement pass for a coding agent. Does the recent trajectory below contain a durable, reusable correction — a mistake fixed, a preference learned, a convention discovered, or a fact worth remembering across sessions — that is NOT already routine work?",
        trueCriteria:
          "The trajectory contains at least one durable, reusable lesson or correction worth persisting into the agent's harness state.",
        falseCriteria:
          "The trajectory is routine work (ordinary edits, reads, test runs) with no reusable correction worth persisting.",
      },
    },
  };
}

/**
 * Gate decision from a classify result. Errors and missing answers fall back to
 * `true` (proceed) so a flaky classifier never disables refinement — the gate
 * can only SKIP work, never block it.
 */
export function gateDecision(result: ClassifyBoolResult): { proceed: boolean; because: string } {
  if (!result.ok) return { proceed: true, because: `classifier error (${result.error ?? "unknown"}); falling back to cadence` };
  const a = result.answers.gate;
  if (!a) return { proceed: true, because: "no gate answer; falling back to cadence" };
  return a.value
    ? { proceed: true, because: `classifier: yes (confidence ${a.confidence ?? "?"})` }
    : { proceed: false, because: `classifier: no durable correction (confidence ${a.confidence ?? "?"})` };
}

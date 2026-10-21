// /refine — the online optimizer. Manual by default; opt-in turn_end
// auto-refine lives in auto-refine.ts and reuses runRefine().
//
// Flow:
//  1. Gather recent trajectory evidence from the current branch.
//  2. Hand evidence + current state to a pluggable DeltaProposer (proposer.ts).
//     The default `steering` proposer returns a steering user message; the
//     agent then reasons and calls harness_mutate. Rule-based/model proposers
//     return deltas directly, which runRefine applies itself.
//  3. Every mutation — whether from the agent (harness_mutate) or a direct-apply
//     proposer — is recorded as a session entry, so /tree gives rollback for
//     free. Which proposer ran is captured in the audit entry.
//
// Why a steering message as the DEFAULT instead of a nested LLM call: it reuses
// the existing agent loop, is model-agnostic, and keeps every delta visible and
// reviewable in the transcript. Alternate proposers can opt out via the
// registry; the dedicated-model variant is intentionally not shipped (hidden
// model spend is a tradeoff the roadmap keeps as a separate decision).

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Context, Model, TextContent } from "@earendil-works/pi-ai";
import { applyDeltas, DEFAULT_DURABLE_PATH, exportDurableLayers, getState, PROJECT_DURABLE_DIR, REFINE_ENTRY, snapshotState } from "./store.js";
import { buildLessonsDigest } from "./lessons.js";
import { getProposer, listProposers, DEFAULT_DEDUPE } from "./proposer.js";
import type { CompleteOptions, CompleteResult } from "./proposer.js";
import { REFINE_COMMAND_DESCRIPTION } from "./command-meta.js";
import { buildClassify } from "./classify.js";
import { resolveBindingKey, branchEntries } from "./vmodel.js";
import type { AppliedDelta } from "./types.js";
import { loadConfig, projectSlug } from "./config.js";

const DEFAULT_EVIDENCE_BYTES = 16000;
export const DEFAULT_LOOKBACK_TURNS = 25;

// Minimal entry shape for trajectory walking; kept loose to avoid coupling to
// pi's internal session entry types. NOTE: message content is a plain string
// OR a block array depending on the message source — never assume either.
type AnyEntry = {
  type?: string;
  customType?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
};

/**
 * Flatten a pi message content to plain text. Pi messages carry content as a
 * plain string or as an array of content blocks (text blocks carry `.text`);
 * anything else degrades to "" instead of throwing. Pure.
 */
export function messageText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => c?.text ?? "").join(" ");
}

/** /refine command body — parse flags, warn on typos, run the refine.
 *  Exported so the thin entry (entry.ts) can delegate here via dynamic import
 *  without paying this module's static graph at pi startup (issue #36). */
export async function runRefineCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const { lookback, commit, proposer, threshold, thresholdInvalid, unknownFlags } = parseArgs(args);
  if (thresholdInvalid) {
    ctx.ui.notify("Invalid --threshold ignored (expected 0 < t ≤ 1).", "warning");
  }
  if (unknownFlags.length > 0) {
    ctx.ui.notify(`Unknown /refine flag(s) ignored: ${unknownFlags.join(", ")}.`, "warning");
  }
  await runRefine(pi, ctx, {
    lookback,
    commit,
    ...(proposer ? { proposer } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
  });
}

export function registerRefine(pi: ExtensionAPI): void {
  pi.registerCommand("refine", {
    description: REFINE_COMMAND_DESCRIPTION,
    handler: (args, ctx) => runRefineCommand(pi, args, ctx),
  });
}

export interface RefineOptions {
  lookback?: number;
  commit?: boolean;
  /** Proposer name (see proposer.ts registry). Defaults to "steering". */
  proposer?: string;
  /** Dedupe similarity threshold override in (0,1], applied for this run only
   *  (overrides `dedupe.threshold` in harness.json). Affects the rule-based
   *  `dedupe` proposer; ignored by others. */
  threshold?: number;
  /** How a steering message is delivered (pi ≥ 0.87 actionable boundaries).
 *  "steer" (default): send it as a user message via sendUserMessage — the
   *  manual /refine path. "boundary": do NOT send; return it in RefineResult
   *  so a turn_end caller can persist it as a structural entry and guarantee
   *  one next provider request with `{ entries, continue: true }` — no
   *  steering queue, no follow-up scheduling side effects. */
  delivery?: "steer" | "boundary";
}

export interface RefineResult {
  evidenceBytes: number;
  lookback: number;
  commit: boolean;
  source: "manual" | "auto";
  /** Which proposer ran. */
  proposer: string;
  /** Deltas the proposer applied directly (0 for the steering path). */
  applied: number;
  /** Set ONLY with delivery "boundary" when the proposer returned a steering
   *  message: the message was NOT sent — the caller owns persisting it (e.g.
   *  as a turn_end boundary draft) and ensuring the continuation. */
  steeringMessage?: string;
}

/**
 * Core refine routine shared by /refine (manual) and turn_end auto-refine.
 * Resolves a proposer, gathers evidence, lets the proposer decide what to do,
 * then either applies returned deltas directly or sends a steering message.
 * `source` tags the audit entry so autonomous runs are distinguishable.
 */
export async function runRefine(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: RefineOptions = {},
  source: "manual" | "auto" = "manual",
): Promise<RefineResult> {
  const lookback = options.lookback ?? DEFAULT_LOOKBACK_TURNS;
  const commit = options.commit ?? false;
  const proposer = getProposer(options.proposer);
  // An explicit but unknown --proposer must not silently run steering
  // (review finding #7): name the fallback so a typo is visible.
  if (options.proposer && proposer.name !== options.proposer) {
    ctx.ui.notify(
      `Unknown proposer "${options.proposer}" — falling back to steering. Registered: ${listProposers().join(", ")}.`,
      "warning",
    );
  }
  ctx.ui.setStatus("harness", `Refining (last ${lookback} turns)… [${proposer.name}]`);

  const evidence = gatherEvidence(ctx, lookback);
  // Load the (cached) config and thread it into ProposeInput so proposers read
  // tuned knobs (e.g. the dedupe threshold/merge policy) without file I/O. An
  // explicit --threshold overrides the configured dedupe threshold for this run.
  const config = await loadConfig();
  const proposerConfig =
    options.threshold !== undefined
      ? { ...config, dedupe: { ...(config.dedupe ?? DEFAULT_DEDUPE), threshold: options.threshold } }
      : config;
  // Inject a one-shot model completion (built from ctx) so dedicated-model
  // proposers can make a hidden LLM call. Undefined when no model is resolvable.
  const complete = buildComplete(ctx);
  // The actor model (virtualBinding-aware): stamps direct-apply creates AND
  // scopes the lessons digest (per-model isolation applies to what the
  // improver is told, not just what it is shown — review r4341960955).
  const branch = branchEntries(ctx);
  const ownerKey = resolveBindingKey(ctx.model, branch, config.virtualBinding);
  // Inject the classifier adapter when `classifier.model` is configured and
  // resolvable (pi ≥ 0.99) — the dedupe proposer uses it to confirm merges.
  const classify = buildClassify(ctx, config.classifier?.model);
  // Harnessing-level recursion (Harness² arXiv 2610.14224): the improvement
  // process learns from what past improvement yielded. The digest is built
  // from evidence-gated signals only (citations, keeps/drops, refine-run
  // outcomes), filtered to the ACTIVE MODEL's items (blank-harness isolation
  // holds for lessons too), and stays empty when there is nothing to say.
  const lessons = buildLessonsDigest(getState(), branch, { ownerKey: ownerKey ?? "" });
  // Pass a defensive copy: proposers are a public extension point and must not
  // be able to mutate the live store outside applyDeltas (no audit / no rollback).
  const result = await proposer.propose({
    evidence,
    state: snapshotState(),
    lookback,
    config: proposerConfig,
    ...(complete ? { complete } : {}),
    ...(classify ? { classify } : {}),
    ...(lessons ? { lessons } : {}),
  });
  const proposedDeltas = result.deltas ?? [];
  // Stamp direct-apply create deltas with the active model so proposer-authored
  // notes bind to the model driving the turn (the steering path is stamped in
  // the harness_mutate tool instead). Orphans result only when the model is
  // unknown; before_agent_start adopts them on the next turn. (ownerKey is
  // resolved above, before the digest.)

  let applied = 0;
  let appliedDeltas: AppliedDelta[] = [];
  let applyError: string | undefined;
  if (proposedDeltas.length > 0) {
    // Direct-apply path (rule-based / model proposers): persist each batch the
    // same way harness_mutate does, so /tree rollback covers these too.
    // applyDeltas is all-or-nothing and re-throws on a bad delta — e.g. a model
    // proposer's delete-then-update of the same id, or an id removed by a prune
    // race during the await above. It rolls back in-memory state before throwing,
    // so we surface the failure as an audited no-op rather than crashing /refine.
    try {
      appliedDeltas = applyDeltas(
        proposedDeltas.map((d) => {
          const delta = d.delta;
          return ownerKey !== undefined && delta.op === "create"
            ? { ...delta, ownerModel: ownerKey }
            : delta;
        }),
        (snapshot, ver) => pi.appendEntry("harness-state", { state: snapshot, version: ver }),
      );
      applied = appliedDeltas.length;
      ctx.ui.notify(`Proposer "${proposer.name}" applied ${applied} delta(s) directly.`, "info");
    } catch (err) {
      applyError = (err as Error).message;
      ctx.ui.notify(
        `Proposer "${proposer.name}" batch failed: ${applyError} (0 applied, rolled back).`,
        "warning",
      );
    }
  }

  // Audit trail (branchable via /tree). `source` distinguishes manual /refine
  // from opt-in auto-refine; `proposer` records WHICH strategy ran; the
  // rationales make rule-based decisions visible in the transcript.
  pi.appendEntry(REFINE_ENTRY, {
    lookback,
    commit,
    startedAt: Date.now(),
    source,
    proposer: proposer.name,
    applied,
    // Full applied-delta list (incl. delete reasons) — richer than the count:
    // the calibration-corpus exporter (corpus.ts) reconstructs dedupe pairs
    // from it. Legacy readers only consuming `applied` are unaffected.
    appliedDeltas,
    rationales: proposedDeltas.map((d) => d.rationale),
    // Hidden model spend made visible: dedicated-model proposers report what the
    // call cost (model, tokens, latency, ok/error). Absent for rule-based/steering.
    ...(result.modelCall ? { modelCall: result.modelCall } : {}),
    // When a direct-apply batch failed mid-application (rolled back), record why.
    ...(applyError ? { applyError } : {}),
  });

  if (commit) {
    // Flush current state to the durable layers first so the agent refines
    // against the same view pi-reflect / pi-mem would see (layered: items land
    // in the file their own scope selects).
    try {
      const written = await exportDurableLayers(
        { globalPath: DEFAULT_DURABLE_PATH, projectDir: PROJECT_DURABLE_DIR },
        projectSlug(ctx.cwd),
      );
      ctx.ui.notify(`Durable state exported to ${written.length} layer file(s)`, "info");
    } catch (err) {
      ctx.ui.notify(`Durable export failed: ${(err as Error).message}`, "warning");
    }
  }

  if (result.steeringMessage) {
    if (options.delivery === "boundary") {
      // Caller owns delivery: persist as a structural boundary entry and
      // continue — see auto-refine.ts. Returned via RefineResult.
    } else {
      // deliverAs "steer": injects mid-run when the session is busy, ignored
      // when idle (starts the refine run). Required since pi 1.2 — the busy
      // window now includes run start, and a bare send throws there.
      pi.sendUserMessage(result.steeringMessage, { deliverAs: "steer" });
    }
  }
  ctx.ui.setStatus("harness", undefined);
  return {
    evidenceBytes: evidence.length,
    lookback,
    commit,
    source,
    proposer: proposer.name,
    applied,
    ...(options.delivery === "boundary" && result.steeringMessage ? { steeringMessage: result.steeringMessage } : {}),
  };
}

function parseArgs(args: string): {
  lookback: number;
  commit: boolean;
  proposer: string | undefined;
  threshold: number | undefined;
  thresholdInvalid: boolean;
  unknownFlags: string[];
} {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let lookback = DEFAULT_LOOKBACK_TURNS;
  let commit = false;
  let proposer: string | undefined;
  let threshold: number | undefined;
  let thresholdInvalid = false;
  const unknownFlags: string[] = [];
  const readThreshold = (raw: string): void => {
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0 && v <= 1) threshold = v;
    else thresholdInvalid = true;
  };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "--commit") commit = true;
    else if (p === "--proposer" && i + 1 < parts.length) proposer = parts[++i];
    else if (p.startsWith("--proposer=")) proposer = p.slice("--proposer=".length);
    else if (p === "--threshold" && i + 1 < parts.length) readThreshold(parts[++i]!);
    else if (p.startsWith("--threshold=")) readThreshold(p.slice("--threshold=".length));
    else if (/^\d+$/.test(p)) lookback = Math.max(1, Math.min(200, Number(p)));
    // Unknown --flags are collected, not silently dropped: a typo like
    // "--comit" used to vanish and run a plain refine (review finding #7).
    else if (p.startsWith("--")) unknownFlags.push(p);
  }
  return { lookback, commit, proposer, threshold, thresholdInvalid, unknownFlags };
}

export function gatherEvidence(ctx: ExtensionContext, lookback: number): string {
  const entries = ctx.sessionManager.getBranch() as AnyEntry[];
  const messages = entries.filter((e) => e.type === "message" && e.message);
  const recent = messages.slice(-lookback * 2); // ~2 entries per turn (user+assistant)
  const lines: string[] = [];
  let bytes = 0;
  for (const e of recent) {
    const role = e.message?.role ?? "?";
    const text = messageText(e.message?.content)
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const line = `[${role}] ${text}`;
    if (bytes + line.length > DEFAULT_EVIDENCE_BYTES) {
      lines.push("[…truncated…]");
      break;
    }
    lines.push(line);
    bytes += line.length;
  }
  return lines.join("\n") || "(no recent trajectory evidence found)";
}

// ---- one-shot model completion injection (for dedicated-model proposers) -------
//
// runRefine builds this closure from ctx.modelRegistry + ctx.model and passes it
// into ProposeInput.complete. A dedicated-model proposer (shipped as a companion
// package) calls it to produce deltas directly via a hidden completion; the
// telemetry it returns is recorded in the refine audit entry so the spend stays
// visible. Rule-based/steering proposers ignore it.

/** Resolve a model id ("provider/id" or a bare id) against the registry, falling
 *  back to the active session model. Returns undefined if nothing resolves. */
function resolveModel(ctx: ExtensionContext, modelId?: string): Model<any> | undefined {
  const registry = ctx.modelRegistry;
  if (modelId && registry) {
    const slash = modelId.indexOf("/");
    if (slash >= 0) {
      const found = registry.find(modelId.slice(0, slash), modelId.slice(slash + 1));
      if (found) return found;
    }
    const byId =
      registry.getAvailable().find((m) => m.id === modelId) ??
      registry.getAll().find((m) => m.id === modelId);
    if (byId) return byId;
  }
  return ctx.model;
}

/** Build the one-shot completion closure injected into ProposeInput, or undefined
 *  when no model can be resolved (so a model proposer can no-op gracefully).
 *  Honors the agent abort signal and a per-call token budget. */
function buildComplete(
  ctx: ExtensionContext,
): ((prompt: string, opts?: CompleteOptions) => Promise<CompleteResult>) | undefined {
  const registry = ctx.modelRegistry;
  const active = ctx.model;
  if (!registry || (!active && registry.getAvailable().length === 0)) return undefined;

  return async (prompt, opts) => {
    const model = resolveModel(ctx, opts?.modelId);
    if (!model) throw new Error("no model available for proposer completion");
    const context: Context = {
      ...(opts?.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    };
    const assistant = await registry.complete(model, context, {
      ...(opts?.maxOutputTokens !== undefined ? { maxTokens: opts.maxOutputTokens } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    const text = assistant.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("");
    const usage = assistant.usage;
    return {
      text,
      // Surface the resolved model so a dedicated-model proposer can label its
      // audit telemetry accurately instead of a vague "active".
      model: `${model.provider}/${model.id}`,
      ...(usage ? { usage: { input: usage.input, output: usage.output } } : {}),
    };
  };
}

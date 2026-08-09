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
import { applyDeltas, exportDurable, modelKey, REFINE_ENTRY, snapshotState } from "./store.js";
import { getProposer } from "./proposer.js";
import type { CompleteOptions, CompleteResult } from "./proposer.js";

const DEFAULT_EVIDENCE_BYTES = 16000;
export const DEFAULT_LOOKBACK_TURNS = 25;

// Minimal entry shape for trajectory walking; kept loose to avoid coupling to
// pi's internal session entry types.
type AnyEntry = {
  type?: string;
  customType?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
};

export function registerRefine(pi: ExtensionAPI): void {
  pi.registerCommand("refine", {
    description:
      "Online self-improvement: review recent trajectory and propose evidence-backed CRUD deltas to the harness state. Usage: /refine [lookback-turns] [--commit] [--proposer steering|dedupe]",
    handler: async (args, ctx) => {
      const { lookback, commit, proposer } = parseArgs(args);
      await runRefine(pi, ctx, { lookback, commit, ...(proposer ? { proposer } : {}) });
    },
  });
}

export interface RefineOptions {
  lookback?: number;
  commit?: boolean;
  /** Proposer name (see proposer.ts registry). Defaults to "steering". */
  proposer?: string;
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
  ctx.ui.setStatus("harness", `Refining (last ${lookback} turns)… [${proposer.name}]`);

  const evidence = gatherEvidence(ctx, lookback);
  // Inject a one-shot model completion (built from ctx) so dedicated-model
  // proposers can make a hidden LLM call. Undefined when no model is resolvable.
  const complete = buildComplete(ctx);
  // Pass a defensive copy: proposers are a public extension point and must not
  // be able to mutate the live store outside applyDeltas (no audit / no rollback).
  const result = await proposer.propose({
    evidence,
    state: snapshotState(),
    lookback,
    ...(complete ? { complete } : {}),
  });
  const proposedDeltas = result.deltas ?? [];
  // Stamp direct-apply create deltas with the active model so proposer-authored
  // notes bind to the model driving the turn (the steering path is stamped in
  // the harness_mutate tool instead). Orphans result only when the model is
  // unknown; before_agent_start adopts them on the next turn.
  const ownerKey = modelKey(ctx.model);

  let applied = 0;
  let applyError: string | undefined;
  if (proposedDeltas.length > 0) {
    // Direct-apply path (rule-based / model proposers): persist each batch the
    // same way harness_mutate does, so /tree rollback covers these too.
    // applyDeltas is all-or-nothing and re-throws on a bad delta — e.g. a model
    // proposer's delete-then-update of the same id, or an id removed by a prune
    // race during the await above. It rolls back in-memory state before throwing,
    // so we surface the failure as an audited no-op rather than crashing /refine.
    try {
      const appliedDeltas = applyDeltas(
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
    rationales: proposedDeltas.map((d) => d.rationale),
    // Hidden model spend made visible: dedicated-model proposers report what the
    // call cost (model, tokens, latency, ok/error). Absent for rule-based/steering.
    ...(result.modelCall ? { modelCall: result.modelCall } : {}),
    // When a direct-apply batch failed mid-application (rolled back), record why.
    ...(applyError ? { applyError } : {}),
  });

  if (commit) {
    // Flush current state to the durable file first so the agent refines
    // against the same view pi-reflect / pi-mem would see.
    try {
      const path = await exportDurable();
      ctx.ui.notify(`Durable state exported to ${path}`, "info");
    } catch (err) {
      ctx.ui.notify(`Durable export failed: ${(err as Error).message}`, "warning");
    }
  }

  if (result.steeringMessage) {
    pi.sendUserMessage(result.steeringMessage);
  }
  ctx.ui.setStatus("harness", undefined);
  return {
    evidenceBytes: evidence.length,
    lookback,
    commit,
    source,
    proposer: proposer.name,
    applied,
  };
}

function parseArgs(args: string): {
  lookback: number;
  commit: boolean;
  proposer: string | undefined;
} {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let lookback = DEFAULT_LOOKBACK_TURNS;
  let commit = false;
  let proposer: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "--commit") commit = true;
    else if (p === "--proposer" && i + 1 < parts.length) proposer = parts[++i];
    else if (p.startsWith("--proposer=")) proposer = p.slice("--proposer=".length);
    else if (/^\d+$/.test(p)) lookback = Math.max(1, Math.min(200, Number(p)));
  }
  return { lookback, commit, proposer };
}

function gatherEvidence(ctx: ExtensionContext, lookback: number): string {
  const entries = ctx.sessionManager.getBranch() as AnyEntry[];
  const messages = entries.filter((e) => e.type === "message" && e.message);
  const recent = messages.slice(-lookback * 2); // ~2 entries per turn (user+assistant)
  const lines: string[] = [];
  let bytes = 0;
  for (const e of recent) {
    const role = e.message?.role ?? "?";
    const text = (e.message?.content ?? [])
      .map((c) => c.text ?? "")
      .join(" ")
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

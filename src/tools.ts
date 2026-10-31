// Model-facing tools. Two tools, kept lean for prompt economy:
//  - harness_list:  read items (optionally by kind).
//  - harness_mutate: apply a batch of structured CRUD deltas.
//
// Deltas — not prose rewrites — are the unit of self-improvement (ACE).
// Each create requires `evidence`, so the model must ground every addition.
//
// The schema/registration metadata lives in schemas.ts so the thin entry
// (entry.ts) can register the tools WITHOUT importing this module's static
// graph (store.ts); the execute implementations below are the lazy side.

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  harnessListTool,
  harnessMutateTool,
  KIND_VALUES,
  MAX_CONTENT_CHARS,
  MAX_DELTAS,
  MAX_EVIDENCE_CHARS,
  MAX_REASON_CHARS,
  type HarnessListParams,
  type HarnessMutateParams,
} from "./schemas.js";
import { applyDeltas, getActiveModelKey, getState, listItems, makePersist } from "./store.js";
import { supportSummary, tally } from "./list.js";
import type { AppliedDelta, ComponentKind, Delta } from "./types.js";

export type { HarnessListParams, HarnessMutateParams };

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool(
    harnessListTool(async (_toolCallId, params) => executeHarnessList(params as HarnessListParams)),
  );
  pi.registerTool(
    harnessMutateTool(async (_toolCallId, params) =>
      executeHarnessMutate(pi, params as HarnessMutateParams),
    ),
  );
}

// ---- boundary validation (the model-facing write path) -----------------------
//
// pi schema-validates tool input against schemas.ts before execute runs, but
// this is the one write path into persisted state — the guard is cheap
// insurance against schema/tool-host drift and non-pi hosts (ctx.executeTool
// callers). Every rule here mirrors a declared schema constraint.

/** A string field within its declared cap (and a string at all). */
function validText(v: unknown, max: number, field: string, where: string): string | undefined {
  if (typeof v !== "string") return `${where}: ${field} must be a string`;
  if (v.length > max) return `${where}: ${field} exceeds maxLength ${max}`;
  return undefined;
}

/** Validate a raw deltas array against the mutate schema's constraints.
 *  Returns the first violation found, or undefined when the batch is sound. */
export function validateDeltas(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return "deltas must be an array";
  if (raw.length < 1 || raw.length > MAX_DELTAS) {
    return `deltas must carry between 1 and ${MAX_DELTAS} items`;
  }
  for (const [n, d] of raw.entries()) {
    const where = `delta ${n + 1}`;
    if (!d || typeof d !== "object" || typeof (d as { op?: unknown }).op !== "string") {
      return `${where}: missing op`;
    }
    const delta = d as Record<string, unknown>;
    if (delta.op === "create") {
      if (!KIND_VALUES.includes(delta.kind as never)) return `${where}: unknown kind`;
      const content = validText(delta.content, MAX_CONTENT_CHARS, "content", where);
      if (content) return content;
      const evidence = validText(delta.evidence, MAX_EVIDENCE_CHARS, "evidence", where);
      if (evidence) return evidence;
      if (delta.content === "") return `${where}: content must not be empty`;
      if (delta.evidence === "") return `${where}: evidence must not be empty`;
      // Same range checks as the update branch: the schema declares
      // minimum 0 / maximum 1 on create importance too, and a non-numeric
      // value from a non-pi host would otherwise store NaN (review: the
      // create branch used to skip importance/scope entirely).
      const imp = delta.importance;
      if (imp !== undefined && (typeof imp !== "number" || imp < 0 || imp > 1)) {
        return `${where}: importance must be a number in [0,1]`;
      }
      if (delta.scope !== undefined && delta.scope !== "global" && delta.scope !== "project") {
        return `${where}: scope must be global|project`;
      }
    } else if (delta.op === "update") {
      const id = validText(delta.id, 200, "id", where);
      if (id) return id;
      for (const field of ["content", "evidence"] as const) {
        if (delta[field] !== undefined) {
          const err = validText(
            delta[field],
            field === "content" ? MAX_CONTENT_CHARS : MAX_EVIDENCE_CHARS,
            field,
            where,
          );
          if (err) return err;
        }
      }
      const imp = delta.importance;
      if (imp !== undefined && (typeof imp !== "number" || imp < 0 || imp > 1)) {
        return `${where}: importance must be a number in [0,1]`;
      }
      if (delta.active !== undefined && typeof delta.active !== "boolean") {
        return `${where}: active must be a boolean`;
      }
      if (delta.scope !== undefined && delta.scope !== "global" && delta.scope !== "project") {
        return `${where}: scope must be global|project`;
      }
    } else if (delta.op === "delete") {
      const id = validText(delta.id, 200, "id", where);
      if (id) return id;
      const reason = validText(delta.reason, MAX_REASON_CHARS, "reason", where);
      if (reason) return reason;
    } else {
      return `${where}: unknown op "${String(delta.op)}"`;
    }
  }
  return undefined;
}

/** harness_list execute: list items, optionally filtered. */
export async function executeHarnessList(
  params: HarnessListParams,
): Promise<AgentToolResult<unknown>> {
  const kind = params.kind as ComponentKind | undefined;
  const modelFilter = params.model as string | undefined;
  // Default scope = the active model's items (what gets injected this turn).
  // "*" = every model; an explicit id = that model. When no active model is
  // known (no turn started) and no filter is given, return all so the agent
  // is never silently shown an empty store during setup.
  const ownerKey = modelFilter === "*" ? undefined : (modelFilter ?? getActiveModelKey());
  let items = listItems(kind);
  if (ownerKey !== undefined) items = items.filter((i) => i.ownerModel === ownerKey);
  return {
    content: [
      {
        type: "text",
        text:
          items.length === 0
            ? emptyListMessage(kind, ownerKey)
            : items
                .map((i) => {
                  // Same support line as /harness list -f: feedback signals the
                  // agent should see when grounding its next deltas.
                  const sup = supportSummary(i.support);
                  return `[${i.id}] (${i.kind}, importance ${i.importance.toFixed(2)}, ${i.active ? "active" : "inactive"}, model ${i.ownerModel || "(orphan)"}) ${i.content}\n  evidence: ${i.evidence}${sup ? `\n  ${sup}` : ""}`;
                })
                .join("\n"),
      },
    ],
    details: { count: items.length, items },
    structuredContent: {
      count: items.length,
      items: items.map((i) => ({
        id: i.id,
        kind: i.kind,
        content: i.content,
        evidence: i.evidence,
        importance: i.importance,
        active: i.active,
        ownerModel: i.ownerModel,
        ...(i.scope ? { scope: i.scope } : {}),
        ...(i.project ? { project: i.project } : {}),
        ...(i.support ? { support: i.support } : {}),
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      })),
    },
  };
}

/** harness_mutate execute: apply a batch of deltas as the active model. */
export async function executeHarnessMutate(
  pi: ExtensionAPI,
  params: HarnessMutateParams,
): Promise<AgentToolResult<unknown>> {
  const invalid = validateDeltas(params.deltas);
  if (invalid !== undefined) {
    return {
      content: [{ type: "text", text: `Rejected: ${invalid}. Nothing was applied.` }],
      details: { rejected: true, error: invalid },
      structuredContent: { applied: 0, created: 0, updated: 0, deleted: 0 },
    };
  }
  const incoming = params.deltas as Delta[];
  // `support` and `ownerModel` are SERVER-ONLY (support: review r4341960971;
  // ownerModel: per-model isolation promises the model can never choose the
  // owner — creates stamp to the active model, updates keep theirs). The
  // shapes tolerate additional properties, so a schema-valid call could
  // otherwise carry `support: { citations: 999 }` (fabricated feedback for
  // the lessons digest) or `ownerModel: "someone/else"` (a cross-model
  // smuggle). Strip both at the tool boundary — the only model-facing write
  // path. Internal writers (dedupe merge, keep/drop, outcome loop, direct-
  // apply proposers) call applyDeltas directly and keep them.
  const deltas = incoming.map((d): Delta => {
    if ((d.op === "create" || d.op === "update") && ("support" in d || "ownerModel" in d)) {
      const copy: Delta & { support?: unknown; ownerModel?: unknown } = { ...d };
      delete copy.support;
      delete copy.ownerModel;
      return copy;
    }
    return d;
  });
  // The active model is the ACTOR: creates bind to it, and update/delete are
  // scoped to it (per-model isolation). When the active model is unknown (no
  // turn started) there is no actor — creates become orphans, adopted next
  // turn, and update/delete are unscoped (graceful fallback).
  const applied: AppliedDelta[] = applyDeltas(deltas, makePersist(pi), getActiveModelKey());
  const created = applied.filter((a) => a.op === "create").length;
  const updated = applied.filter((a) => a.op === "update").length;
  const deleted = applied.filter((a) => a.op === "delete").length;
  return {
    content: [
      {
        type: "text",
        text: `Applied ${applied.length} delta(s): ${created} created, ${updated} updated, ${deleted} deleted.`,
      },
    ],
    details: { applied, version: getState().items.length },
    structuredContent: { applied: applied.length, created, updated, deleted },
  };
}

/** Diagnostic message for an empty (filtered) harness_list result.
 *
 *  "Harness state is empty." collapsed three very different situations into
 *  one opaque line, and users read it as "the feature is broken": the store
 *  is genuinely empty (a new session starts empty — durable sync is opt-in),
 *  everything is owned by another model (per-model isolation), or the kind
 *  filter matched nothing. Each case gets its own actionable explanation,
 *  attributed from what the store actually holds — a kind miss for a model
 *  that owns items is never misdiagnosed as model isolation, and the
 *  model:"*" pointer only appears when it would actually surface something. */
function emptyListMessage(kind: ComponentKind | undefined, ownerKey: string | undefined): string {
  const all = listItems();
  if (all.length === 0) {
    return (
      "Harness state is empty (0 items). Items are created by /refine (after a working session) " +
      "or by harness_mutate creates, and persist on the session branch: a NEW session starts empty " +
      'unless durable sync is enabled — set "autoImport": true in ~/.pi/agent/harness.json to ' +
      "import/export the durable layers automatically."
    );
  }
  if (ownerKey !== undefined) {
    const owned = all.filter((i) => i.ownerModel === ownerKey);
    if (owned.length === 0) {
      // Model isolation is the whole story: the active model owns nothing.
      const parts = [
        `No items for model ${ownerKey}. The store holds ${all.length} item(s), owned by: ` +
          `${tally(all, (i) => i.ownerModel || "(orphan)")}.`,
      ];
      if (kind !== undefined) {
        // The model:"*" pointer is only honest when the requested kind
        // exists for another model — with the same kind filter it would
        // still return nothing (the header's "only when it would surface
        // something" guarantee, review #26).
        const kindElsewhere = all.filter((i) => i.kind === kind);
        if (kindElsewhere.length > 0) {
          parts.push(
            `No ${kind} items for this model either; ${kindElsewhere.length} ${kind} item(s) exist for other models — re-run with model:"*" to see them.`,
          );
        } else {
          parts.push(
            `No ${kind} items for this model or any other model; across all models the store holds: ${tally(all, (i) => i.kind)}.`,
          );
        }
      } else {
        parts.push(`Re-run with model:"*" to list every model's items.`);
      }
      return parts.join(" ");
    }
    // The model owns items, so only a kind filter can have emptied the result
    // (an unfiltered owner view of a non-empty `owned` is never empty).
    const kindElsewhere =
      kind !== undefined ? all.filter((i) => i.kind === kind && i.ownerModel !== ownerKey) : [];
    return (
      `No ${kind} items for model ${ownerKey}; it owns ${owned.length} item(s) in other kinds: ` +
      `${tally(owned, (i) => i.kind)}.` +
      (kindElsewhere.length > 0
        ? ` (${kindElsewhere.length} ${kind} item(s) exist for other models — re-run with model:"*" to see them.)`
        : "")
    );
  }
  // No owner filter: only a kind filter can have emptied the result.
  return `No ${kind} items. The store holds ${all.length} item(s) in other kinds: ${tally(all, (i) => i.kind)}.`;
}

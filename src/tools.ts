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
  type HarnessListParams,
  type HarnessMutateParams,
} from "./schemas.js";
import { applyDeltas, getActiveModelKey, getState, listItems } from "./store.js";
import { supportSummary } from "./list.js";
import type { AppliedDelta, ComponentKind, Delta } from "./types.js";

export type { HarnessListParams, HarnessMutateParams };

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool(
    harnessListTool(
      async (_toolCallId, params) => executeHarnessList(params as HarnessListParams),
    ),
  );
  pi.registerTool(
    harnessMutateTool(
      async (_toolCallId, params) => executeHarnessMutate(pi, params as HarnessMutateParams),
    ),
  );
}

/** harness_list execute: list items, optionally filtered. */
export async function executeHarnessList(params: HarnessListParams): Promise<AgentToolResult<unknown>> {
  const kind = params.kind as ComponentKind | undefined;
  const modelFilter = params.model as string | undefined;
  // Default scope = the active model's items (what gets injected this turn).
  // "*" = every model; an explicit id = that model. When no active model is
  // known (no turn started) and no filter is given, return all so the agent
  // is never silently shown an empty store during setup.
  const ownerKey =
    modelFilter === "*"
      ? undefined
      : modelFilter ?? getActiveModelKey();
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
  const incoming = params.deltas as Delta[];
  // `support` is SERVER-ONLY (review r4341960971): the update shape tolerates
  // additional properties, so a schema-valid call could otherwise carry
  // `support: { citations: 999 }` and fabricate execution/human-feedback
  // evidence for the lessons digest. Strip it at the tool boundary — the only
  // model-facing write path. Internal writers (dedupe merge, keep/drop,
  // outcome loop) call applyDeltas directly and keep it.
  const deltas = incoming.map((d): Delta => {
    if (d.op === "update" && "support" in d) {
      const copy = { ...d };
      delete copy.support;
      return copy;
    }
    return d;
  });
  // The active model is the ACTOR: creates bind to it, and update/delete are
  // scoped to it (per-model isolation). When the active model is unknown (no
  // turn started) there is no actor — creates become orphans, adopted next
  // turn, and update/delete are unscoped (graceful fallback).
  const applied: AppliedDelta[] = applyDeltas(
    deltas,
    (snapshot, ver) => {
      pi.appendEntry("harness-state", { state: snapshot, version: ver });
    },
    getActiveModelKey(),
  );
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

/** Tally `items` by a string key, rendered as "key (n), key (n)". */
function tally<T>(items: T[], key: (i: T) => string): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(key(i), (counts.get(key(i)) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k} (${n})`).join(", ");
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

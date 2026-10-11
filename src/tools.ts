// Model-facing tools. Two tools, kept lean for prompt economy:
//  - harness_list:  read items (optionally by kind).
//  - harness_mutate: apply a batch of structured CRUD deltas.
//
// Deltas — not prose rewrites — are the unit of self-improvement (ACE).
// Each create requires `evidence`, so the model must ground every addition.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { applyDeltas, getActiveModelKey, getState, listItems } from "./store.js";
import type { AppliedDelta, ComponentKind, Delta } from "./types.js";

const KIND_VALUES = ["prompt", "memory", "skill", "subagent"] as const;

const CreateShape = Type.Object({
  op: Type.Literal("create"),
  kind: StringEnum(KIND_VALUES),
  content: Type.String({ description: "The note/fact/description/spec text." }),
  evidence: Type.String({
    description: "Why this belongs in the harness state, grounded in trajectory evidence.",
  }),
  importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  // ownerModel is intentionally NOT exposed to the model: it is stamped
  // server-side from the active model so items bind to the model driving the
  // turn without the agent having to (or being able to) name it.
  scope: Type.Optional(
    StringEnum(["global", "project"], {
      description:
        "Durable-layer scope (default global). \"project\" binds the item to this session's project file (slug stamped server-side). Normally managed via /harness move or /harness split — set directly only when a new item is clearly project-specific.",
    }),
  ),
});

const UpdateShape = Type.Object({
  op: Type.Literal("update"),
  id: Type.String({ description: "Existing item id, e.g. h_..." }),
  content: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.String()),
  importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  active: Type.Optional(Type.Boolean()),
  scope: Type.Optional(
    StringEnum(["global", "project"], {
      description:
        "Move the item between durable layers (global file vs this session's project file). Use during a /harness split classification; leave unchanged otherwise.",
    }),
  ),
});

const DeleteShape = Type.Object({
  op: Type.Literal("delete"),
  id: Type.String(),
  reason: Type.String({ description: "Why this item is being removed." }),
});

const DeltaShape = Type.Union([CreateShape, UpdateShape, DeleteShape]);

// outputSchema (pi ≥ 0.99): codemode scripts and ctx.executeTool() callers get
// structuredContent instead of the text; the model still sees `content`.
const ItemSchema = Type.Object({
  id: Type.String(),
  kind: StringEnum(KIND_VALUES),
  content: Type.String(),
  evidence: Type.String(),
  importance: Type.Number(),
  active: Type.Boolean(),
  ownerModel: Type.String(),
  scope: Type.Optional(StringEnum(["global", "project"])),
  project: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});

const ListOutputSchema = Type.Object({
  count: Type.Number(),
  items: Type.Array(ItemSchema),
});

const MutateOutputSchema = Type.Object({
  applied: Type.Number(),
  created: Type.Number(),
  updated: Type.Number(),
  deleted: Type.Number(),
});

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "harness_list",
    label: "List harness state",
    description:
      "List items in the Continual Harness state (self-improved prompt notes, memory, skill descriptions, sub-agent specs). Optionally filter by kind. (/harness list is the human-facing TUI view: compact rows + durable-scope filters.)",
    promptSnippet: "Read Continual Harness self-improvement state",
    promptGuidelines: [
      "Call harness_list before proposing changes so you operate on current state.",
    ],
    parameters: Type.Object({
      kind: Type.Optional(StringEnum(KIND_VALUES)),
      model: Type.Optional(
        Type.String({
          description:
            "Filter by owner model as provider/id. Omit = the active model items; use * for all models.",
        }),
      ),
    }),
    outputSchema: ListOutputSchema,
    async execute(_toolCallId, params) {
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
                    .map(
                      (i) =>
                        `[${i.id}] (${i.kind}, importance ${i.importance.toFixed(2)}, ${i.active ? "active" : "inactive"}, model ${i.ownerModel || "(orphan)"}) ${i.content}\n  evidence: ${i.evidence}`,
                    )
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
            createdAt: i.createdAt,
            updatedAt: i.updatedAt,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "harness_mutate",
    label: "Mutate harness state",
    description:
      "Apply a batch of structured CRUD deltas to the Continual Harness state. Each create requires evidence grounded in trajectory. Prefer many small surgical deltas over wholesale rewrites.",
    promptSnippet: "Propose evidence-backed CRUD deltas to self-improvement state",
    promptGuidelines: [
      "Use harness_mutate during /refine or when you notice a durable, reusable correction. Ground every create in evidence. Prefer small surgical deltas.",
    ],
    parameters: Type.Object({
      deltas: Type.Array(DeltaShape, { minItems: 1, maxItems: 20 }),
    }),
    outputSchema: MutateOutputSchema,
    async execute(_toolCallId, params) {
      const incoming = params.deltas as Delta[];
      // The active model is the ACTOR: creates bind to it, and update/delete are
      // scoped to it (per-model isolation). When the active model is unknown (no
      // turn started) there is no actor — creates become orphans, adopted next
      // turn, and update/delete are unscoped (graceful fallback).
      const applied: AppliedDelta[] = applyDeltas(
        incoming,
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
    },
  });
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

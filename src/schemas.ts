// Tool schemas + registration metadata — the ONLY non-trivial code the thin
// entry (entry.ts) loads at pi startup (issue #36). Pi awaits every extension
// factory before startup continues, and in the one-shot path it has NOT yet
// loaded typebox or pi-ai — importing either from here costs ~0.4–1.0s
// (measured 2026-10-11). Schemas are therefore hand-written as PLAIN JSON
// Schema objects: exactly what TypeBox's Type.* builders emit, minus the
// library. test/schemas.test.ts guards the equivalence against real TypeBox
// output so the hand-written shapes cannot silently drift.
//
// This module is shared verbatim by BOTH registration paths:
//  - entry.ts (production): registers the tools with lazily-imported executes.
//  - tools.ts registerTools(): registers them with the same extracted execute
//    functions (tests drive this path directly).
// One source of truth: the definitions below can never drift between the two.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
// Type-only typebox import: erased at runtime, so typebox stays OUT of the
// startup graph (see module header). It remains a peerDependency for exactly
// this typing plus companion packages that build schemas themselves.
import type { TSchema } from "typebox";

export const KIND_VALUES = ["prompt", "memory", "skill", "subagent"] as const;

/** Local StringEnum shape — { type: "string", enum: [...] }, the same schema
 *  pi-ai's helper emits (for providers without anyOf/const support). */
function stringEnum<T extends readonly string[]>(values: T, options?: { description?: string }) {
  return {
    type: "string",
    enum: values,
    ...(options?.description ? { description: options.description } : {}),
  };
}

// Hand-written equivalents of the historical TypeBox shapes (verified by
// test/schemas.test.ts). Optional properties are simply omitted from
// `required`, exactly as Type.Optional does.
const CreateShape = {
  type: "object",
  properties: {
    op: { const: "create", type: "string" },
    kind: stringEnum(KIND_VALUES),
    content: { type: "string", description: "The note/fact/description/spec text." },
    evidence: {
      type: "string",
      description: "Why this belongs in the harness state, grounded in trajectory evidence.",
    },
    importance: { type: "number", minimum: 0, maximum: 1 },
    // ownerModel is intentionally NOT exposed to the model: it is stamped
    // server-side from the active model so items bind to the model driving the
    // turn without the agent having to (or being able to) name it.
    scope: stringEnum(["global", "project"], {
      description:
        "Durable-layer scope (default global). \"project\" binds the item to this session's project file (slug stamped server-side). Normally managed via /harness move or /harness split — set directly only when a new item is clearly project-specific.",
    }),
  },
  required: ["op", "kind", "content", "evidence"],
};

const UpdateShape = {
  type: "object",
  properties: {
    op: { const: "update", type: "string" },
    id: { type: "string", description: "Existing item id, e.g. h_..." },
    content: { type: "string" },
    evidence: { type: "string" },
    importance: { type: "number", minimum: 0, maximum: 1 },
    active: { type: "boolean" },
    scope: stringEnum(["global", "project"], {
      description:
        "Move the item between durable layers (global file vs this session's project file). Use during a /harness split classification; leave unchanged otherwise.",
    }),
  },
  required: ["op", "id"],
};

const DeleteShape = {
  type: "object",
  properties: {
    op: { const: "delete", type: "string" },
    id: { type: "string" },
    reason: { type: "string", description: "Why this item is being removed." },
  },
  required: ["op", "id", "reason"],
};

const DeltaShape = {
  anyOf: [CreateShape, UpdateShape, DeleteShape],
};

// outputSchema (pi ≥ 0.99): codemode scripts and ctx.executeTool() callers get
// structuredContent instead of the text; the model still sees `content`.
const ItemSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    kind: stringEnum(KIND_VALUES),
    content: { type: "string" },
    evidence: { type: "string" },
    importance: { type: "number" },
    active: { type: "boolean" },
    ownerModel: { type: "string" },
    scope: stringEnum(["global", "project"]),
    project: { type: "string" },
    support: {
      type: "object",
      properties: {
        citations: { type: "number" },
        keeps: { type: "number" },
        drops: { type: "number" },
        lastCitedAt: { type: "number" },
      },
    },
    createdAt: { type: "number" },
    updatedAt: { type: "number" },
  },
  required: [
    "id",
    "kind",
    "content",
    "evidence",
    "importance",
    "active",
    "ownerModel",
    "createdAt",
    "updatedAt",
  ],
};

const ListOutputSchema = {
  type: "object",
  properties: {
    count: { type: "number" },
    items: { type: "array", items: ItemSchema },
  },
  required: ["count", "items"],
};

const MutateOutputSchema = {
  type: "object",
  properties: {
    applied: { type: "number" },
    created: { type: "number" },
    updated: { type: "number" },
    deleted: { type: "number" },
  },
  required: ["applied", "created", "updated", "deleted"],
};

const ListParams = {
  type: "object",
  properties: {
    kind: stringEnum(KIND_VALUES),
    model: {
      type: "string",
      description:
        "Filter by owner model as provider/id. Omit = the active model items; use * for all models.",
    },
  },
};

const MutateParams = {
  type: "object",
  properties: {
    deltas: { type: "array", items: DeltaShape, minItems: 1, maxItems: 20 },
  },
  required: ["deltas"],
};

/** Tool params as derived from the schemas (the hand-written Static<>). */
export type HarnessListParams = { kind?: ComponentKindValue; model?: string };
/** Tool params as derived from the schemas (the hand-written Static<>). */
export type HarnessMutateParams = { deltas: unknown[] };

type ComponentKindValue = (typeof KIND_VALUES)[number];

/** Cast a hand-written JSON Schema object to the TSchema pi expects
 *  (the same thing TypeBox's Type.Unsafe does internally). */
function asSchema(s: object): TSchema {
  return s as TSchema;
}

/** Full harness_list definition around an `execute` supplied by the caller. */
export function harnessListTool(
  execute: ToolDefinition<TSchema, unknown>["execute"],
): ToolDefinition<TSchema, unknown> {
  return {
    name: "harness_list",
    label: "List harness state",
    description:
      "List items in the Continual Harness state (self-improved prompt notes, memory, skill descriptions, sub-agent specs). Optionally filter by kind. (/harness list is the human-facing TUI view: compact rows + durable-scope filters.)",
    promptSnippet: "Read Continual Harness self-improvement state",
    promptGuidelines: [
      "Call harness_list before proposing changes so you operate on current state.",
    ],
    parameters: asSchema(ListParams),
    outputSchema: asSchema(ListOutputSchema),
    execute,
  };
}

/** Full harness_mutate definition around an `execute` supplied by the caller. */
export function harnessMutateTool(
  execute: ToolDefinition<TSchema, unknown>["execute"],
): ToolDefinition<TSchema, unknown> {
  return {
    name: "harness_mutate",
    label: "Mutate harness state",
    description:
      "Apply a batch of structured CRUD deltas to the Continual Harness state. Each create requires evidence grounded in trajectory. Prefer many small surgical deltas over wholesale rewrites.",
    promptSnippet: "Propose evidence-backed CRUD deltas to self-improvement state",
    promptGuidelines: [
      "Use harness_mutate during /refine or when you notice a durable, reusable correction. Ground every create in evidence. Prefer small surgical deltas.",
    ],
    parameters: asSchema(MutateParams),
    outputSchema: asSchema(MutateOutputSchema),
    execute,
  };
}

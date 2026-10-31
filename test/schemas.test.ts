// Schema equivalence guard (issue #36): src/schemas.ts hand-writes the tool
// schemas as plain JSON objects so the thin entry does not pay for typebox
// (or pi-ai's StringEnum) at pi startup. This test builds the SAME schemas
// with real TypeBox — the shapes the package shipped before the refactor —
// and asserts the emitted JSON is identical, so the hand-written objects
// cannot silently drift from what pi and the providers expect.

import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import {
  harnessListTool,
  harnessMutateTool,
  KIND_VALUES,
  MAX_CONTENT_CHARS,
  MAX_DELTAS,
  MAX_EVIDENCE_CHARS,
  MAX_REASON_CHARS,
} from "../src/schemas.js";

// The historical TypeBox definitions, copied verbatim from the pre-#36
// tools.ts (which itself mirrored pi-ai's StringEnum helper) — extended with
// the length caps (maxLength) and the MAX_DELTAS cap the shipped schemas now
// declare.
function StringEnum<T extends readonly string[]>(values: T, options?: { description?: string }) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(options?.description ? { description: options.description } : {}),
  });
}

const CreateShape = Type.Object({
  op: Type.Literal("create"),
  kind: StringEnum(KIND_VALUES),
  content: Type.String({
    maxLength: MAX_CONTENT_CHARS,
    description: "The note/fact/description/spec text.",
  }),
  evidence: Type.String({
    maxLength: MAX_EVIDENCE_CHARS,
    description: "Why this belongs in the harness state, grounded in trajectory evidence.",
  }),
  importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  scope: Type.Optional(
    StringEnum(["global", "project"], {
      description:
        'Durable-layer scope (default global). "project" binds the item to this session\'s project file (slug stamped server-side). Normally managed via /harness move or /harness split — set directly only when a new item is clearly project-specific.',
    }),
  ),
});

const UpdateShape = Type.Object({
  op: Type.Literal("update"),
  id: Type.String({ description: "Existing item id, e.g. h_..." }),
  content: Type.Optional(Type.String({ maxLength: MAX_CONTENT_CHARS })),
  evidence: Type.Optional(Type.String({ maxLength: MAX_EVIDENCE_CHARS })),
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
  reason: Type.String({
    maxLength: MAX_REASON_CHARS,
    description: "Why this item is being removed.",
  }),
});

const DeltaShape = Type.Union([CreateShape, UpdateShape, DeleteShape]);

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
  support: Type.Optional(
    Type.Object({
      citations: Type.Optional(Type.Number()),
      keeps: Type.Optional(Type.Number()),
      drops: Type.Optional(Type.Number()),
      lastCitedAt: Type.Optional(Type.Number()),
    }),
  ),
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

const ListParams = Type.Object({
  kind: Type.Optional(StringEnum(KIND_VALUES)),
  model: Type.Optional(
    Type.String({
      description:
        "Filter by owner model as provider/id. Omit = the active model items; use * for all models.",
    }),
  ),
});

const MutateParams = Type.Object({
  deltas: Type.Array(DeltaShape, { minItems: 1, maxItems: MAX_DELTAS }),
});

const stub = async () => ({ content: [], details: undefined });

function stable(s: object): unknown {
  // Key order does not matter for schema semantics; compare sorted.
  return JSON.parse(
    JSON.stringify(s, (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
        : v,
    ),
  );
}

describe("hand-written schemas match TypeBox output (issue #36)", () => {
  it("harness_list parameters are identical", () => {
    const shipped = harnessListTool(stub).parameters;
    expect(stable(shipped)).toEqual(stable(ListParams));
  });

  it("harness_list outputSchema is identical", () => {
    const shipped = harnessListTool(stub).outputSchema!;
    expect(stable(shipped)).toEqual(stable(ListOutputSchema));
  });

  it("harness_mutate parameters are identical", () => {
    const shipped = harnessMutateTool(stub).parameters;
    expect(stable(shipped)).toEqual(stable(MutateParams));
  });

  it("harness_mutate outputSchema is identical", () => {
    const shipped = harnessMutateTool(stub).outputSchema!;
    expect(stable(shipped)).toEqual(stable(MutateOutputSchema));
  });
});

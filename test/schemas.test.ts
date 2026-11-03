// Schema equivalence guard (issue #36): src/schemas.ts hand-writes the tool
// schemas as plain JSON objects so the thin entry does not pay for typebox
// (or pi-ai's StringEnum) at pi startup. This test builds the SAME schemas
// with real TypeBox — the shapes the package shipped before the refactor —
// and asserts the emitted JSON is identical, so the hand-written objects
// cannot silently drift from what pi and the providers expect.

import { describe, it, expect } from "vitest";
import { compile, type JsonSchema } from "@earendil-works/pi-schema";
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

// pi 1.5 moved tool-argument validation to @earendil-works/pi-schema (a
// breaking change: TypeBox-only features no longer apply, JSON-Schema tools
// gain the coercion TypeBox tools had, and failure messages changed format).
// These tests run the SHIPPED hand-written schemas through the same
// compile({ coerce: true }) path pi applies to tool arguments, so the package
// is certified against the validator that actually guards harness_mutate —
// not just against TypeBox's emitted JSON (the suite above).
describe("pi-schema tool-argument validation (pi 1.5)", () => {
  // parameters is typed TSchema (typebox); pi-schema has its own JsonSchema
  // type over the same JSON — the shapes are asserted identical to TypeBox
  // output in the suite above.
  const paramsOf = (tool: { parameters: object }) => tool.parameters as unknown as JsonSchema;
  const mutate = compile(paramsOf(harnessMutateTool(stub)), { coerce: true });
  const list = compile(paramsOf(harnessListTool(stub)), { coerce: true });

  const create = (over: Record<string, unknown> = {}) => ({
    op: "create",
    kind: "memory",
    content: "prefers tab indentation",
    evidence: "user corrected indentation twice this session",
    ...over,
  });

  it("accepts a well-formed batch", () => {
    const r = mutate.parse({ deltas: [create(), { op: "delete", id: "h_1", reason: "stale" }] });
    expect(r.ok).toBe(true);
  });

  it("coerces loosely typed args like TypeBox tools now do", () => {
    const r = mutate.parse({
      deltas: [
        create({ importance: "0.8" }),
        { op: "update", id: "h_1", active: "true", importance: "0" },
      ],
    });
    expect(r).toEqual({
      ok: true,
      value: {
        deltas: [
          create({ importance: 0.8 }),
          { op: "update", id: "h_1", active: true, importance: 0 },
        ],
      },
    });
  });

  it("wraps a bare delta in a one-item array", () => {
    const r = mutate.parse({ deltas: create() });
    if (!r.ok) throw new Error(`expected coercion: ${JSON.stringify(r.errors)}`);
    expect((r.value as { deltas: unknown[] }).deltas).toHaveLength(1);
  });

  it("still rejects schema violations after coercion", () => {
    // One failure per keyword; assert path+keyword, not the message text —
    // pi-schema message wording is not this package's contract.
    const expectReject = (input: unknown, path: string, keyword: string) => {
      const r = mutate.parse(input);
      if (r.ok) throw new Error("expected rejection");
      expect(r.errors[0]).toMatchObject({ path, keyword });
    };

    expectReject({ deltas: [create({ importance: 1.5 })] }, "/deltas/0/importance", "maximum");
    expectReject({ deltas: [create({ importance: -0.1 })] }, "/deltas/0/importance", "minimum");
    expectReject(
      { deltas: [{ op: "create", kind: "memory", content: "no why" }] },
      "/deltas/0/evidence",
      "required",
    );
    expectReject({ deltas: [create({ kind: "bogus" })] }, "/deltas/0/kind", "enum");
    expectReject({ deltas: [] }, "/deltas", "minItems");
    expectReject(
      {
        deltas: Array.from({ length: MAX_DELTAS + 1 }, () => ({
          op: "delete",
          id: "h_1",
          reason: "r",
        })),
      },
      "/deltas",
      "maxItems",
    );
  });

  it("harness_list params validate", () => {
    expect(list.parse({}).ok).toBe(true);
    expect(list.parse({ kind: "memory", model: "anthropic/claude-sonnet-4" }).ok).toBe(true);
    expect(list.parse({ kind: "bogus" }).ok).toBe(false);
  });
});

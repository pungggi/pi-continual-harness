// Pure unit tests for the store: CRUD/delta semantics, rollback, reconstruction,
// decay/prune, durable export. No pi stub needed — applyDeltas takes a `persist`
// callback, which decouples it from the ExtensionAPI.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptOrphans,
  applyDeltas,
  bumpImportance,
  decayAndPrune,
  exportDurable,
  exportDurableLayers,
  getState,
  importDurableLayers,
  IMPORTANCE_FLOOR,
  listItems,
  modelKey,
  parseDurable,
  reconstruct,
  reconstructFromDurable,
  setSessionProject,
} from "../src/store.js";
import type { Delta } from "../src/types.js";

function reset(): void {
  reconstruct([]);
  setSessionProject(undefined);
}

describe("applyDeltas — create", () => {
  beforeEach(reset);

  it("creates an item, persists a snapshot, and assigns an id", () => {
    const persist = vi.fn();
    const deltas: Delta[] = [
      { op: "create", kind: "memory", content: "prefer tabs", evidence: "user said so" },
    ];
    const applied = applyDeltas(deltas, persist);

    expect(applied).toHaveLength(1);
    expect(applied[0]!.op).toBe("create");
    const item = applied[0]!.op === "create" ? applied[0]!.item : undefined;
    expect(item?.id).toMatch(/^h_/);
    expect(item?.content).toBe("prefer tabs");
    expect(item?.evidence).toBe("user said so");
    expect(item?.active).toBe(true);
    expect(getState().items).toHaveLength(1);
    expect(persist).toHaveBeenCalledTimes(1);
    // Snapshot passed to persist reflects the new item.
    const snapshot = persist.mock.calls[0]![0];
    expect(snapshot.items).toHaveLength(1);
  });

  it("clamps importance to [0,1]", () => {
    applyDeltas(
      [{ op: "create", kind: "prompt", content: "x", evidence: "y", importance: 5 }],
      vi.fn(),
    );
    applyDeltas(
      [{ op: "create", kind: "prompt", content: "x2", evidence: "y2", importance: -1 }],
      vi.fn(),
    );
    const imps = getState().items.map((i) => i.importance);
    expect(imps).toEqual([1, 0]);
  });
});

describe("applyDeltas — update / delete", () => {
  beforeEach(reset);

  it("updates fields and toggles active", () => {
    const [created] = applyDeltas(
      [{ op: "create", kind: "memory", content: "v1", evidence: "e" }],
      vi.fn(),
    );
    const id = created!.op === "create" ? created!.item.id : "";
    const [updated] = applyDeltas(
      [{ op: "update", id, content: "v2", active: false, importance: 0.9 }],
      vi.fn(),
    );
    const after = updated!.op === "update" ? updated!.after : undefined;
    expect(after?.content).toBe("v2");
    expect(after?.active).toBe(false);
    expect(after?.importance).toBe(0.9);
  });

  it("deletes by id", () => {
    const [created] = applyDeltas(
      [{ op: "create", kind: "skill", content: "s", evidence: "e" }],
      vi.fn(),
    );
    const id = created!.op === "create" ? created!.item.id : "";
    applyDeltas([{ op: "delete", id, reason: "stale" }], vi.fn());
    expect(getState().items).toHaveLength(0);
  });

  it("throws on update/delete of unknown id", () => {
    expect(() => applyDeltas([{ op: "update", id: "nope", content: "x" }], vi.fn())).toThrow();
    expect(() => applyDeltas([{ op: "delete", id: "nope", reason: "r" }], vi.fn())).toThrow();
  });
});

describe("applyDeltas — atomicity", () => {
  beforeEach(reset);

  it("rolls back the whole batch and skips persist if any delta fails", () => {
    const persist = vi.fn();
    const deltas: Delta[] = [
      { op: "create", kind: "memory", content: "survivor", evidence: "e" },
      { op: "update", id: "does-not-exist", content: "boom" }, // throws
    ];
    expect(() => applyDeltas(deltas, persist)).toThrow();
    // Survivor must NOT remain: in-memory state restored to pre-batch snapshot.
    expect(getState().items).toHaveLength(0);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("reconstruct", () => {
  beforeEach(reset);

  it("restores from the last harness-state snapshot on the branch", () => {
    const entries = [
      {
        type: "custom",
        customType: "harness-state",
        data: {
          state: {
            items: [{ id: "h_a", kind: "memory", content: "old", evidence: "e", importance: 0.5, active: true, createdAt: 1, updatedAt: 1 }],
          },
        },
      },
      {
        type: "custom",
        customType: "harness-state",
        data: {
          state: {
            items: [{ id: "h_b", kind: "prompt", content: "new", evidence: "e", importance: 0.5, active: true, createdAt: 2, updatedAt: 2 }],
          },
        },
      },
    ];
    reconstruct(entries);
    expect(getState().items.map((i) => i.id)).toEqual(["h_b"]);
  });

  it("ignores unrelated custom and message entries", () => {
    const entries = [
      { type: "custom", customType: "harness-refinement", data: {} },
      { type: "message", message: { role: "user" } },
    ];
    reconstruct(entries);
    expect(getState().items).toHaveLength(0);
  });

  it("resets to empty when no snapshot is present", () => {
    applyDeltas([{ op: "create", kind: "memory", content: "x", evidence: "y" }], vi.fn());
    expect(getState().items).toHaveLength(1);
    reconstruct([]);
    expect(getState().items).toHaveLength(0);
  });
});

describe("listItems", () => {
  beforeEach(reset);

  it("filters by kind", () => {
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "m", evidence: "e" },
        { op: "create", kind: "prompt", content: "p", evidence: "e" },
      ],
      vi.fn(),
    );
    expect(listItems("memory")).toHaveLength(1);
    expect(listItems("prompt")).toHaveLength(1);
    expect(listItems()).toHaveLength(2);
  });
});

describe("decayAndPrune", () => {
  beforeEach(reset);

  it("removes items below the importance floor", () => {
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "keep", evidence: "e", importance: 0.8 },
        { op: "create", kind: "memory", content: "drop", evidence: "e", importance: IMPORTANCE_FLOOR - 0.05 },
      ],
      vi.fn(),
    );
    const persist = vi.fn();
    const { pruned, decayed } = decayAndPrune({}, persist);
    expect(pruned).toBe(1);
    expect(decayed).toBe(0);
    expect(getState().items.map((i) => i.content)).toEqual(["keep"]);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("ages old items (--decay) then prunes below floor", () => {
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "stale", evidence: "e", importance: 0.35 },
        { op: "create", kind: "memory", content: "fresh", evidence: "e", importance: 0.35 },
      ],
      vi.fn(),
    );
    // Force "stale" old; leave "fresh" recent.
    const items = getState().items;
    items.find((i) => i.content === "stale")!.updatedAt = Date.now() - 30 * 86_400_000;
    const res = decayAndPrune({ decayAfterDays: 7, decayStep: 0.1 }, vi.fn());
    // stale: 0.35 - 0.1 = 0.25 < floor → decayed + pruned; fresh stays 0.35
    expect(res.decayed).toBe(1);
    expect(res.pruned).toBe(1);
    expect(getState().items.map((i) => i.content)).toEqual(["fresh"]);
  });
});

describe("bumpImportance", () => {
  beforeEach(reset);

  it("nudges ±, clamps to [0,1], touches updatedAt, and persists", () => {
    const [c] = applyDeltas(
      [{ op: "create", kind: "memory", content: "x", evidence: "e", importance: 0.5 }],
      vi.fn(),
    );
    const id = c!.op === "create" ? c!.item.id : "";
    const persist = vi.fn();
    const up = bumpImportance(id, 0.2, persist);
    expect(up?.importance).toBeCloseTo(0.7);
    const down = bumpImportance(id, -1, persist); // clamps to 0
    expect(down?.importance).toBe(0);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(bumpImportance("nope", 0.1, persist)).toBeUndefined();
  });
});

describe("exportDurable", () => {
  beforeEach(reset);

  it("writes active items grouped by kind, excluding inactive ones", async () => {
    applyDeltas(
      [
        { op: "create", kind: "prompt", content: "be terse", evidence: "user feedback", importance: 0.8 },
        { op: "create", kind: "memory", content: "uses vitest", evidence: "saw config", importance: 0.7 },
        { op: "create", kind: "skill", content: "hidden one", evidence: "e", importance: 0.5 },
      ],
      vi.fn(),
    );
    // Deactivate the skill so it is excluded from the durable export.
    const skill = listItems("skill")[0]!;
    applyDeltas([{ op: "update", id: skill.id, active: false }], vi.fn());

    const dir = mkdtempSync(join(tmpdir(), "pi-ch-durable-"));
    const file = join(dir, "harness-state.md");
    try {
      const written = await exportDurable(file);
      expect(written).toBe(file);
      const body = readFileSync(file, "utf8");
      expect(body).toContain("Supplemental prompt notes");
      expect(body).toContain("be terse");
      expect(body).toContain("Memory facts");
      expect(body).toContain("uses vitest");
      // Inactive skill must not appear.
      expect(body).not.toContain("hidden one");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseDurable + reconstructFromDurable", () => {
  beforeEach(reset);

  it("parseDurable inverts exportDurable (round-trip of the canonical format)", async () => {
    applyDeltas(
      [
        { op: "create", kind: "prompt", content: "be terse", evidence: "user feedback", importance: 0.8 },
        { op: "create", kind: "memory", content: "uses vitest", evidence: "saw config", importance: 0.7 },
      ],
      vi.fn(),
    );
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-rt-"));
    const file = join(dir, "harness-state.md");
    try {
      await exportDurable(file);
      const parsed = parseDurable(readFileSync(file, "utf8"));
      expect(parsed).toHaveLength(2);
      const byContent = new Map(parsed.map((p) => [p.content, p]));
      expect(byContent.get("be terse")?.kind).toBe("prompt");
      expect(byContent.get("be terse")?.importance).toBeCloseTo(0.8);
      expect(byContent.get("be terse")?.evidence).toBe("user feedback");
      expect(byContent.get("uses vitest")?.kind).toBe("memory");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconstructFromDurable updates by id (durable wins) and creates new items", async () => {
    const [c] = applyDeltas(
      [{ op: "create", kind: "prompt", content: "old", evidence: "old ev", importance: 0.5 }],
      vi.fn(),
    );
    const id = c!.op === "create" ? c!.item.id : "";
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-imp-"));
    const file = join(dir, "harness-state.md");
    // Simulate pi-reflect: rewrite the existing item's content/importance and
    // add a brand-new bullet (no **[id]**).
    writeFileSync(
      file,
      [
        "# Continual Harness State",
        "",
        "## Supplemental prompt notes",
        "",
        `- **[${id}]** (importance 0.90) be terse and cite evidence`,
        `  - evidence: refined offline by pi-reflect`,
        `- new note pi-reflect added`,
        "",
      ].join("\n"),
      "utf8",
    );
    const persist = vi.fn();
    let res;
    try {
      res = await reconstructFromDurable(file, {}, persist);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(res.missingFile).toBe(false);
    expect(res.imported).toBe(2);
    expect(res.updated).toBe(1);
    expect(res.created).toBe(1);
    expect(res.pruned).toBe(0);
    const items = getState().items;
    const updated = items.find((i) => i.id === id)!;
    expect(updated.content).toBe("be terse and cite evidence");
    expect(updated.importance).toBeCloseTo(0.9);
    expect(updated.evidence).toBe("refined offline by pi-reflect");
    expect(items).toHaveLength(2);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("{ prune: true } drops active items absent from the file, keeps inactive ones", async () => {
    const [keep] = applyDeltas(
      [{ op: "create", kind: "memory", content: "keep me", evidence: "e", importance: 0.6 }],
      vi.fn(),
    );
    applyDeltas(
      [{ op: "create", kind: "memory", content: "drop me", evidence: "e", importance: 0.6 }],
      vi.fn(),
    );
    const [inactive] = applyDeltas(
      [{ op: "create", kind: "memory", content: "inactive", evidence: "e", importance: 0.6 }],
      vi.fn(),
    );
    applyDeltas(
      [{ op: "update", id: inactive!.op === "create" ? inactive!.item.id : "", active: false }],
      vi.fn(),
    );
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-prune-"));
    const file = join(dir, "harness-state.md");
    writeFileSync(
      file,
      [
        "# Continual Harness State",
        "",
        "## Memory facts",
        "",
        `- **[${keep!.op === "create" ? keep!.item.id : ""}]** (importance 0.60) keep me`,
        `  - evidence: e`,
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const res = await reconstructFromDurable(file, { prune: true }, vi.fn());
      expect(res.pruned).toBe(1);
      const contents = getState().items.map((i) => i.content);
      expect(contents).toContain("keep me");
      expect(contents).not.toContain("drop me");
      expect(contents).toContain("inactive"); // inactive items are never pruned
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns missingFile and is a no-op when the path does not exist", async () => {
    const persist = vi.fn();
    const res = await reconstructFromDurable(
      join(tmpdir(), `does-not-exist-${Date.now()}.md`),
      {},
      persist,
    );
    expect(res.missingFile).toBe(true);
    expect(res.imported).toBe(0);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("modelKey", () => {
  it("renders provider/id and is undefined for no model", () => {
    expect(modelKey({ provider: "anthropic", id: "claude-sonnet-4" })).toBe("anthropic/claude-sonnet-4");
    expect(modelKey(undefined)).toBeUndefined();
  });
});

describe("model binding — applyDeltas stamps ownerModel", () => {
  beforeEach(reset);

  it("create uses delta.ownerModel, defaulting to orphan (\"\")", () => {
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "tagged", evidence: "e", ownerModel: "anthropic/sonnet" },
        { op: "create", kind: "memory", content: "orphan", evidence: "e" },
      ],
      vi.fn(),
    );
    const byContent = new Map(getState().items.map((i) => [i.content, i.ownerModel]));
    expect(byContent.get("tagged")).toBe("anthropic/sonnet");
    expect(byContent.get("orphan")).toBe("");
  });

  it("update preserves owner when omitted, reassigns when given", () => {
    const [c] = applyDeltas(
      [{ op: "create", kind: "memory", content: "x", evidence: "e", ownerModel: "a/b" }],
      vi.fn(),
    );
    const id = c!.op === "create" ? c!.item.id : "";
    applyDeltas([{ op: "update", id, content: "y" }], vi.fn());
    expect(getState().items[0]!.ownerModel).toBe("a/b");
    applyDeltas([{ op: "update", id, ownerModel: "c/d" }], vi.fn());
    expect(getState().items[0]!.ownerModel).toBe("c/d");
  });
});

describe("model binding — adoptOrphans", () => {
  beforeEach(reset);

  it("stamps orphans to the key, leaves owned items alone, persists once", () => {
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "orphan", evidence: "e" },
        { op: "create", kind: "memory", content: "owned", evidence: "e", ownerModel: "anthropic/sonnet" },
      ],
      vi.fn(),
    );
    const persist = vi.fn();
    expect(adoptOrphans("google/gemini", persist)).toBe(1);
    const byContent = new Map(getState().items.map((i) => [i.content, i.ownerModel]));
    expect(byContent.get("orphan")).toBe("google/gemini");
    expect(byContent.get("owned")).toBe("anthropic/sonnet");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (no persist) when there are no orphans", () => {
    applyDeltas([{ op: "create", kind: "memory", content: "x", evidence: "e", ownerModel: "a/b" }], vi.fn());
    const persist = vi.fn();
    expect(adoptOrphans("a/b", persist)).toBe(0);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("model binding — reconstruct normalizes legacy snapshots", () => {
  beforeEach(reset);

  it("treats items missing ownerModel as orphans", () => {
    reconstruct([
      {
        type: "custom",
        customType: "harness-state",
        data: { state: { items: [{ id: "h_a", kind: "memory", content: "legacy", evidence: "e", importance: 0.5, active: true, createdAt: 1, updatedAt: 1 }] } },
      },
    ]);
    expect(getState().items[0]!.ownerModel).toBe("");
  });

  it("preserves an explicit ownerModel", () => {
    reconstruct([
      {
        type: "custom",
        customType: "harness-state",
        data: { state: { items: [{ id: "h_a", kind: "memory", content: "x", evidence: "e", importance: 0.5, active: true, ownerModel: "anthropic/sonnet", createdAt: 1, updatedAt: 1 }] } },
      },
    ]);
    expect(getState().items[0]!.ownerModel).toBe("anthropic/sonnet");
  });
});

describe("model binding — durable round-trip", () => {
  beforeEach(reset);

  it("export emits one model: line per owned item; parse inverts it", async () => {
    applyDeltas(
      [
        { op: "create", kind: "prompt", content: "owned note", evidence: "e", ownerModel: "anthropic/sonnet" },
        { op: "create", kind: "memory", content: "orphan fact", evidence: "e" },
      ],
      vi.fn(),
    );
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-model-rt-"));
    const file = join(dir, "harness-state.md");
    try {
      await exportDurable(file);
      const body = readFileSync(file, "utf8");
      // exactly one model: line — the orphan (ownerModel "") emits none
      expect((body.match(/^\s+- model:/gm) ?? []).length).toBe(1);
      expect(body).toContain("model: anthropic/sonnet");
      const parsed = parseDurable(body);
      const byContent = new Map(parsed.map((p) => [p.content, p]));
      expect(byContent.get("owned note")?.ownerModel).toBe("anthropic/sonnet");
      expect(byContent.get("orphan fact")?.ownerModel).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconstructFromDurable carries owner through import; untagged items stay orphans", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-model-imp-"));
    const file = join(dir, "harness-state.md");
    writeFileSync(
      file,
      [
        "# Continual Harness State",
        "",
        "## Memory facts",
        "",
        "- **[h_owned]** (importance 0.50) tagged",
        "  - evidence: e",
        "  - model: google/gemini",
        "- **[h_plain]** (importance 0.50) untagged",
        "  - evidence: e",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      await reconstructFromDurable(file, {}, vi.fn());
      const byId = new Map(getState().items.map((i) => [i.id, i.ownerModel]));
      expect(byId.get("h_owned")).toBe("google/gemini");
      expect(byId.get("h_plain")).toBe(""); // orphan → adopted by active model on first contact
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an untagged durable entry orphans an existing owned item (adopted on first contact)", async () => {
    applyDeltas(
      [{ op: "create", kind: "memory", content: "tagged", evidence: "e", ownerModel: "anthropic/sonnet" }],
      vi.fn(),
    );
    const id = getState().items[0]!.id;
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-model-strip-"));
    const file = join(dir, "harness-state.md");
    writeFileSync(
      file,
      [
        "# Continual Harness State",
        "",
        "## Memory facts",
        "",
        `- **[${id}]** (importance 0.50) stripped by pi-reflect`,
        `  - evidence: e`,
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      await reconstructFromDurable(file, {}, vi.fn());
      // durable wins on owner: the absent tag orphans the item (→ adopted by the
      // active model on first contact), matching the documented round-trip.
      expect(getState().items[0]!.ownerModel).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- per-item durable scope (issue #7) --------------------------------------

describe("scope — create/update via deltas", () => {
  beforeEach(reset);

  it("creates items global by default", () => {
    applyDeltas([{ op: "create", kind: "memory", content: "m", evidence: "e" }], vi.fn());
    expect(getState().items[0]!.scope).toBe("global");
    expect(getState().items[0]!.project).toBeUndefined();
  });

  it(`scope:"project" on create stamps the cached session slug; explicit project wins`, () => {
    setSessionProject("my-proj");
    applyDeltas([{ op: "create", kind: "memory", content: "m", evidence: "e", scope: "project" }], vi.fn());
    expect(getState().items[0]!.scope).toBe("project");
    expect(getState().items[0]!.project).toBe("my-proj");

    applyDeltas(
      [{ op: "create", kind: "memory", content: "m2", evidence: "e", scope: "project", project: "other" }],
      vi.fn(),
    );
    expect(getState().items[1]!.project).toBe("other");
  });

  it(`scope:"project" without any resolvable slug throws and rolls the batch back`, () => {
    expect(() =>
      applyDeltas(
        [
          { op: "create", kind: "memory", content: "ok", evidence: "e" },
          { op: "create", kind: "memory", content: "bad", evidence: "e", scope: "project" },
        ],
        vi.fn(),
      ),
    ).toThrow(/project slug/);
    expect(getState().items).toHaveLength(0); // atomic rollback
  });

  it(`update re-scopes an item; "global" clears the project binding`, () => {
    setSessionProject("my-proj");
    const [c] = applyDeltas(
      [{ op: "create", kind: "memory", content: "m", evidence: "e", scope: "project" }],
      vi.fn(),
    );
    const id = c!.op === "create" ? c!.item.id : "";
    expect(getState().items[0]!.project).toBe("my-proj");

    applyDeltas([{ op: "update", id, scope: "global" }], vi.fn());
    expect(getState().items[0]!.scope).toBe("global");
    expect(getState().items[0]!.project).toBeUndefined();
  });

  it("reconstruct normalizes legacy snapshots (missing scope → global, slugless project → global)", () => {
    reconstruct([
      {
        type: "custom",
        customType: "harness-state",
        data: {
          state: {
            items: [
              { id: "h_a", kind: "memory", content: "legacy", evidence: "e", importance: 0.5, active: true, ownerModel: "", createdAt: 1, updatedAt: 1 },
              { id: "h_b", kind: "memory", content: "broken", evidence: "e", importance: 0.5, active: true, ownerModel: "", scope: "project", createdAt: 1, updatedAt: 1 },
              { id: "h_c", kind: "memory", content: "ok", evidence: "e", importance: 0.5, active: true, ownerModel: "", scope: "project", project: "p1", createdAt: 1, updatedAt: 1 },
            ],
          },
        },
      },
    ]);
    const byId = new Map(getState().items.map((i) => [i.id, i]));
    expect(byId.get("h_a")!.scope).toBe("global");
    expect(byId.get("h_b")!.scope).toBe("global"); // slugless project degrades
    expect(byId.get("h_b")!.project).toBeUndefined();
    expect(byId.get("h_c")!.scope).toBe("project");
    expect(byId.get("h_c")!.project).toBe("p1");
  });
});

describe("durable layers — export", () => {
  beforeEach(reset);

  it("exportDurable tags project items with a scope: sub-line; parseDurable inverts it", async () => {
    setSessionProject("p1");
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "global fact", evidence: "e" },
        { op: "create", kind: "memory", content: "project fact", evidence: "e", scope: "project" },
      ],
      vi.fn(),
    );
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-scope-rt-"));
    const file = join(dir, "snapshot.md");
    try {
      await exportDurable(file);
      const body = readFileSync(file, "utf8");
      expect(body).toContain("- scope: project (p1)");
      expect(body).not.toContain("- scope: global"); // globals stay untagged

      const parsed = parseDurable(body);
      const byContent = new Map(parsed.map((p) => [p.content, p]));
      expect(byContent.get("project fact")!.scope).toBe("project");
      expect(byContent.get("project fact")!.project).toBe("p1");
      expect(byContent.get("global fact")!.scope).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exportDurableLayers partitions by scope and never creates empty foreign files", async () => {
    setSessionProject("cur");
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "g", evidence: "e" },
        { op: "create", kind: "memory", content: "cur-1", evidence: "e", scope: "project" },
        { op: "create", kind: "memory", content: "other-1", evidence: "e", scope: "project", project: "other" },
      ],
      vi.fn(),
    );
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-layers-"));
    const paths = { globalPath: join(dir, "harness-state.md"), projectDir: join(dir, "harness-state") };
    try {
      const written = await exportDurableLayers(paths, "cur");
      expect(written).toEqual([
        paths.globalPath,
        join(paths.projectDir, "cur.md"),
        join(paths.projectDir, "other.md"),
      ]);
      expect(readFileSync(paths.globalPath, "utf8")).toContain(") g");
      expect(readFileSync(paths.globalPath, "utf8")).not.toContain("cur-1");
      expect(readFileSync(paths.globalPath, "utf8")).not.toContain("other-1");
      expect(readFileSync(join(paths.projectDir, "cur.md"), "utf8")).toContain("cur-1");
      expect(readFileSync(join(paths.projectDir, "other.md"), "utf8")).toContain("other-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exportDurableLayers empties the current project layer when its last item goes away", async () => {
    setSessionProject("cur");
    const [c] = applyDeltas(
      [{ op: "create", kind: "memory", content: "cur-1", evidence: "e", scope: "project" }],
      vi.fn(),
    );
    const id = c!.op === "create" ? c!.item.id : "";
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-layers-del-"));
    const paths = { globalPath: join(dir, "harness-state.md"), projectDir: join(dir, "harness-state") };
    try {
      await exportDurableLayers(paths, "cur");
      expect(readFileSync(join(paths.projectDir, "cur.md"), "utf8")).toContain("cur-1");

      applyDeltas([{ op: "delete", id, reason: "moved on" }], vi.fn());
      await exportDurableLayers(paths, "cur");
      expect(readFileSync(join(paths.projectDir, "cur.md"), "utf8")).toContain("_(no active items)_");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("durable layers — import", () => {
  beforeEach(reset);

  function layerFile(dir: string, name: string, defaultScope: { scope: "global" | "project"; project?: string }, bullets: string[]): { path: string; defaultScope: typeof defaultScope } {
    const file = join(dir, name);
    writeFileSync(
      file,
      [
        "# Continual Harness State",
        "",
        "## Memory facts",
        "",
        ...bullets,
        "",
      ].join("\n"),
      "utf8",
    );
    return { path: file, defaultScope };
  }

  it("importDurableLayers merges both layers; the project layer wins id collisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-imp-layers-"));
    try {
      const files = [
        layerFile(dir, "global.md", { scope: "global" }, [
          "- **[h_shared]** (importance 0.50) global copy",
          "  - evidence: e",
          "- **[h_g]** (importance 0.50) global only",
          "  - evidence: e",
        ]),
        layerFile(dir, "proj.md", { scope: "project", project: "proj" }, [
          "- **[h_shared]** (importance 0.80) project copy",
          "  - evidence: e",
          "- **[h_p]** (importance 0.50) project only",
          "  - evidence: e",
        ]),
      ];
      const res = await importDurableLayers(files, {}, vi.fn());
      expect(res.missingFile).toBe(false);
      expect(res.imported).toBe(4); // h_shared parsed from BOTH layers
      expect(res.created).toBe(3);
      expect(res.updated).toBe(1); // h_shared's project copy updates its global copy

      const byId = new Map(getState().items.map((i) => [i.id, i]));
      expect(byId.get("h_shared")!.content).toBe("project copy"); // later layer wins
      expect(byId.get("h_shared")!.scope).toBe("project");
      expect(byId.get("h_shared")!.project).toBe("proj");
      expect(byId.get("h_g")!.scope).toBe("global");
      expect(byId.get("h_p")!.project).toBe("proj");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("{ prune: true } is union-scoped: items present in ANY layer survive", async () => {
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "live-global", evidence: "e" },
        { op: "create", kind: "memory", content: "live-project", evidence: "e", scope: "project", project: "proj" },
        { op: "create", kind: "memory", content: "doomed", evidence: "e" },
      ],
      vi.fn(),
    );
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-imp-union-"));
    try {
      const liveGlobal = getState().items.find((i) => i.content === "live-global")!;
      const liveProject = getState().items.find((i) => i.content === "live-project")!;
      const files = [
        layerFile(dir, "global.md", { scope: "global" }, [
          `- **[${liveGlobal.id}]** (importance 0.60) live-global`,
          "  - evidence: e",
        ]),
        layerFile(dir, "proj.md", { scope: "project", project: "proj" }, [
          `- **[${liveProject.id}]** (importance 0.60) live-project`,
          "  - evidence: e",
        ]),
      ];
      const res = await importDurableLayers(files, { prune: true }, vi.fn());
      expect(res.pruned).toBe(1); // only "doomed" (absent from every layer)
      const contents = getState().items.map((i) => i.content);
      expect(contents).toContain("live-global");
      expect(contents).toContain("live-project");
      expect(contents).not.toContain("doomed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missingFile when NO layer file exists", async () => {
    const persist = vi.fn();
    const res = await importDurableLayers(
      [
        { path: join(tmpdir(), `nope-g-${Date.now()}.md`), defaultScope: { scope: "global" } },
        { path: join(tmpdir(), `nope-p-${Date.now()}.md`), defaultScope: { scope: "project", project: "x" } },
      ],
      {},
      persist,
    );
    expect(res.missingFile).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("a slugless `scope: project` tag degrades to global on import", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-imp-degrade-"));
    const file = join(dir, "global.md");
    writeFileSync(
      file,
      [
        "# Continual Harness State",
        "",
        "## Memory facts",
        "",
        "- **[h_slugless]** (importance 0.50) no slug",
        "  - evidence: e",
        "  - scope: project",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      await importDurableLayers([{ path: file, defaultScope: { scope: "global" } }], {}, vi.fn());
      const item = getState().items.find((i) => i.id === "h_slugless")!;
      expect(item.scope).toBe("global");
      expect(item.project).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("idempotent: re-importing an unchanged file persists nothing (no tree noise)", async () => {
    applyDeltas([{ op: "create", kind: "memory", content: "fact", evidence: "e", importance: 0.5, ownerModel: "m/x" }], vi.fn());
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-imp-idem-"));
    const file = join(dir, "harness-state.md");
    await exportDurable(file);
    const persist = vi.fn();
    try {
      const first = await reconstructFromDurable(file, {}, persist);
      expect(first.updated).toBe(0); // export reflects the live item exactly
      expect(first.created).toBe(0);
      expect(persist).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

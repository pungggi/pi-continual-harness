// Provenance trust boundary: agent-authored items are stamped server-side,
// rendered unverified, and lose injection-budget contention to trusted items.
// Absent provenance = trusted (owner) — the legacy rule, so no migration.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDeltas,
  exportDurable,
  getState,
  importDurableLayers,
  parseDurable,
  reconstruct,
  setActiveModelKey,
} from "../src/store.js";
import { selectForInjection } from "../src/select.js";
import { renderHarnessBlock, resetInjectionStats } from "../src/inject.js";
import { renderListReport } from "../src/list.js";
import { executeHarnessMutate } from "../src/tools.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { makeFakePi } from "./helpers.js";
import { DEFAULT_PROVENANCE, normalizeProvenance, type HarnessItem } from "../src/types.js";

function reset(): void {
  reconstruct([]);
  setActiveModelKey(undefined);
  resetInjectionStats();
}

/** A trusted (owner/legacy) item, bound to the test model. */
function trusted(over: Partial<HarnessItem> & Pick<HarnessItem, "id" | "content">): HarnessItem {
  const now = 10_000;
  return {
    kind: "prompt",
    evidence: "e",
    importance: 0.5,
    active: true,
    ownerModel: "test/main",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const MODEL = "test/main";

describe("stamping — authoredBy on applyDeltas", () => {
  beforeEach(reset);

  it("create stamps provenance: agent when authoredBy is agent", () => {
    const applied = applyDeltas(
      [{ op: "create", kind: "memory", content: "c", evidence: "e", ownerModel: MODEL }],
      vi.fn(),
      undefined,
      { authoredBy: "agent" },
    )[0]!;
    expect(applied.op === "create" ? applied.item.provenance : undefined).toBe("agent");
  });

  it("create without opts stays absent (trusted — the owner/import/legacy rule)", () => {
    const applied = applyDeltas(
      [{ op: "create", kind: "memory", content: "c", evidence: "e", ownerModel: MODEL }],
      vi.fn(),
    )[0]!;
    expect(applied.op === "create" ? applied.item.provenance : undefined).toBeUndefined();
  });

  it("update with content flips a trusted item to agent (last content write wins)", () => {
    applyDeltas(
      [{ op: "create", kind: "memory", content: "c", evidence: "e", ownerModel: MODEL }],
      vi.fn(),
    );
    const id = getState().items[0]!.id;
    applyDeltas([{ op: "update", id, content: "rewritten" }], vi.fn(), undefined, {
      authoredBy: "agent",
    });
    expect(getState().items[0]!.provenance).toBe("agent");
  });

  it("update WITHOUT content never flips (importance/active/scope only)", () => {
    applyDeltas(
      [{ op: "create", kind: "memory", content: "c", evidence: "e", ownerModel: MODEL }],
      vi.fn(),
    );
    const id = getState().items[0]!.id;
    applyDeltas([{ op: "update", id, importance: 0.9 }], vi.fn(), undefined, {
      authoredBy: "agent",
    });
    expect(getState().items[0]!.provenance).toBeUndefined();
  });

  it("the flip only loses trust: agent authoring cannot upgrade anything", () => {
    // An owner item rewritten by the agent flips TO agent; an agent item
    // rewritten by an owner surface (no authoredBy) stays agent — absence
    // never stamps, so only the import path (durable wins) can clear it.
    applyDeltas(
      [{ op: "create", kind: "memory", content: "c", evidence: "e", ownerModel: MODEL }],
      vi.fn(),
      undefined,
      { authoredBy: "agent" },
    );
    const id = getState().items[0]!.id;
    applyDeltas([{ op: "update", id, content: "owner rewrote by hand" }], vi.fn());
    expect(getState().items[0]!.provenance).toBe("agent");
  });
});

describe("tool boundary — provenance is not model-controllable", () => {
  beforeEach(reset);

  it("strips a smuggled provenance: 'owner'; the surface stamps 'agent' instead", async () => {
    setActiveModelKey(MODEL);
    const { pi } = makeFakePi([]);
    await executeHarnessMutate(pi, {
      deltas: [
        {
          op: "create",
          kind: "memory",
          content: "c",
          evidence: "e",
          provenance: "owner",
        } as never,
      ],
    });
    const item = getState().items[0]!;
    expect(item.provenance).toBe("agent"); // never the smuggled "owner"
    setActiveModelKey(undefined);
  });

  it("a content rewrite through the tool flips the item to agent", async () => {
    applyDeltas(
      [{ op: "create", kind: "memory", content: "owner text", evidence: "e", ownerModel: MODEL }],
      vi.fn(),
    );
    const id = getState().items[0]!.id;
    setActiveModelKey(MODEL);
    const { pi } = makeFakePi([]);
    await executeHarnessMutate(pi, { deltas: [{ op: "update", id, content: "agent rewrite" }] });
    expect(getState().items[0]!.provenance).toBe("agent");
    setActiveModelKey(undefined);
  });
});

describe("snapshot normalization — corrupt provenance degrades to trusted", () => {
  it("keeps a valid agent stamp, drops an unknown value", () => {
    const snapshot = {
      items: [
        trusted({ id: "h_a", content: "ok", provenance: "agent" }),
        trusted({ id: "h_b", content: "bogus", provenance: "evil" as never }),
        trusted({ id: "h_c", content: "plain" }),
      ],
    };
    reconstruct([{ type: "custom", customType: "harness-state", data: { state: snapshot } }]);
    const byId = new Map(getState().items.map((i) => [i.id, i]));
    expect(byId.get("h_a")!.provenance).toBe("agent");
    expect(byId.get("h_b")!.provenance).toBeUndefined();
    expect(byId.get("h_c")!.provenance).toBeUndefined();
  });
});

describe("selection priority — trusted items win budget contention", () => {
  beforeEach(reset);

  it("a trusted item takes the last slot over a higher-importance agent item", () => {
    const items = [
      trusted({ id: "h_agent", content: "agent note", importance: 0.9, provenance: "agent" }),
      trusted({ id: "h_trust", content: "owner note", importance: 0.4 }),
    ];
    // Budget fits exactly ONE item (overhead ≈ 121 + 6/item): contention
    // between the two trust classes for the single slot.
    const r = selectForInjection(items, MODEL, { maxPerKind: 99, maxTokens: 127 });
    expect(r.selected.map((i) => i.id)).toEqual(["h_trust"]);
    expect(r.omitted).toBe(1);
  });

  it("priority: false restores pure importance order (agent can win the slot)", () => {
    const items = [
      trusted({ id: "h_agent", content: "agent note", importance: 0.9, provenance: "agent" }),
      trusted({ id: "h_trust", content: "owner note", importance: 0.4 }),
    ];
    // Marker-inclusive cost: the agent item prices at 13 tokens (marker
    // text), the trusted one at 6. Budget fits exactly one.
    const r = selectForInjection(
      items,
      MODEL,
      { maxPerKind: 99, maxTokens: 136 },
      {
        label: true,
        priority: false,
      },
    );
    expect(r.selected.map((i) => i.id)).toEqual(["h_agent"]);
  });

  it("within a kind both classes surface in TRUST order when the budget allows", () => {
    const items = [
      trusted({ id: "h_agent", content: "agent note", importance: 0.9, provenance: "agent" }),
      trusted({ id: "h_trust", content: "owner note", importance: 0.4 }),
    ];
    const r = selectForInjection(items, MODEL, { maxPerKind: 99, maxTokens: 500 });
    expect(r.selected.map((i) => i.id)).toEqual(["h_trust", "h_agent"]);
  });

  it("all-trusted stores queue identically with and without the priority gate", () => {
    const items = [
      trusted({ id: "h_a", content: "one", importance: 0.8 }),
      trusted({ id: "h_b", content: "two", importance: 0.6 }),
      trusted({ id: "h_c", content: "three", importance: 0.4 }),
    ];
    const def = selectForInjection(items, MODEL, { maxPerKind: 99, maxTokens: 200 });
    const off = selectForInjection(
      items,
      MODEL,
      { maxPerKind: 99, maxTokens: 200 },
      {
        label: true,
        priority: false,
      },
    );
    expect(def.selected.map((i) => i.id)).toEqual(off.selected.map((i) => i.id));
  });

  it("the per-kind cap is trusted-first: 10 agent items cannot crowd out 1 owner item", () => {
    // Regression (review follow-up): the maxPerKind trim runs BEFORE the
    // budget pass, so 10 higher-importance agent items used to drop the
    // owner item at the cap stage — the very crowd-out the priority gate
    // promises cannot happen, one stage earlier than the token budget.
    const items = [
      trusted({ id: "h_owner", content: "owner note", importance: 0.4 }),
      ...Array.from({ length: 10 }, (_, k) =>
        trusted({
          id: `h_a${k}`,
          content: `agent ${k}`,
          importance: 0.9,
          provenance: "agent",
        }),
      ),
    ];
    const r = selectForInjection(items, MODEL, { maxPerKind: 10, maxTokens: 5000 });
    expect(r.selected.map((i) => i.id)).toContain("h_owner");
    expect(r.selected).toHaveLength(10); // 1 owner + 9 of the 10 agent items
    expect(r.omitted).toBe(1);
  });

  it("priority: false keeps the pure importance trim at the cap", () => {
    const items = [
      trusted({ id: "h_owner", content: "owner note", importance: 0.4 }),
      ...Array.from({ length: 10 }, (_, k) =>
        trusted({
          id: `h_a${k}`,
          content: `agent ${k}`,
          importance: 0.9,
          provenance: "agent",
        }),
      ),
    ];
    const r = selectForInjection(
      items,
      MODEL,
      { maxPerKind: 10, maxTokens: 5000 },
      { label: true, priority: false },
    );
    expect(r.selected.map((i) => i.id)).not.toContain("h_owner"); // top-10 by importance
    expect(r.omitted).toBe(1);
  });

  it("enabled: false ignores provenance entirely (legacy store order)", () => {
    const items = [
      trusted({ id: "h_agent", content: "agent note", importance: 0.9, provenance: "agent" }),
      trusted({ id: "h_trust", content: "owner note", importance: 0.4 }),
    ];
    const r = selectForInjection(items, MODEL, { enabled: false });
    expect(r.selected.map((i) => i.id)).toEqual(["h_agent", "h_trust"]);
  });
});

describe("renderHarnessBlock — unverified marker + intro line", () => {
  beforeEach(reset);

  function prime(items: HarnessItem[]): void {
    reconstruct([{ type: "custom", customType: "harness-state", data: { state: { items } } }]);
  }

  it("agent items carry the inline marker; trusted items do not", () => {
    prime([
      trusted({ id: "h_agent", content: "agent note", provenance: "agent" }),
      trusted({ id: "h_trust", content: "owner note" }),
    ]);
    const block = renderHarnessBlock(MODEL);
    expect(block).toContain("[h_agent] (unverified: agent-authored) agent note");
    expect(block).toContain("[h_trust] owner note");
    expect(block).not.toContain("[h_trust] (unverified");
  });

  it("the intro line renders only when an agent item is surfaced", () => {
    prime([trusted({ id: "h_trust", content: "owner note" })]);
    expect(renderHarnessBlock(MODEL)).not.toContain("unverified: agent-authored");

    prime([
      trusted({ id: "h_agent", content: "agent note", provenance: "agent" }),
      trusted({ id: "h_trust", content: "owner note" }),
    ]);
    const block = renderHarnessBlock(MODEL);
    expect(block).toContain(
      "Items marked (unverified: agent-authored) were written by the agent itself",
    );
  });

  it("label: false suppresses marker and intro entirely", () => {
    prime([trusted({ id: "h_agent", content: "agent note", provenance: "agent" })]);
    const block = renderHarnessBlock(MODEL, undefined, { label: false, priority: true });
    expect(block).not.toContain("(unverified");
    expect(block).toContain("[h_agent] agent note");
  });
});

describe("durable round-trip — provenance survives, absence clears to trusted", () => {
  beforeEach(reset);

  it("export writes the sub-line only for agent items; parseDurable inverts it", async () => {
    // One agent-authored create (stamped), one owner-surface create (absent).
    applyDeltas(
      [{ op: "create", kind: "prompt", content: "agent note", evidence: "e", ownerModel: MODEL }],
      vi.fn(),
      undefined,
      { authoredBy: "agent" },
    );
    applyDeltas(
      [{ op: "create", kind: "memory", content: "owner note", evidence: "e", ownerModel: MODEL }],
      vi.fn(),
    );
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-prov-"));
    const file = join(dir, "harness-state.md");
    try {
      await exportDurable(file);
      const body = readFileSync(file, "utf8");
      expect(body.match(/provenance: agent/g)).toHaveLength(1);
      const parsed = parseDurable(body);
      const byContent = new Map(parsed.map((p) => [p.content, p]));
      expect(byContent.get("agent note")?.provenance).toBe("agent");
      expect(byContent.get("owner note")?.provenance).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("import stamps a present line and CLEARS an absent one (durable wins)", async () => {
    applyDeltas(
      [
        { op: "create", kind: "prompt", content: "note", evidence: "e", ownerModel: MODEL },
        { op: "create", kind: "memory", content: "other", evidence: "e", ownerModel: MODEL },
      ],
      vi.fn(),
      undefined,
      { authoredBy: "agent" },
    );
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-prov2-"));
    const file = join(dir, "harness-state.md");
    try {
      await exportDurable(file);
      // Hand-edit: remove the prompt item's provenance sub-line (the
      // documented owner way to trust an item); the memory item keeps its
      // line. Both items still match by id, so re-import UPDATES them.
      const edited = readFileSync(file, "utf8").replace("  - provenance: agent\n", "");
      writeFileSync(file, edited, "utf8");
      const result = await importDurableLayers(
        [{ path: file, defaultScope: { scope: "global" } }],
        {},
        vi.fn(),
      );
      expect(result.created).toBe(0); // both items matched by id — updates
      const byContent = new Map(getState().items.map((i) => [i.content, i]));
      expect(byContent.get("note")!.provenance).toBeUndefined(); // line removed → trusted
      expect(byContent.get("other")!.provenance).toBe("agent"); // line kept → agent
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a legacy file without provenance lines imports as all-trusted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-prov3-"));
    const file = join(dir, "harness-state.md");
    try {
      writeFileSync(
        file,
        [
          "# Continual Harness State",
          "",
          "## Supplemental prompt notes",
          "",
          "- **[h_old]** (importance 0.70) legacy note",
          "  - evidence: old",
          "",
        ].join("\n"),
        "utf8",
      );
      await importDurableLayers([{ path: file, defaultScope: { scope: "global" } }], {}, vi.fn());
      const item = getState().items[0]!;
      expect(item.content).toBe("legacy note");
      expect(item.provenance).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("/harness list — provenance chips", () => {
  it("compact rows mark agent items (unverified); -f adds the full label", () => {
    const items = [
      trusted({ id: "h_agent", content: "agent note", provenance: "agent" }),
      trusted({ id: "h_trust", content: "owner note" }),
    ];
    const compact = renderListReport(items, { scope: "all", slug: "" });
    expect(compact).toMatch(/\[h_agent\].*\(unverified\).*agent note/);
    expect(compact).not.toMatch(/\[h_trust\].*\(unverified\)/);
    const full = renderListReport(items, { scope: "all", slug: "", full: true });
    expect(full).toContain("agent-authored (unverified)");
    expect(full).not.toMatch(/h_trust.*unverified/);
  });

  it("markUnverified: false (the provenance.label gate) hides both chips", () => {
    const items = [
      trusted({ id: "h_agent", content: "agent note", provenance: "agent" }),
      trusted({ id: "h_trust", content: "owner note" }),
    ];
    const compact = renderListReport(items, {
      scope: "all",
      slug: "",
      markUnverified: false,
    });
    expect(compact).not.toContain("(unverified)");
    expect(compact).toContain("agent note"); // the row itself stays
    const full = renderListReport(items, {
      scope: "all",
      slug: "",
      full: true,
      markUnverified: false,
    });
    expect(full).not.toContain("unverified");
    expect(full).toContain("agent note");
  });
});

describe("provenance config — normalizeProvenance + loadConfig merge", () => {
  it("defaults on; only explicit boolean false disables a gate", () => {
    expect(normalizeProvenance(undefined)).toEqual(DEFAULT_PROVENANCE);
    expect(normalizeProvenance({})).toEqual(DEFAULT_PROVENANCE);
    expect(normalizeProvenance({ label: false })).toEqual({ label: false, priority: true });
    expect(normalizeProvenance({ priority: false })).toEqual({ label: true, priority: false });
    expect(normalizeProvenance({ label: true, priority: true })).toEqual(DEFAULT_PROVENANCE);
    // Garbage types degrade to the defaults, never to a disabled boundary.
    expect(normalizeProvenance({ label: "no", priority: 0 })).toEqual(DEFAULT_PROVENANCE);
    expect(normalizeProvenance("bogus")).toEqual(DEFAULT_PROVENANCE);
    expect(normalizeProvenance(42)).toEqual(DEFAULT_PROVENANCE);
  });

  it("loadConfig resolves the provenance block through the same coercion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-provcfg-"));
    const file = join(dir, "harness.json");
    try {
      writeFileSync(file, JSON.stringify({ provenance: { label: false } }), "utf8");
      resetConfigCache();
      const cfg = await loadConfig(file);
      expect(cfg.provenance).toEqual({ label: false, priority: true });
    } finally {
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Tests for the opt-in outcome loop (Phase 5 / limit B-phase-2).
//
// findReferences() is pure and tested directly. The turn_end handler is tested
// against a minimal fake pi (the shared makeFakePi in integration.test.ts is
// not exported, and outcome must be the SOLE turn_end handler on its fake — it
// is registered before auto-refine in production, so the integration fake would
// mask it).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findReferences, registerOutcome, resetOutcome } from "../src/outcome.js";
import { getState, reconstruct, STATE_ENTRY } from "../src/store.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event?: unknown, ctx?: unknown) => unknown | Promise<unknown>;

interface MiniCtx {
  ui: { notify: (msg: string, level: string) => void; setStatus: () => void };
  sessionManager: { getBranch: () => unknown[] };
  model: { provider: string; id: string };
}

function makeMini(branch: unknown[]) {
  const handlers = new Map<string, Handler>();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const notifications: Array<{ msg: string; level: string }> = [];
  const pi = {
    on: (ev: string, h: Handler) => handlers.set(ev, h),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: () => {},
  };
  const ctx = (): MiniCtx => ({
    ui: { notify: (msg, level) => notifications.push({ msg, level }), setStatus: () => {} },
    sessionManager: { getBranch: () => branch },
    model: { provider: "test", id: "main" },
  });
  return { pi: pi as unknown as ExtensionAPI, handlers, entries, notifications, ctx };
}

function seedItem(id: string, importance: number): void {
  reconstruct([
    {
      type: "custom",
      customType: STATE_ENTRY,
      data: {
        state: {
          items: [
            { id, kind: "memory", content: "fact", evidence: "e", importance, active: true, ownerModel: "test/main", createdAt: 1, updatedAt: 1 },
          ],
        },
      },
    },
  ]);
}

function asst(text: string): unknown {
  return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
}

describe("findReferences", () => {
  it("extracts cited ids that are known, ignoring unknown ones", () => {
    const ids = new Set(["h_abc", "h_def"]);
    expect(findReferences("see [h_abc] and [h_xyz]", ids)).toEqual(["h_abc"]);
  });

  it("dedupes repeated citations of the same item", () => {
    const ids = new Set(["h_abc"]);
    expect(findReferences("[h_abc] then [h_abc] again [h_abc]", ids)).toEqual(["h_abc"]);
  });

  it("matches case-insensitively and normalizes to lowercase", () => {
    const ids = new Set(["h_abc"]);
    expect(findReferences("using [H_ABC] now", ids)).toEqual(["h_abc"]);
  });

  it("returns nothing for empty text or when no ids are known", () => {
    expect(findReferences("", new Set(["h_abc"]))).toEqual([]);
    expect(findReferences("[h_abc] [h_def]", new Set())).toEqual([]);
  });
});

describe("registerOutcome handler", () => {
  beforeEach(() => {
    resetOutcome();
    resetConfigCache();
  });

  let dir: string | undefined;
  afterEach(() => {
    resetOutcome();
    resetConfigCache();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function setConfig(enabled: boolean, bump = 0.05): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), "pi-ch-outcome-"));
    const cfgFile = join(dir, "harness.json");
    writeFileSync(cfgFile, JSON.stringify({ outcomeImportance: { enabled, bump } }));
    await loadConfig(cfgFile); // populate the in-process cache (deterministic)
  }

  it("seeds on the first turn_end (no bump), then bumps referenced items on the next", async () => {
    await setConfig(true, 0.05);
    seedItem("h_abc", 0.5);
    const branch = [asst("Using [h_abc] to guide the fix.")];
    const { pi, handlers, ctx, notifications, entries } = makeMini(branch);
    registerOutcome(pi);

    // turn 0: seeds the cursor, no bump, no notify, no persist
    await handlers.get("turn_end")!({ turnIndex: 0 }, ctx());
    expect(getState().items[0]!.importance).toBeCloseTo(0.5);
    expect(notifications).toHaveLength(0);
    expect(entries).toHaveLength(0);

    // turn 1: a NEW assistant message cites the item → bump + persist + notify
    branch.push(asst("again referencing [h_abc] here"));
    await handlers.get("turn_end")!({ turnIndex: 1 }, ctx());
    expect(getState().items[0]!.importance).toBeCloseTo(0.55);
    expect(entries.some((e) => e.customType === STATE_ENTRY)).toBe(true);
    expect(notifications.some((n) => /referenced item/.test(n.msg))).toBe(true);
  });

  it("is inert when outcomeImportance is disabled (the default)", async () => {
    await setConfig(false);
    seedItem("h_abc", 0.5);
    const branch = [asst("Using [h_abc]"), asst("again [h_abc]")];
    const { pi, handlers, ctx, notifications, entries } = makeMini(branch);
    registerOutcome(pi);

    await handlers.get("turn_end")!({ turnIndex: 0 }, ctx());
    await handlers.get("turn_end")!({ turnIndex: 1 }, ctx());
    expect(getState().items[0]!.importance).toBeCloseTo(0.5);
    expect(notifications).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("ignores citations of items that are not active", async () => {
    await setConfig(true, 0.05);
    // item exists but is inactive → not in the active-id set
    reconstruct([
      {
        type: "custom",
        customType: STATE_ENTRY,
        data: {
          state: {
            items: [
              { id: "h_abc", kind: "memory", content: "fact", evidence: "e", importance: 0.5, active: false, createdAt: 1, updatedAt: 1 },
            ],
          },
        },
      },
    ]);
    const branch = [asst("seed"), asst("citing [h_abc]")];
    const { pi, handlers, ctx, notifications } = makeMini(branch);
    registerOutcome(pi);
    await handlers.get("turn_end")!({ turnIndex: 0 }, ctx());
    await handlers.get("turn_end")!({ turnIndex: 1 }, ctx());
    expect(getState().items[0]!.importance).toBeCloseTo(0.5);
    expect(notifications).toHaveLength(0);
  });

  it("only bumps items owned by the active model (other models are ignored)", async () => {
    await setConfig(true, 0.05);
    reconstruct([
      {
        type: "custom",
        customType: STATE_ENTRY,
        data: {
          state: {
            items: [
              { id: "h_mine", kind: "memory", content: "mine", evidence: "e", importance: 0.5, active: true, ownerModel: "test/main", createdAt: 1, updatedAt: 1 },
              { id: "h_other", kind: "memory", content: "other", evidence: "e", importance: 0.5, active: true, ownerModel: "other/model", createdAt: 1, updatedAt: 1 },
            ],
          },
        },
      },
    ]);
    const branch = [asst("seed")];
    const { pi, handlers, ctx } = makeMini(branch);
    registerOutcome(pi);
    await handlers.get("turn_end")!({ turnIndex: 0 }, ctx());
    branch.push(asst("citing [h_mine] and [h_other]"));
    await handlers.get("turn_end")!({ turnIndex: 1 }, ctx());
    const byId = new Map(getState().items.map((i) => [i.id, i.importance]));
    expect(byId.get("h_mine")).toBeCloseTo(0.55); // active model → bumped
    expect(byId.get("h_other")).toBeCloseTo(0.5); // different model → untouched
  });
});

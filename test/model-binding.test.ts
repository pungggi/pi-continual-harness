// Model-binding integration tests. These pin the cross-cutting behaviour the
// unit tests can't: strict per-model isolation at injection, server-side owner
// stamping in the model-facing tools, model-scoped listing, and the
// before_agent_start adopt/cache/render bridge.
//
// Design (see src/inject.ts): the tools receive NO ctx, so before_agent_start
// (which always fires first in a turn with ctx.model) caches the active model
// key; harness_mutate stamps creates from that cache, harness_list filters on
// it, and renderHarnessBlock injects only items bound to it.

import { describe, it, expect, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerInjection, renderHarnessBlock } from "../src/inject.js";
import { registerTools } from "../src/tools.js";
import { applyDeltas, getState, reconstruct, setActiveModelKey } from "../src/store.js";

type Handler = (event?: unknown, ctx?: unknown) => unknown | Promise<unknown>;

interface ExecResult {
  content: Array<{ type: string; text: string }>;
  details: { count: number; items: Array<{ ownerModel: string; content: string }> };
}

function fakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler>;
  tools: Map<string, Record<string, unknown>>;
  entries: Array<{ type: string; customType: string; data: unknown }>;
} {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Record<string, unknown>>();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const pi = {
    on: (ev: string, h: Handler) => handlers.set(ev, h),
    registerTool: (def: Record<string, unknown>) => tools.set(def.name as string, def),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, tools, entries };
}

function ctxWithModel(provider: string, id: string): { model: { provider: string; id: string } } {
  return { model: { provider, id } };
}

function reset(): void {
  reconstruct([]);
  setActiveModelKey(undefined);
}

describe("renderHarnessBlock — strict per-model isolation", () => {
  beforeEach(reset);

  it("shows only the active model's items; a new model id sees a blank block", () => {
    applyDeltas(
      [
        { op: "create", kind: "prompt", content: "sonnet note", evidence: "e", ownerModel: "anthropic/sonnet" },
        { op: "create", kind: "prompt", content: "gemini note", evidence: "e", ownerModel: "google/gemini" },
      ],
      () => {},
    );
    const block = renderHarnessBlock("anthropic/sonnet");
    expect(block).toContain("sonnet note");
    expect(block).not.toContain("gemini note");
    // a brand-new model id → blank slate (the core isolation guarantee)
    expect(renderHarnessBlock("openai/gpt-5")).toBe("");
  });

  it("renders nothing when the model is unknown (undefined)", () => {
    applyDeltas([{ op: "create", kind: "prompt", content: "x", evidence: "e", ownerModel: "a/b" }], () => {});
    expect(renderHarnessBlock(undefined)).toBe("");
  });
});

describe("before_agent_start — adopt + cache + isolate", () => {
  beforeEach(reset);

  it("adopts orphan items to the active model, and injects only that model", async () => {
    // legacy orphan (no owner) + an item owned by a different model
    applyDeltas(
      [
        { op: "create", kind: "prompt", content: "legacy orphan", evidence: "e" },
        { op: "create", kind: "prompt", content: "other model", evidence: "e", ownerModel: "google/gemini" },
      ],
      () => {},
    );
    const { pi, handlers, entries } = fakePi();
    registerInjection(pi);

    const ret = (await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, ctxWithModel("anthropic", "sonnet"))) as {
      systemPrompt?: string;
    };
    const byContent = new Map(getState().items.map((i) => [i.content, i.ownerModel]));
    // orphan adopted to the active model
    expect(byContent.get("legacy orphan")).toBe("anthropic/sonnet");
    // other-model item is NOT adopted and NOT injected
    expect(byContent.get("other model")).toBe("google/gemini");
    expect(ret?.systemPrompt).toContain("legacy orphan");
    expect(ret?.systemPrompt).not.toContain("other model");
    // adoption persisted a harness-state entry (branchable via /tree)
    expect(entries.some((e) => e.customType === "harness-state")).toBe(true);
  });

  it("does not persist when there is nothing to adopt", async () => {
    applyDeltas(
      [{ op: "create", kind: "prompt", content: "owned", evidence: "e", ownerModel: "anthropic/sonnet" }],
      () => {},
    );
    const { pi, handlers, entries } = fakePi();
    registerInjection(pi);
    await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, ctxWithModel("anthropic", "sonnet"));
    expect(entries).toHaveLength(0);
  });

  it("re-scopes on model switch: model B's turn injects none of model A's items", async () => {
    applyDeltas(
      [{ op: "create", kind: "prompt", content: "A only", evidence: "e", ownerModel: "anthropic/sonnet" }],
      () => {},
    );
    const { pi, handlers } = fakePi();
    registerInjection(pi);

    // model A's turn → its item is injected
    const a = (await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, ctxWithModel("anthropic", "sonnet"))) as {
      systemPrompt?: string;
    };
    expect(a.systemPrompt).toContain("A only");

    // switch to model B → blank slate (the headline isolation guarantee)
    const b = await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, ctxWithModel("google", "gemini"));
    expect(b).toBeUndefined();
  });
});

describe("harness_mutate — stamps create with the active model", () => {
  beforeEach(reset);

  it("binds new items to the cached active model key", async () => {
    setActiveModelKey("anthropic/sonnet");
    const { pi, tools } = fakePi();
    registerTools(pi);
    const mutate = tools.get("harness_mutate")!;
    await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(undefined, {
      deltas: [{ op: "create", kind: "memory", content: "fact", evidence: "e" }],
    });
    expect(getState().items[0]!.ownerModel).toBe("anthropic/sonnet");
  });

  it("leaves items as orphans when no active model is known (adopted next turn)", async () => {
    const { pi, tools } = fakePi();
    registerTools(pi);
    const mutate = tools.get("harness_mutate")!;
    await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(undefined, {
      deltas: [{ op: "create", kind: "memory", content: "fact", evidence: "e" }],
    });
    expect(getState().items[0]!.ownerModel).toBe("");
  });
});

describe("harness_mutate — isolation enforces update/delete on the active model", () => {
  beforeEach(reset);

  it("rejects an update targeting another model's item (atomic rollback)", async () => {
    applyDeltas(
      [{ op: "create", kind: "memory", content: "theirs", evidence: "e", ownerModel: "google/gemini" }],
      () => {},
    );
    const id = getState().items[0]!.id;
    setActiveModelKey("anthropic/sonnet");
    const { pi, tools } = fakePi();
    registerTools(pi);
    const mutate = tools.get("harness_mutate")!;
    await expect(
      (mutate.execute as (...a: unknown[]) => Promise<unknown>)(undefined, {
        deltas: [{ op: "update", id, content: "hijacked" }],
      }),
    ).rejects.toThrow(/owned by/);
    expect(getState().items[0]!.content).toBe("theirs"); // unchanged (rolled back)
  });

  it("rejects a delete targeting another model's item", async () => {
    applyDeltas(
      [{ op: "create", kind: "memory", content: "theirs", evidence: "e", ownerModel: "google/gemini" }],
      () => {},
    );
    const id = getState().items[0]!.id;
    setActiveModelKey("anthropic/sonnet");
    const { pi, tools } = fakePi();
    registerTools(pi);
    const mutate = tools.get("harness_mutate")!;
    await expect(
      (mutate.execute as (...a: unknown[]) => Promise<unknown>)(undefined, {
        deltas: [{ op: "delete", id, reason: "cross-model" }],
      }),
    ).rejects.toThrow(/owned by/);
    expect(getState().items).toHaveLength(1); // not deleted
  });

  it("allows update of the active model's own items", async () => {
    applyDeltas(
      [{ op: "create", kind: "memory", content: "mine", evidence: "e", ownerModel: "anthropic/sonnet" }],
      () => {},
    );
    const id = getState().items[0]!.id;
    setActiveModelKey("anthropic/sonnet");
    const { pi, tools } = fakePi();
    registerTools(pi);
    const mutate = tools.get("harness_mutate")!;
    await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(undefined, {
      deltas: [{ op: "update", id, content: "updated" }],
    });
    expect(getState().items[0]!.content).toBe("updated");
  });
});

describe("harness_list — model filtering", () => {
  beforeEach(reset);

  async function list(tool: Record<string, unknown>, params: Record<string, unknown>): Promise<string> {
    const res = (await (tool.execute as (...a: unknown[]) => Promise<unknown>)(undefined, params)) as ExecResult;
    return res.content[0]!.text;
  }

  it("defaults to the active model; '*' returns all; an explicit id filters", async () => {
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "mine", evidence: "e", ownerModel: "anthropic/sonnet" },
        { op: "create", kind: "memory", content: "theirs", evidence: "e", ownerModel: "google/gemini" },
      ],
      () => {},
    );
    setActiveModelKey("anthropic/sonnet");
    const { pi, tools } = fakePi();
    registerTools(pi);
    const listTool = tools.get("harness_list")!;

    // default = active model only
    let text = await list(listTool, {});
    expect(text).toContain("mine");
    expect(text).not.toContain("theirs");

    // '*' = every model
    text = await list(listTool, { model: "*" });
    expect(text).toContain("mine");
    expect(text).toContain("theirs");

    // explicit other model
    text = await list(listTool, { model: "google/gemini" });
    expect(text).not.toContain("mine");
    expect(text).toContain("theirs");
  });
});

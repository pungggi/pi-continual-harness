// Deliverable A: the one-shot `complete` injection + modelCall telemetry.
//
// These pin the runtime behavior the type system can't:
//  (1) runRefine builds a `complete` closure from ctx.modelRegistry + ctx.model
//      and threads it into ProposeInput; a proposer that calls it gets back the
//      assistant text + token usage.
//  (2) telemetry a proposer returns in ProposeResult.modelCall lands in the
//      harness-refinement audit entry (so hidden model spend stays visible).
//  (3) when no model is resolvable, `complete` is undefined and runRefine does
//      NOT throw — a model proposer can no-op + record an audited failure.
//  (4) resolveModel honors "provider/id", bare ids, and falls back to ctx.model.

import { describe, it, expect, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { runRefine } from "../src/refine.js";
import { registerProposer } from "../src/proposer.js";
import { applyDeltas, getState, reconstruct } from "../src/store.js";

const REFINE_AUDIT = "harness-refinement";

interface FakeRegistry {
  complete: (model: unknown, context: unknown, opts: unknown) => Promise<unknown>;
  getAvailable: () => unknown[];
  getAll: () => unknown[];
  find: (provider: string, id: string) => unknown | undefined;
}

interface CtxOver {
  model?: unknown;
  registry?: FakeRegistry;
  branch?: unknown[];
}

function makePi(): { pi: ExtensionAPI; entries: Array<{ customType: string; data: unknown }> } {
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    sendUserMessage: () => {},
  };
  return { pi: pi as unknown as ExtensionAPI, entries };
}

function makeCtx(over: CtxOver): ExtensionCommandContext {
  return {
    ui: { setStatus: () => {}, notify: () => {} },
    sessionManager: { getBranch: () => over.branch ?? [] },
    cwd: "/tmp",
    signal: undefined,
    model: over.model,
    modelRegistry: over.registry,
  } as unknown as ExtensionCommandContext;
}

function reset(): void {
  reconstruct([]);
}

describe("Deliverable A: complete injection", () => {
  beforeEach(reset);

  it("threads a complete closure into ProposeInput and extracts text + usage", async () => {
    const model = { id: "test-mini", provider: "test" } as unknown as Model<Api>;
    const calls: Array<{ model: unknown; context: unknown; opts: unknown }> = [];
    const registry: FakeRegistry = {
      complete: async (m, context, opts) => {
        calls.push({ model: m, context, opts });
        return {
          content: [{ type: "text", text: "[]" }],
          usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        };
      },
      getAvailable: () => [model],
      getAll: () => [model],
      find: () => undefined,
    };

    let receivedComplete: ((p: string) => Promise<unknown>) | undefined;
    let completeResult:
      | { text: string; model?: string; usage?: { input: number; output: number } }
      | undefined;
    registerProposer({
      name: "a-thread-complete",
      async propose(input) {
        receivedComplete = input.complete;
        if (!input.complete) return { deltas: [] };
        completeResult = await input.complete("propose deltas", { modelId: "test-mini" });
        const res = completeResult;
        return {
          deltas: [
            {
              delta: {
                op: "create",
                kind: "memory",
                content: "from model",
                evidence: "model said so",
              },
              rationale: "model proposed",
            },
          ],
          modelCall: {
            model: "test-mini",
            ...(res.usage ? { inputTokens: res.usage.input, outputTokens: res.usage.output } : {}),
            ok: true,
          },
        };
      },
    });

    const { pi, entries } = makePi();
    await runRefine(pi, makeCtx({ model, registry }), { proposer: "a-thread-complete" });

    // (1) complete was injected + invoked; the closure built a user message and
    // extracted text + usage from the assistant response.
    expect(typeof receivedComplete).toBe("function");
    expect(calls).toHaveLength(1);
    const sent = (calls[0]!.context as { messages: Array<{ role: string; content: string }> })
      .messages[0]!;
    expect(sent.role).toBe("user");
    expect(sent.content).toBe("propose deltas");
    // token budget honored
    expect((calls[0]!.opts as { maxTokens?: number }).maxTokens).toBeUndefined();

    // the proposed delta was applied through the normal audited path
    expect(getState().items.map((i) => i.content)).toContain("from model");

    // (2) telemetry landed in the audit entry
    const audit = entries.find((e) => e.customType === REFINE_AUDIT)!;
    expect((audit.data as { proposer: string }).proposer).toBe("a-thread-complete");
    expect((audit.data as { applied: number }).applied).toBe(1);
    expect((audit.data as { modelCall: unknown }).modelCall).toEqual({
      model: "test-mini",
      inputTokens: 12,
      outputTokens: 3,
      ok: true,
    });

    // (4) the complete closure surfaces the resolved model label for telemetry
    expect(completeResult?.model).toBe("test/test-mini");
  });

  it("forwards maxOutputTokens -> maxTokens on the provider call", async () => {
    const model = { id: "m", provider: "test" } as unknown as Model<Api>;
    const optsSeen: unknown[] = [];
    const registry: FakeRegistry = {
      complete: async (_m, _c, opts) => {
        optsSeen.push(opts);
        return { content: [{ type: "text", text: "[]" }], usage: { input: 1, output: 1 } };
      },
      getAvailable: () => [model],
      getAll: () => [model],
      find: () => undefined,
    };
    registerProposer({
      name: "a-maxtokens",
      async propose(input) {
        if (!input.complete) return { deltas: [] };
        await input.complete("p", { maxOutputTokens: 2048 });
        return { deltas: [] };
      },
    });
    const { pi } = makePi();
    await runRefine(pi, makeCtx({ model, registry }), { proposer: "a-maxtokens" });
    expect((optsSeen[0] as { maxTokens: number }).maxTokens).toBe(2048);
  });

  it("complete is undefined when no model is resolvable; runRefine does not throw", async () => {
    const registry: FakeRegistry = {
      complete: async () => {
        throw new Error("must not be called");
      },
      getAvailable: () => [],
      getAll: () => [],
      find: () => undefined,
    };
    let seenComplete: unknown = "sentinel";
    registerProposer({
      name: "a-no-model",
      async propose(input) {
        seenComplete = input.complete;
        return { deltas: [], modelCall: { ok: false, error: "no model" } };
      },
    });
    const { pi, entries } = makePi();
    // ctx.model undefined + empty registry → buildComplete returns undefined
    await expect(
      runRefine(pi, makeCtx({ model: undefined, registry }), { proposer: "a-no-model" }),
    ).resolves.toBeDefined();
    expect(seenComplete).toBeUndefined();

    const audit = entries.find((e) => e.customType === REFINE_AUDIT)!;
    expect((audit.data as { applied: number }).applied).toBe(0);
    // the proposer's own failure telemetry is still recorded
    expect((audit.data as { modelCall: { ok: boolean; error: string } }).modelCall).toEqual({
      ok: false,
      error: "no model",
    });
  });

  it("resolveModel: 'provider/id' lookup, bare id, and fallback to the active model", async () => {
    const active = { id: "active", provider: "p0" } as unknown as Model<Api>;
    const other = { id: "other-mini", provider: "p1" } as unknown as Model<Api>;
    const seenModels: unknown[] = [];
    const registry: FakeRegistry = {
      complete: async (m) => {
        seenModels.push(m);
        return { content: [{ type: "text", text: "[]" }], usage: { input: 1, output: 1 } };
      },
      getAvailable: () => [other],
      getAll: () => [other],
      find: (_p, id) => (id === "byref" ? { id: "byref", provider: "p1" } : undefined),
    };

    // case 1: explicit "provider/id" via find()
    registerProposer({
      name: "a-resolve-ref",
      async propose(input) {
        if (!input.complete) return { deltas: [] };
        await input.complete("p", { modelId: "p1/byref" });
        return { deltas: [] };
      },
    });
    const { pi } = makePi();
    await runRefine(pi, makeCtx({ model: active, registry }), { proposer: "a-resolve-ref" });
    expect(seenModelat(seenModels, 0).id).toBe("byref");

    // case 2: bare id matches getAvailable()
    seenModels.length = 0;
    registerProposer({
      name: "a-resolve-bare",
      async propose(input) {
        if (!input.complete) return { deltas: [] };
        await input.complete("p", { modelId: "other-mini" });
        return { deltas: [] };
      },
    });
    await runRefine(pi, makeCtx({ model: active, registry }), { proposer: "a-resolve-bare" });
    expect(seenModelat(seenModels, 0).id).toBe("other-mini");

    // case 3: no modelId -> falls back to the active session model
    seenModels.length = 0;
    registerProposer({
      name: "a-resolve-active",
      async propose(input) {
        if (!input.complete) return { deltas: [] };
        await input.complete("p");
        return { deltas: [] };
      },
    });
    await runRefine(pi, makeCtx({ model: active, registry }), { proposer: "a-resolve-active" });
    expect(seenModelat(seenModels, 0).id).toBe("active");
  });
});

describe("Deliverable A: apply failure safety", () => {
  beforeEach(reset);

  it("a proposer batch that throws mid-apply is an audited no-op, not a crash", async () => {
    // Seed a real item, then return a batch that conflicts within itself:
    // [delete h_x, update h_x] — applyDeltas deletes h_x then throws on the
    // update (id gone). Without the try/catch this crashes /refine.
    const seeded = applyDeltas(
      [{ op: "create", kind: "memory", content: "seed", evidence: "e", importance: 0.8 }],
      () => {},
    );
    const id = (seeded[0] as { item: { id: string } }).item.id;
    expect(getState().items).toHaveLength(1);

    registerProposer({
      name: "a-conflicting-batch",
      async propose() {
        return {
          deltas: [
            { delta: { op: "delete", id, reason: "gone" }, rationale: "del" },
            { delta: { op: "update", id, content: "changed" }, rationale: "upd" },
          ],
        };
      },
    });

    const { pi, entries } = makePi();
    // No model needed: the proposer returns deltas directly (complete unused).
    await expect(
      runRefine(pi, makeCtx({}), { proposer: "a-conflicting-batch" }),
    ).resolves.toBeDefined();

    // State was rolled back: the item survives, nothing applied.
    expect(getState().items).toHaveLength(1);
    expect(getState().items[0]!.id).toBe(id);
    const audit = entries.find((e) => e.customType === REFINE_AUDIT)!;
    expect((audit.data as { applied: number }).applied).toBe(0);
    expect((audit.data as { applyError: string }).applyError).toMatch(/no item with id/);
  });
});

// helper so noUncheckedIndexedAccess doesn't litter the asserts
function seenModelat(arr: unknown[], i: number): { id: string } {
  return arr[i] as { id: string };
}

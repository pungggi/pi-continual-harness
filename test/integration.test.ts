// Integration tests with a stubbed ExtensionAPI.
//
// These validate the three runtime assumptions tsc could not:
//  (1) getBranch() entry shape — /refine evidence extraction reads
//      message.content[].text.
//  (2) the /refine command handler actually calls sendUserMessage (whether pi
//      then fires a turn is a pi-runtime concern, not ours).
//  (3) session_start reconstruction finds custom harness-state entries in
//      getBranch() and restores from the last snapshot.
//
// Plus the end-to-end behaviour: before_agent_start injection, and the
// harness_list / harness_mutate tools round-tripping through appendEntry.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import continualHarness from "../src/index.js";
import { applyDeltas, getState, reconstruct, STATE_ENTRY } from "../src/store.js";
import type { Delta } from "../src/types.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { resetAutoRefine } from "../src/auto-refine.js";
import { resetOutcome } from "../src/outcome.js";
import { runRefine } from "../src/refine.js";
import { registerProposer } from "../src/proposer.js";

type Handler = (event?: unknown, ctx?: unknown) => unknown | Promise<unknown>;

interface FakeCtx {
  ui: {
    notify: (msg: string, level: string) => void;
    setStatus: (key: string, text: string | undefined) => void;
  };
  sessionManager: {
    getBranch: () => unknown[];
  };
  cwd: string;
  model: { provider: string; id: string };
}

function makeFakePi(branch: unknown[]) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Record<string, unknown>>();
  const commands = new Map<string, { description?: string; handler: Handler }>();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const sentMessages: string[] = [];
  const notifications: Array<{ msg: string; level: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];

  const pi = {
    on: (ev: string, h: Handler) => {
      handlers.set(ev, h);
    },
    registerTool: (def: Record<string, unknown>) => {
      tools.set(def.name as string, def);
    },
    registerCommand: (name: string, opts: { description?: string; handler: Handler }) => {
      commands.set(name, opts);
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage: (msg: string) => {
      sentMessages.push(msg);
    },
  };

  const ctx = (): FakeCtx => ({
    ui: {
      notify: (msg, level) => notifications.push({ msg, level }),
      setStatus: (key, text) => statuses.push({ key, text }),
    },
    sessionManager: { getBranch: () => branch },
    cwd: "/tmp",
    model: { provider: "test", id: "main" },
  });

  return { pi: pi as unknown as ExtensionAPI, handlers, tools, commands, entries, sentMessages, notifications, statuses, ctx };
}

function reset(): void {
  reconstruct([]);
}

describe("registration", () => {
  beforeEach(reset);

  it("registers session_start, before_agent_start, turn_end, the two tools, and /refine", () => {
    const { pi, handlers, tools, commands } = makeFakePi([]);
    continualHarness(pi);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("turn_end")).toBe(true);
    expect(tools.has("harness_list")).toBe(true);
    expect(tools.has("harness_mutate")).toBe(true);
    expect(commands.has("refine")).toBe(true);
    expect(commands.has("harness")).toBe(true);
  });
});

// Assumption (3): custom harness-state entries appear in getBranch() and
// session_start restores from the last snapshot.
describe("session_start reconstruction", () => {
  beforeEach(reset);

  it("restores items from the last harness-state snapshot on the branch", async () => {
    const branch = [
      {
        type: "custom",
        customType: STATE_ENTRY,
        data: {
          state: {
            items: [
              { id: "h_1", kind: "memory", content: "restored fact", evidence: "e", importance: 0.6, active: true, createdAt: 1, updatedAt: 1 },
            ],
          },
        },
      },
    ];
    const { pi, handlers, ctx, notifications } = makeFakePi(branch);
    continualHarness(pi);

    await handlers.get("session_start")!({ reason: "startup" }, ctx());

    expect(getState().items.map((i) => i.id)).toEqual(["h_1"]);
    expect(notifications.some((n) => /1 item\(s\) restored/.test(n.msg))).toBe(true);
  });

  it("stays empty and stays quiet when the branch has no harness-state entry", async () => {
    const { pi, handlers, ctx, notifications } = makeFakePi([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ]);
    continualHarness(pi);
    await handlers.get("session_start")!({ reason: "startup" }, ctx());
    expect(getState().items).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });
});

describe("before_agent_start injection", () => {
  beforeEach(reset);

  it("appends a structured block to the base prompt and never replaces it", async () => {
    const branch = [
      {
        type: "custom",
        customType: STATE_ENTRY,
        data: {
          state: {
            items: [
              { id: "h_1", kind: "prompt", content: "Always cite evidence", evidence: "e", importance: 0.8, active: true, createdAt: 1, updatedAt: 1 },
            ],
          },
        },
      },
    ];
    const { pi, handlers, ctx } = makeFakePi(branch);
    continualHarness(pi);
    await handlers.get("session_start")!({ reason: "startup" }, ctx());

    const ret = (await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, ctx())) as {
      systemPrompt?: string;
    };
    expect(ret?.systemPrompt).toBeDefined();
    expect(ret!.systemPrompt!.startsWith("BASE")).toBe(true);
    expect(ret!.systemPrompt).toContain("Continual Harness state");
    expect(ret!.systemPrompt).toContain("Always cite evidence");
  });

  it("returns undefined (no prompt change) when there is no active state", async () => {
    const { pi, handlers, ctx } = makeFakePi([]);
    continualHarness(pi);
    const ret = await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, ctx());
    expect(ret).toBeUndefined();
  });
});

// Phase 7: injection selection is ON BY DEFAULT. These drive the real
// before_agent_start handler (which reads config + renders) to pin the default
// behaviour end-to-end: importance-ordered, capped, with a transparency footer;
// and that `injection.enabled: false` restores the legacy "all, in order" mode.
describe("before_agent_start injection selection (default on, opt-out)", () => {
  beforeEach(() => {
    reset();
    resetConfigCache();
  });

  async function blockWith(items: Delta[], injectionCfg?: object): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-inject-"));
    const cfgFile = join(dir, "harness.json");
    const cfg = injectionCfg ? { injection: injectionCfg } : {};
    writeFileSync(cfgFile, JSON.stringify(cfg));
    await loadConfig(cfgFile); // populate the in-process cache the handler reads
    try {
      const { pi, handlers, ctx } = makeFakePi([]);
      continualHarness(pi);
      applyDeltas(items, () => {});
      const ret = (await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, ctx())) as {
        systemPrompt?: string;
      };
      return ret?.systemPrompt ?? "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
      resetConfigCache();
    }
  }

  it("default policy orders injected items by importance (highest first)", async () => {
    // Inserted low-first; default selection must surface high before low.
    const block = await blockWith([
      { op: "create", kind: "prompt", content: "low-imp", evidence: "e", importance: 0.2, ownerModel: "test/main" },
      { op: "create", kind: "prompt", content: "high-imp", evidence: "e", importance: 0.9, ownerModel: "test/main" },
    ]);
    expect(block).toContain("high-imp");
    expect(block).toContain("low-imp");
    expect(block.indexOf("high-imp")).toBeLessThan(block.indexOf("low-imp"));
  });

  it("maxPerKind trims the lowest-importance items and appends a transparency footer", async () => {
    const block = await blockWith(
      [
        { op: "create", kind: "prompt", content: "kept", evidence: "e", importance: 0.9, ownerModel: "test/main" },
        { op: "create", kind: "prompt", content: "dropped", evidence: "e", importance: 0.2, ownerModel: "test/main" },
      ],
      { maxPerKind: 1 },
    );
    expect(block).toContain("kept");
    expect(block).not.toContain("dropped");
    expect(block).toMatch(/1 item\(s\) not shown/);
  });

  it("injection.enabled: false restores legacy mode (all items, store order)", async () => {
    // Inserted low-first; legacy must preserve insertion order (low before high).
    const block = await blockWith(
      [
        { op: "create", kind: "prompt", content: "low-imp", evidence: "e", importance: 0.2, ownerModel: "test/main" },
        { op: "create", kind: "prompt", content: "high-imp", evidence: "e", importance: 0.9, ownerModel: "test/main" },
      ],
      { enabled: false },
    );
    expect(block).toContain("low-imp");
    expect(block).toContain("high-imp");
    expect(block.indexOf("low-imp")).toBeLessThan(block.indexOf("high-imp"));
    expect(block).not.toMatch(/not shown/); // no footer in legacy mode
  });
});

// Assumptions (1) + (2): /refine reads message.content[].text from the branch
// and calls sendUserMessage with a steering prompt containing that evidence.
describe("/refine command", () => {
  beforeEach(reset);

  it("gathers trajectory evidence and steers the agent via sendUserMessage", async () => {
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Fix the login bug in auth.ts" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Looking into auth.ts now" }] } },
    ];
    const { pi, commands, ctx, sentMessages, entries } = makeFakePi(branch);
    continualHarness(pi);

    await commands.get("refine")!.handler("25", ctx());

    // (1) evidence text survived into the steering prompt
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("Fix the login bug in auth.ts");
    expect(sentMessages[0]).toContain("harness_mutate");

    // audit entry recorded
    expect(entries.some((e) => e.customType === "harness-refinement")).toBe(true);
    const audit = entries.find((e) => e.customType === "harness-refinement");
    expect((audit!.data as { proposer: string }).proposer).toBe("steering");
    expect((audit!.data as { applied: number }).applied).toBe(0);
  });

  it("parses lookback N and --commit from args", async () => {
    // We don't assert the durable write here (covered in store.test.ts); we only
    // confirm argument parsing does not throw and still steers.
    const { pi, commands, ctx, sentMessages } = makeFakePi([]);
    continualHarness(pi);
    await commands.get("refine")!.handler("50 --commit", ctx());
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("last 50 turns");
  });
});

describe("harness tools round-trip", () => {
  beforeEach(reset);

  it("harness_mutate applies deltas and snapshots via appendEntry; harness_list reads them back", async () => {
    const { pi, tools, ctx, entries } = makeFakePi([]);
    continualHarness(pi);

    const mutate = tools.get("harness_mutate")!;
    const res = (await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(undefined, {
      deltas: [{ op: "create", kind: "memory", content: "fact A", evidence: "saw it" }],
    }, undefined, undefined, ctx())) as { content: Array<{ type: string; text: string }>; details: { applied: unknown[] } };

    expect(res.content[0]!.text).toMatch(/Applied 1 delta/);
    expect(res.details.applied).toHaveLength(1);
    // The persist callback inside tools.ts calls pi.appendEntry("harness-state", ...).
    expect(entries.some((e) => e.customType === STATE_ENTRY)).toBe(true);

    const list = tools.get("harness_list")!;
    const listed = (await (list.execute as (...a: unknown[]) => Promise<unknown>)(undefined, {}, undefined, undefined, ctx())) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(listed.content[0]!.text).toContain("fact A");
  });
});

describe("/harness command", () => {
  beforeEach(reset);

  it("registers the harness command", () => {
    const { pi, commands } = makeFakePi([]);
    continualHarness(pi);
    expect(commands.has("harness")).toBe(true);
  });

  it("export then import round-trips active items through a durable file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-harness-"));
    const file = join(dir, "harness-state.md");
    try {
      const { pi, tools, commands, ctx, notifications } = makeFakePi([]);
      continualHarness(pi);

      // seed an item
      const mutate = tools.get("harness_mutate")!;
      await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(
        undefined,
        { deltas: [{ op: "create", kind: "memory", content: "durable fact", evidence: "saw it" }] },
        undefined,
        undefined,
        ctx(),
      );

      // export to the temp file
      await commands.get("harness")!.handler(`export ${file}`, ctx());
      expect(notifications.some((n) => /Exported 1 active/.test(n.msg))).toBe(true);

      // wipe live state, then import it back
      reconstruct([]);
      expect(getState().items).toHaveLength(0);
      await commands.get("harness")!.handler(`import ${file}`, ctx());
      expect(getState().items.map((i) => i.content)).toContain("durable fact");
      expect(notifications.some((n) => /Imported 1 item/.test(n.msg))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("/harness prune removes items below the importance floor", async () => {
    const { pi, tools, commands, ctx, notifications } = makeFakePi([]);
    continualHarness(pi);
    const mutate = tools.get("harness_mutate")!;
    await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(
      undefined,
      { deltas: [{ op: "create", kind: "memory", content: "low", evidence: "e", importance: 0.1 }] },
      undefined,
      undefined,
      ctx(),
    );
    expect(getState().items).toHaveLength(1);
    await commands.get("harness")!.handler("prune", ctx());
    expect(getState().items).toHaveLength(0);
    expect(notifications.some((n) => /1 pruned/.test(n.msg))).toBe(true);
  });

  it("/harness keep|drop nudge importance by id", async () => {
    const { pi, tools, commands, ctx } = makeFakePi([]);
    continualHarness(pi);
    const mutate = tools.get("harness_mutate")!;
    await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(
      undefined,
      { deltas: [{ op: "create", kind: "memory", content: "x", evidence: "e", importance: 0.5 }] },
      undefined,
      undefined,
      ctx(),
    );
    const id = getState().items[0]!.id;
    await commands.get("harness")!.handler(`keep ${id}`, ctx());
    expect(getState().items[0]!.importance).toBeCloseTo(0.6);
    await commands.get("harness")!.handler(`drop ${id}`, ctx());
    expect(getState().items[0]!.importance).toBeCloseTo(0.5);
  });
});

describe("runRefine + auto-refine", () => {
  beforeEach(reset);

  it("runRefine tags the audit entry with source (manual default, auto explicit)", async () => {
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "fix the login bug" }] } },
    ];
    const { pi, commands, ctx, entries } = makeFakePi(branch);
    continualHarness(pi);

    // manual via /refine command
    await commands.get("refine")!.handler("5", ctx());
    // auto via runRefine direct
    await runRefine(pi, ctx() as unknown as ExtensionCommandContext, { lookback: 5 }, "auto");

    const audits = entries.filter((e) => e.customType === "harness-refinement");
    expect(audits).toHaveLength(2);
    expect((audits[0]!.data as { source: string }).source).toBe("manual");
    expect((audits[1]!.data as { source: string }).source).toBe("auto");
  });

  it("turn_end triggers auto-refine only when enabled and the cadence elapses", async () => {
    resetAutoRefine();
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-auto-"));
    const cfgFile = join(dir, "harness.json");
    writeFileSync(cfgFile, JSON.stringify({ autoRefine: { enabled: true, everyTurns: 1 } }));
    await loadConfig(cfgFile); // populate the in-process config cache (deterministic)
    try {
      const branch = [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "fix bug" }] } },
      ];
      const { pi, handlers, ctx, sentMessages, entries } = makeFakePi(branch);
      continualHarness(pi); // turn_end on the fake = auto-refine (last registered)

      // turn 0 seeds the baseline (no fire); turn 1 fires (everyTurns=1)
      await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0 }, ctx());
      expect(sentMessages).toHaveLength(0);
      await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 1 }, ctx());

      expect(sentMessages.length).toBeGreaterThanOrEqual(1);
      expect(sentMessages.at(-1)).toContain("/refine");
      const audits = entries.filter((e) => e.customType === "harness-refinement");
      expect(audits).toHaveLength(1);
      expect((audits[0]!.data as { source: string }).source).toBe("auto");
    } finally {
      resetAutoRefine();
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turn_end stays inert when auto-refine is disabled (cached disabled config)", async () => {
    resetAutoRefine();
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-auto-off-"));
    const cfgFile = join(dir, "harness.json");
    writeFileSync(cfgFile, JSON.stringify({ autoRefine: { enabled: false } }));
    await loadConfig(cfgFile);
    try {
      const { pi, handlers, ctx, sentMessages } = makeFakePi([]);
      continualHarness(pi);
      for (let i = 0; i < 200; i++) {
        await handlers.get("turn_end")!({ type: "turn_end", turnIndex: i }, ctx());
      }
      expect(sentMessages).toHaveLength(0);
    } finally {
      resetAutoRefine();
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session_start resets the auto-refine cadence baseline (fresh on fork/resume)", async () => {
    resetAutoRefine();
    resetConfigCache();
    resetOutcome();
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-reset-"));
    const cfgFile = join(dir, "harness.json");
    writeFileSync(cfgFile, JSON.stringify({ autoRefine: { enabled: true, everyTurns: 1 } }));
    await loadConfig(cfgFile);
    try {
      const { pi, handlers, ctx, sentMessages } = makeFakePi([
        { type: "message", message: { role: "user", content: [{ type: "text", text: "fix bug" }] } },
      ]);
      continualHarness(pi);

      await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 0 }, ctx()); // seed
      await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 1 }, ctx()); // fire #1
      const afterFirst = sentMessages.length;
      expect(afterFirst).toBeGreaterThanOrEqual(1);

      // Simulate a fork/resume: session_start should reset the cadence so the
      // very next turn re-seeds instead of firing immediately.
      await handlers.get("session_start")!({ reason: "fork" }, ctx());
      await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 2 }, ctx());
      expect(sentMessages.length).toBe(afterFirst); // re-seeded, no immediate fire

      await handlers.get("turn_end")!({ type: "turn_end", turnIndex: 3 }, ctx()); // fire #2
      expect(sentMessages.length).toBe(afterFirst + 1);
    } finally {
      resetAutoRefine();
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("proposer selection (Phase 4)", () => {
  beforeEach(reset);

  it("a proposer cannot mutate the live store (defensive snapshot)", async () => {
    const { pi, ctx } = makeFakePi([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "fix bug" }] } },
    ]);
    continualHarness(pi);
    applyDeltas(
      [{ op: "create", kind: "memory", content: "fact one", evidence: "e", importance: 0.8 }] as Delta[],
      () => {},
    );
    expect(getState().items).toHaveLength(1);

    // A hostile/buggy proposer that mutates the state it was handed.
    registerProposer({
      name: "mutator-regression",
      async propose({ state }) {
        state.items[0]!.importance = 0;
        state.items.push({ ...state.items[0]!, id: "h_fake" });
        return {};
      },
    });

    await runRefine(pi, ctx() as unknown as ExtensionCommandContext, { proposer: "mutator-regression" });

    // live store is untouched: still 1 item, importance unchanged, no junk id
    expect(getState().items).toHaveLength(1);
    expect(getState().items[0]!.importance).toBe(0.8);
    expect(getState().items[0]!.id).not.toBe("h_fake");
  });

  it("runRefine with proposer 'dedupe' applies deltas directly (no steering message)", async () => {
    const { pi, ctx, sentMessages, entries } = makeFakePi([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "fix bug" }] } },
    ]);
    continualHarness(pi);
    // seed two near-duplicate active items
    const seeds: Delta[] = [
      { op: "create", kind: "prompt", content: "always use the foo pattern", evidence: "t1", importance: 0.9 },
      { op: "create", kind: "prompt", content: "use the foo pattern always", evidence: "t2", importance: 0.4 },
    ];
    applyDeltas(seeds, () => {});
    expect(getState().items).toHaveLength(2);

    await runRefine(pi, ctx() as unknown as ExtensionCommandContext, { proposer: "dedupe" });

    // direct-apply path: no steering message, lower-importance dupe removed
    expect(sentMessages).toHaveLength(0);
    expect(getState().items).toHaveLength(1);
    expect(getState().items[0]!.importance).toBe(0.9);
    // audit records which proposer ran + how many it applied
    const audits = entries.filter((e) => e.customType === "harness-refinement");
    expect(audits).toHaveLength(1);
    expect((audits[0]!.data as { proposer: string }).proposer).toBe("dedupe");
    expect((audits[0]!.data as { applied: number }).applied).toBe(1);
  });

  it("/refine --proposer dedupe routes through the command path", async () => {
    const { pi, commands, ctx, sentMessages } = makeFakePi([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "fix bug" }] } },
    ]);
    continualHarness(pi);
    const seeds: Delta[] = [
      { op: "create", kind: "prompt", content: "always use the foo pattern", evidence: "t1", importance: 0.9 },
      { op: "create", kind: "prompt", content: "use the foo pattern always", evidence: "t2", importance: 0.4 },
    ];
    applyDeltas(seeds, () => {});
    await commands.get("refine")!.handler("--proposer dedupe", ctx());
    expect(sentMessages).toHaveLength(0);
    expect(getState().items).toHaveLength(1);
  });
});

// Phase 5 / E: /harness push-mem composes with pi-mem via a steering message.
// No dependency on pi-mem — the message is tool-agnostic and soft-fails if the
// agent has no memory tool.
describe("/harness push-mem (Phase 5)", () => {
  beforeEach(reset);

  it("steers the agent to save_memory for each active memory item", async () => {
    const { pi, tools, commands, ctx, sentMessages, notifications } = makeFakePi([]);
    continualHarness(pi);
    const mutate = tools.get("harness_mutate")!;
    await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(
      undefined,
      { deltas: [
        { op: "create", kind: "memory", content: "use PostgreSQL", evidence: "decided in design review" },
        { op: "create", kind: "prompt", content: "always cite evidence", evidence: "e", importance: 0.8 },
      ] },
      undefined,
      undefined,
      ctx(),
    );

    await commands.get("harness")!.handler("push-mem", ctx());

    // default scope = memory kind only → only the one memory item is pushed
    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0]!;
    expect(msg).toContain("save_memory");
    expect(msg).toContain("use PostgreSQL");
    expect(msg).toContain("decided in design review");
    // the prompt-kind item is NOT in the default (memory-only) push
    expect(msg).not.toContain("always cite evidence");
    // graceful guidance when pi-mem may be absent
    expect(msg).toContain("pi install npm:pi-mem");
    expect(notifications.some((n) => /Steering agent to persist 1/.test(n.msg))).toBe(true);
  });

  it("--all pushes every active item regardless of kind", async () => {
    const { pi, tools, commands, ctx, sentMessages } = makeFakePi([]);
    continualHarness(pi);
    const mutate = tools.get("harness_mutate")!;
    await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(
      undefined,
      { deltas: [
        { op: "create", kind: "memory", content: "m1", evidence: "e" },
        { op: "create", kind: "prompt", content: "p1", evidence: "e" },
        { op: "create", kind: "skill", content: "s1", evidence: "e" },
      ] },
      undefined,
      undefined,
      ctx(),
    );

    await commands.get("harness")!.handler("push-mem --all", ctx());
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("m1");
    expect(sentMessages[0]).toContain("p1");
    expect(sentMessages[0]).toContain("s1");
  });

  it("notifies with a hint when there is nothing to push", async () => {
    const { pi, commands, ctx, sentMessages, notifications } = makeFakePi([]);
    continualHarness(pi);
    await commands.get("harness")!.handler("push-mem", ctx());
    expect(sentMessages).toHaveLength(0);
    expect(notifications.some((n) => /No active items to push/.test(n.msg))).toBe(true);
  });

  it("--model scopes the push to one owner model", async () => {
    const { pi, commands, ctx, sentMessages } = makeFakePi([]);
    continualHarness(pi);
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "sonnet fact", evidence: "e", ownerModel: "anthropic/sonnet" },
        { op: "create", kind: "memory", content: "gemini fact", evidence: "e", ownerModel: "google/gemini" },
      ] as Delta[],
      () => {},
    );
    await commands.get("harness")!.handler("push-mem --all --model anthropic/sonnet", ctx());
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("sonnet fact");
    expect(sentMessages[0]).not.toContain("gemini fact");
  });

  it("--model active resolves to the model driving the command", async () => {
    const { pi, commands, ctx, sentMessages } = makeFakePi([]);
    continualHarness(pi);
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "current model fact", evidence: "e", ownerModel: "test/main" },
        { op: "create", kind: "memory", content: "other model fact", evidence: "e", ownerModel: "other/model" },
      ] as Delta[],
      () => {},
    );
    await commands.get("harness")!.handler("push-mem --all --model active", ctx());
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("current model fact");
    expect(sentMessages[0]).not.toContain("other model fact");
  });
});

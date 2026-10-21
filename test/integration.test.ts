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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import continualHarness from "../src/index.js";
import { applyDeltas, getState, reconstruct, setSessionProject, STATE_ENTRY } from "../src/store.js";
import type { Delta } from "../src/types.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { resetAutoRefine } from "../src/auto-refine.js";
import { resetOutcome } from "../src/outcome.js";
import { resetDurableSync } from "../src/durable.js";
import { runRefine } from "../src/refine.js";
import { registerProposer } from "../src/proposer.js";
import { makeFakePi } from "./helpers.js";

// Prime the config cache with defaults before each test so handlers never read
// the developer's real ~/.pi/agent/harness.json (which may opt into autoImport
// and would then touch real files from these tests).
async function reset(): Promise<void> {
  reconstruct([]);
  setSessionProject(undefined);
  resetDurableSync();
  resetConfigCache();
  await loadConfig(join(tmpdir(), `pi-ch-test-no-config-${Date.now()}.json`));
}

describe("registration", () => {
  beforeEach(reset);

  it("registers session_start, before_agent_start, context_with_system, turn_end, the two tools, and /refine", () => {
    const { pi, handlers, tools, commands } = makeFakePi([]);
    continualHarness(pi);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("context_with_system")).toBe(true);
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
    const { pi, fire, ctx, notifications } = makeFakePi(branch);
    continualHarness(pi);

    await fire("session_start", { reason: "startup" }, ctx());

    expect(getState().items.map((i) => i.id)).toEqual(["h_1"]);
    expect(notifications.some((n) => /1 item\(s\) restored/.test(n.msg))).toBe(true);
  });

  it("stays empty and stays quiet when the branch has no harness-state entry", async () => {
    const { pi, fire, ctx, notifications } = makeFakePi([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ]);
    continualHarness(pi);
    await fire("session_start", { reason: "startup" }, ctx());
    expect(getState().items).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });
});

describe("injection — before_agent_start bridge + context_with_system render", () => {
  beforeEach(reset);

  it("appends a structured block to the system message and never replaces it", async () => {
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
    const { pi, fire, ctx } = makeFakePi(branch);
    continualHarness(pi);
    await fire("session_start", { reason: "startup" }, ctx());

    // before_agent_start adopts the restored orphan to the active model first
    // (the bridge), then the per-request render happens in context_with_system.
    await fire("before_agent_start", { type: "before_agent_start", messageType: "user", systemPrompt: "BASE", prompt: "hi" }, ctx());
    const [ret] = (await fire("context_with_system", {
      messages: [{ role: "system", content: "BASE" }],
    }, ctx())) as Array<{ messages?: Array<{ role: string; content: string }> } | undefined>;

    expect(ret?.messages).toBeDefined();
    expect(ret!.messages![0]!.role).toBe("system");
    expect(ret!.messages![0]!.content.startsWith("BASE")).toBe(true);
    expect(ret!.messages![0]!.content).toContain("Continual Harness state");
    expect(ret!.messages![0]!.content).toContain("Always cite evidence");
  });

  it("re-renders on EVERY provider request: a mid-run harness_mutate shows up on the next request", async () => {
    const { pi, fire, ctx, tools } = makeFakePi([]);
    continualHarness(pi);
    await fire("session_start", { reason: "startup" }, ctx());
    await fire("before_agent_start", { type: "before_agent_start", messageType: "user", systemPrompt: "BASE", prompt: "hi" }, ctx());

    const first = (await fire("context_with_system", { messages: [{ role: "system", content: "BASE" }] }, ctx())) as Array<{ messages?: Array<{ role: string; content: string }> } | undefined>;
    expect(first[0]).toBeUndefined(); // empty store → no owned transcript

    // The model fixes the (empty) state mid-run:
    await (tools.get("harness_mutate")!.execute as (...a: unknown[]) => Promise<unknown>)(undefined, {
      deltas: [{ op: "create", kind: "memory", content: "prefer pnpm here", evidence: "e" }],
    }, undefined, undefined, ctx());

    const second = (await fire("context_with_system", { messages: [{ role: "system", content: "BASE" }] }, ctx())) as Array<{ messages?: Array<{ role: string; content: string }> } | undefined>;
    expect(second[0]!.messages![0]!.content).toContain("prefer pnpm here");
  });

  it("returns undefined (no transcript ownership) when there is no active state", async () => {
    const { pi, fire, ctx } = makeFakePi([]);
    continualHarness(pi);
    await fire("before_agent_start", { type: "before_agent_start", messageType: "user", systemPrompt: "BASE", prompt: "hi" }, ctx());
    const [ret] = await fire("context_with_system", { messages: [{ role: "system", content: "BASE" }] }, ctx());
    expect(ret).toBeUndefined();
  });
});

// Phase 7: injection selection is ON BY DEFAULT. These drive the real
// context_with_system handler (which reads config + renders) to pin the default
// behaviour end-to-end: importance-ordered, capped, with a transparency footer;
// and that `injection.enabled: false` restores the legacy "all, in order" mode.
describe("context_with_system injection selection (default on, opt-out)", () => {
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
      const { pi, fire, ctx } = makeFakePi([]);
      continualHarness(pi);
      applyDeltas(items, () => {});
      await fire("before_agent_start", { type: "before_agent_start", messageType: "user", systemPrompt: "BASE", prompt: "hi" }, ctx()); // cache the active model
      const [ret] = (await fire("context_with_system", { messages: [{ role: "system", content: "BASE" }] }, ctx())) as Array<{
        messages?: Array<{ role: string; content: string }>;
      }>;
      return ret?.messages?.[0]?.content ?? "";
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
    const { pi, commands, ctx, sentMessages, sendOptions, entries } = makeFakePi(branch);
    continualHarness(pi);

    await commands.get("refine")!.handler("25", ctx());

    // (1) evidence text survived into the steering prompt
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("Fix the login bug in auth.ts");
    expect(sentMessages[0]).toContain("harness_mutate");
    // pi ≥ 1.2: explicit deliverAs — a bare send throws in the widened busy window
    expect(sendOptions[0]).toEqual({ deliverAs: "steer" });

    // audit entry recorded
    expect(entries.some((e) => e.customType === "harness-refinement")).toBe(true);
    const audit = entries.find((e) => e.customType === "harness-refinement");
    expect((audit!.data as { proposer: string }).proposer).toBe("steering");
    expect((audit!.data as { applied: number }).applied).toBe(0);
  });

  it("injects the evidence-gated lessons digest into the steering message (harnessing-level recursion)", async () => {
    reconstruct([
      {
        type: "custom",
        customType: STATE_ENTRY,
        data: {
          state: {
            items: [
              { id: "h_sup", kind: "memory", content: "run tests before pushing", evidence: "e", importance: 0.6, active: true, ownerModel: "test/main", support: { citations: 2, lastCitedAt: 1 }, createdAt: 1, updatedAt: 1 },
              { id: "h_quiet", kind: "memory", content: "unsupported note", evidence: "e", importance: 0.6, active: true, ownerModel: "test/main", createdAt: 1, updatedAt: 1 },
            ],
          },
        },
      },
    ]);
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "improve things" }] } },
    ];
    const { pi, commands, ctx, sentMessages } = makeFakePi(branch);
    continualHarness(pi);

    await commands.get("refine")!.handler("25", ctx());
    expect(sentMessages).toHaveLength(1);
    // Supported item is named; the never-cited one is not (no signal ≠ negative).
    expect(sentMessages[0]).toContain("## Lessons from past refines");
    expect(sentMessages[0]).toContain("[h_sup] (cited 2×)");
    expect(sentMessages[0]).not.toContain("h_quiet");
  });

  it("omits the lessons section entirely when nothing is evidence-gated", async () => {
    const { pi, commands, ctx, sentMessages } = makeFakePi([]);
    continualHarness(pi);
    await commands.get("refine")!.handler("25", ctx());
    expect(sentMessages[0]).not.toContain("Lessons from past refines");
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

  it("warns on unknown --flags instead of silently dropping them (review finding #7)", async () => {
    const { pi, commands, ctx, sentMessages, notifications } = makeFakePi([]);
    continualHarness(pi);
    await commands.get("refine")!.handler("25 --comit", ctx()); // typo'd --commit
    expect(notifications.some((n) => n.level === "warning" && n.msg.includes("--comit"))).toBe(true);
    expect(sentMessages).toHaveLength(1); // the refine itself still runs
  });

  it("warns when --proposer names an unregistered proposer (falls back to steering — review finding #7)", async () => {
    const { pi, commands, ctx, sentMessages, notifications } = makeFakePi([]);
    continualHarness(pi);
    await commands.get("refine")!.handler("--proposer dedupee", ctx()); // typo'd dedupe
    expect(
      notifications.some((n) => n.level === "warning" && /Unknown proposer "dedupee"/.test(n.msg)),
    ).toBe(true);
    expect(sentMessages).toHaveLength(1); // steering fallback ran
  });

  it("boundary delivery: runRefine returns the steering message undelivered (auto-refine persists it as a turn_end draft)", async () => {
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "learned: prefer pnpm" }] } },
    ];
    const { pi, ctx, sentMessages, entries } = makeFakePi(branch);
    continualHarness(pi);

    const result = await runRefine(pi, ctx() as unknown as Parameters<typeof runRefine>[1], { lookback: 5, delivery: "boundary" }, "auto");

    // NOT sent as a user message — the caller owns delivery
    expect(sentMessages).toHaveLength(0);
    expect(result.steeringMessage).toContain("learned: prefer pnpm");
    // the audit entry is still recorded (branchable via /tree)
    const audits = entries.filter((e) => e.customType === "harness-refinement");
    expect(audits).toHaveLength(1);
    expect((audits[0]!.data as { source: string }).source).toBe("auto");
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
    }, undefined, undefined, ctx())) as { content: Array<{ type: string; text: string }>; details: { applied: unknown[] }; structuredContent?: { applied: number; created: number; updated: number; deleted: number } };

    expect(res.content[0]!.text).toMatch(/Applied 1 delta/);
    expect(res.details.applied).toHaveLength(1);
    // structuredContent (pi ≥ 0.99): codemode / executeTool callers get JSON
    expect(res.structuredContent).toEqual({ applied: 1, created: 1, updated: 0, deleted: 0 });
    // The persist callback inside tools.ts calls pi.appendEntry("harness-state", ...).
    expect(entries.some((e) => e.customType === STATE_ENTRY)).toBe(true);

    const list = tools.get("harness_list")!;
    const listed = (await (list.execute as (...a: unknown[]) => Promise<unknown>)(undefined, {}, undefined, undefined, ctx())) as {
      content: Array<{ type: string; text: string }>;
      structuredContent?: { count: number; items: Array<{ id: string; content: string; ownerModel: string }> };
    };
    expect(listed.content[0]!.text).toContain("fact A");
    // structuredContent mirrors the store for programmatic callers
    expect(listed.structuredContent?.count).toBe(1);
    expect(listed.structuredContent?.items[0]?.content).toBe("fact A");
  });
});

describe("/harness command", () => {
  beforeEach(reset);

  it("registers the harness command", () => {
    const { pi, commands } = makeFakePi([]);
    continualHarness(pi);
    expect(commands.has("harness")).toBe(true);
  });

  it("registers argument completions and lists all subcommands on empty prefix", async () => {
    const { pi, commands } = makeFakePi([]);
    continualHarness(pi);
    // Completions are async since the thin-entry refactor (issue #36): pi's
    // API allows a Promise here, and the store-backed menus lazy-load.
    const complete = async (p: string) => await commands.get("harness")!.getArgumentCompletions!(p);
    const items = (await complete("")) as Array<{ value: string; label: string; description?: string }>;
    expect(items.map((i) => i.value)).toEqual([
      "import",
      "export",
      "export-corpus",
      "status",
      "list",
      "prune",
      "keep",
      "drop",
      "move",
      "split",
      "adopt",
      "push-mem",
      "setup",
      "lessons",
    ]);
    for (const i of items) {
      expect(i.label).toBe(i.value); // label mirrors the subcommand name
      expect(i.description).toMatch(/\S/); // one short help line each
    }
  });

  it("filters subcommands case-insensitively as you type", async () => {
    const { pi, commands } = makeFakePi([]);
    continualHarness(pi);
    const complete = async (p: string) => await commands.get("harness")!.getArgumentCompletions!(p);
    expect(((await complete("imp")) as Array<{ value: string }>).map((i) => i.value)).toEqual(["import"]);
    expect(((await complete("P")) as Array<{ value: string }>).map((i) => i.value)).toEqual([
      "prune",
      "push-mem",
    ]);
    expect(await complete("nope")).toBeNull();
  });

  it("completes subcommand flags with the full replacement value", async () => {
    const { pi, commands } = makeFakePi([]);
    continualHarness(pi);
    const complete = async (p: string) => await commands.get("harness")!.getArgumentCompletions!(p);
    // trailing space → fresh-token menu of the sub's unused flags
    expect(await complete("import ")).toEqual([
      { value: "import --prune", label: "--prune", description: expect.any(String) },
    ]);
    // partial flag → filtered, value replaces the WHOLE argument text
    expect(await complete("import --p")).toEqual([
      { value: "import --prune", label: "--prune", description: expect.any(String) },
    ]);
    // already-used flags are not re-offered; the remaining ones are
    expect(await complete("push-mem --all --")).toEqual([
      { value: "push-mem --all --kind", label: "--kind", description: expect.any(String) },
      { value: "push-mem --all --model", label: "--model", description: expect.any(String) },
    ]);
    // subs without flags (or unknown subs) offer nothing
    expect(await complete("status ")).toBeNull();
    expect(await complete("whatever --")).toBeNull();
  });

  it("never throws on bogus subcommands that collide with Object.prototype members (review finding #2)", async () => {
    const { pi, commands } = makeFakePi([]);
    continualHarness(pi);
    const complete = async (p: string) => await commands.get("harness")!.getArgumentCompletions!(p);
    // "constructor"/"toString"/"hasOwnProperty" are inherited Object members:
    // an `in` / FLAGS[sub] lookup would resolve Function and crash on .filter.
    for (const bogus of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(() => complete(`${bogus} `)).not.toThrow();
      expect(await complete(`${bogus} `)).toBeNull(); // not a flag-taking sub → no menu
      expect(() => complete(`${bogus} --`)).not.toThrow();
      expect(await complete(`${bogus} --`)).toBeNull();
    }
  });

  it("completes --kind and --model values for push-mem", async () => {
    const { pi, commands } = makeFakePi([]);
    continualHarness(pi);
    const complete = async (p: string) => await commands.get("harness")!.getArgumentCompletions!(p);
    expect(await complete("push-mem --kind m")).toEqual([
      { value: "push-mem --kind memory", label: "memory", description: expect.any(String) },
    ]);
    // --model offers `active` plus the distinct owner models in the store
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "a", evidence: "e", ownerModel: "anthropic/sonnet" },
        { op: "create", kind: "memory", content: "b", evidence: "e", ownerModel: "google/gemini" },
      ] as Delta[],
      () => {},
    );
    const models = (await complete("push-mem --model ")) as Array<{ value: string }>;
    expect(models.map((m) => m.value)).toEqual([
      "push-mem --model active",
      "push-mem --model anthropic/sonnet",
      "push-mem --model google/gemini",
    ]);
  });

  it("completes setup flags and --preset values (issue #22)", async () => {
    const { pi, commands } = makeFakePi([]);
    continualHarness(pi);
    const complete = async (p: string) => await commands.get("harness")!.getArgumentCompletions!(p);
    // fresh token → the setup flags
    expect(await complete("setup ")).toEqual([
      { value: "setup --preset", label: "--preset", description: expect.any(String) },
      { value: "setup --yes", label: "--yes", description: expect.any(String) },
    ]);
    // used flags are not re-offered
    expect(await complete("setup --yes --")).toEqual([
      { value: "setup --yes --preset", label: "--preset", description: expect.any(String) },
    ]);
    // --preset completes the three preset names as full replacement values
    expect(await complete("setup --preset ")).toEqual([
      { value: "setup --preset quiet", label: "quiet", description: expect.any(String) },
      { value: "setup --preset recommended", label: "recommended", description: expect.any(String) },
      { value: "setup --preset power", label: "power", description: expect.any(String) },
    ]);
    expect(await complete("setup --preset re")).toEqual([
      { value: "setup --preset recommended", label: "recommended", description: expect.any(String) },
    ]);
  });

  it("completes list flags, --kind values, and --scope values (issue #31)", async () => {
    const { pi, commands } = makeFakePi([]);
    continualHarness(pi);
    const complete = async (p: string) => await commands.get("harness")!.getArgumentCompletions!(p);
    // fresh token → the list flags (-f included — short flags complete too)
    expect(await complete("list ")).toEqual([
      { value: "list -f", label: "-f", description: expect.any(String) },
      { value: "list --kind", label: "--kind", description: expect.any(String) },
      { value: "list --scope", label: "--scope", description: expect.any(String) },
    ]);
    // short-flag prefix matches; a used -f is not re-offered
    expect(await complete("list -")).toHaveLength(3);
    expect(await complete("list -f --")).toEqual([
      { value: "list -f --kind", label: "--kind", description: expect.any(String) },
      { value: "list -f --scope", label: "--scope", description: expect.any(String) },
    ]);
    // --kind completes the four kinds (same menu as push-mem)
    expect(await complete("list --kind m")).toEqual([
      { value: "list --kind memory", label: "memory", description: expect.any(String) },
    ]);
    // --scope completes its three values with full replacement text
    expect(await complete("list --scope ")).toEqual([
      { value: "list --scope global", label: "global", description: expect.any(String) },
      { value: "list --scope project", label: "project", description: expect.any(String) },
      { value: "list --scope all", label: "all", description: expect.any(String) },
    ]);
    expect(await complete("list --kind memory --scope pr")).toEqual([
      { value: "list --kind memory --scope project", label: "project", description: expect.any(String) },
    ]);
  });

  it("completes keep/drop with active item ids and content previews", async () => {
    const { pi, tools, commands, ctx } = makeFakePi([]);
    continualHarness(pi);
    const mutate = tools.get("harness_mutate")!;
    await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(
      undefined,
      { deltas: [{ op: "create", kind: "memory", content: "use PostgreSQL for the orders service", evidence: "design review" }] },
      undefined,
      undefined,
      ctx(),
    );
    const id = getState().items[0]!.id;
    const complete = async (p: string) => await commands.get("harness")!.getArgumentCompletions!(p);

    const items = (await complete("keep ")) as Array<{ value: string; label: string; description?: string }>;
    expect(items).toHaveLength(1);
    expect(items[0]!.value).toBe(`keep ${id}`);
    expect(items[0]!.label).toBe(id);
    expect(items[0]!.description).toContain("memory");
    expect(items[0]!.description).toContain("use PostgreSQL");

    // prefix filtering on the id, and drop works the same way
    expect(await complete(`drop ${id}`)).toEqual([
      { value: `drop ${id}`, label: id, description: expect.any(String) },
    ]);
    // once the id is committed (trailing space), nothing more to complete
    expect(await complete(`keep ${id} `)).toBeNull();
    expect(await complete("keep h_zzz")).toBeNull();
  });

  it("completes move with item ids then global|project values", async () => {
    const { pi, tools, commands, ctx } = makeFakePi([]);
    continualHarness(pi);
    const mutate = tools.get("harness_mutate")!;
    await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(
      undefined,
      { deltas: [{ op: "create", kind: "memory", content: "relay deploy procedure", evidence: "e" }] },
      undefined,
      undefined,
      ctx(),
    );
    const id = getState().items[0]!.id;
    const complete = async (p: string) => await commands.get("harness")!.getArgumentCompletions!(p);

    // first positional: the item id (same menu as keep/drop)
    const ids = (await complete("move ")) as Array<{ value: string; label: string }>;
    expect(ids).toHaveLength(1);
    expect(ids[0]!.value).toBe(`move ${id}`);

    // second positional: the target scope
    expect(await complete(`move ${id} `)).toEqual([
      { value: `move ${id} global`, label: "global", description: expect.any(String) },
      { value: `move ${id} project`, label: "project", description: expect.any(String) },
    ]);
    // filtered by prefix, replacing the whole argument text
    expect(await complete(`move ${id} pr`)).toEqual([
      { value: `move ${id} project`, label: "project", description: expect.any(String) },
    ]);
    // id + scope chosen → nothing left to complete
    expect(await complete(`move ${id} project `)).toBeNull();
  });

  it("returns null for path-ish and number arguments (leaves them to the editor)", async () => {
    const { pi, commands } = makeFakePi([]);
    continualHarness(pi);
    const complete = async (p: string) => await commands.get("harness")!.getArgumentCompletions!(p);
    expect(await complete("export ./src")).toBeNull();
    expect(await complete("import /home")).toBeNull();
    expect(await complete("prune --decay ")).toBeNull();
  });

  it("/harness move re-scopes an item (project stamps the session slug)", async () => {
    const { pi, tools, commands, ctx, notifications, entries } = makeFakePi([]);
    continualHarness(pi);
    const mutate = tools.get("harness_mutate")!;
    await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(
      undefined,
      { deltas: [{ op: "create", kind: "memory", content: "relay deploy", evidence: "e" }] },
      undefined,
      undefined,
      ctx(),
    );
    const id = getState().items[0]!.id;

    await commands.get("harness")!.handler(`move ${id} project`, ctx());
    expect(getState().items[0]!.scope).toBe("project");
    // fake ctx cwd is /tmp → slug "tmp"
    expect(getState().items[0]!.project).toBe("tmp");
    expect(notifications.some((n) => /Moved .* → project "tmp"/.test(n.msg))).toBe(true);
    // audited as a harness-state snapshot (rollback-able)
    expect(entries.some((e) => e.customType === STATE_ENTRY)).toBe(true);

    await commands.get("harness")!.handler(`move ${id} global`, ctx());
    expect(getState().items[0]!.scope).toBe("global");
    expect(getState().items[0]!.project).toBeUndefined();
  });

  it("/harness move validates its arguments", async () => {
    const { pi, commands, ctx, notifications } = makeFakePi([]);
    continualHarness(pi);
    await commands.get("harness")!.handler("move", ctx());
    await commands.get("harness")!.handler("move h_x bogus", ctx());
    expect(notifications.filter((n) => n.level === "warning").length).toBe(2);
    await commands.get("harness")!.handler("move h_missing global", ctx());
    expect(notifications.some((n) => /move failed: update: no item/.test(n.msg))).toBe(true);
  });

  it("/harness list renders compact rows and the scope views (issue #31)", async () => {
    const { pi, commands, ctx, notifications, entries } = makeFakePi([]);
    continualHarness(pi);
    // Seed: global memory, this-project prompt (fake cwd /tmp → slug "tmp"),
    // foreign-project memory — importances chosen so ranking ≠ insertion.
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "global fact", evidence: "g", importance: 0.4 },
        { op: "create", kind: "prompt", content: "app note", evidence: "p", importance: 0.9, scope: "project", project: "tmp" },
        { op: "create", kind: "memory", content: "foreign fact", evidence: "f", importance: 0.8, scope: "project", project: "other" },
      ] as Delta[],
      () => {},
    );

    // Default view = the session's layers: global + "tmp"; foreign hidden + noted.
    await commands.get("harness")!.handler("list", ctx());
    let msg = notifications.at(-1)!.msg;
    expect(msg).toContain("2 item(s)");
    expect(msg).toContain('scope global + project "tmp"');
    expect(msg).toContain("app note");
    expect(msg).toContain("global fact");
    expect(msg).not.toContain("foreign fact");
    expect(msg).toContain("1 foreign-project item(s) hidden");
    // importance-desc rows (0.9 prompt before 0.4 memory)
    expect(msg.indexOf("app note")).toBeLessThan(msg.indexOf("global fact"));
    // compact by default, with the -f pointer
    expect(msg).toContain("-f for full text");

    await commands.get("harness")!.handler("list --scope all", ctx());
    msg = notifications.at(-1)!.msg;
    expect(msg).toContain("3 item(s)");
    expect(msg).toContain("foreign fact");

    await commands.get("harness")!.handler("list --scope global", ctx());
    msg = notifications.at(-1)!.msg;
    expect(msg).toContain("1 item(s)");
    expect(msg).not.toContain("app note");

    await commands.get("harness")!.handler("list --kind memory", ctx());
    msg = notifications.at(-1)!.msg;
    expect(msg).toContain("1 item(s)");
    expect(msg).toContain("kind memory");

    // Read-only end to end: no session entries, no store mutation.
    expect(entries).toHaveLength(0);
    expect(getState().items).toHaveLength(3);
  });

  it("/harness list -f renders full text + evidence; empty store and invalid flags guide", async () => {
    const { pi, commands, ctx, notifications } = makeFakePi([]);
    continualHarness(pi);
    // Empty store → zero-state guidance, not a bare zero.
    await commands.get("harness")!.handler("list", ctx());
    expect(notifications.at(-1)!.msg).toContain("`/refine`");

    applyDeltas(
      [{ op: "create", kind: "memory", content: "full fact", evidence: "the evidence", ownerModel: "test/main" }] as Delta[],
      () => {},
    );
    await commands.get("harness")!.handler("list -f", ctx());
    const msg = notifications.at(-1)!.msg;
    expect(msg).toContain("(full text)");
    expect(msg).toContain("model test/main");
    expect(msg).toContain("full fact");
    expect(msg).toContain("evidence: the evidence");

    // Invalid flag values warn instead of silently listing unfiltered.
    await commands.get("harness")!.handler("list --kind bogus", ctx());
    expect(notifications.at(-1)!.level).toBe("warning");
    await commands.get("harness")!.handler("list --scope worldwide", ctx());
    expect(notifications.at(-1)!.level).toBe("warning");
    await commands.get("harness")!.handler("list --kind", ctx());
    expect(notifications.at(-1)!.level).toBe("warning");
    // Unexpected arguments warn too (unknown flags, stray positionals) —
    // no silent fallback to the default view.
    const listed = notifications.length;
    await commands.get("harness")!.handler("list --full", ctx());
    expect(notifications.at(-1)!.level).toBe("warning");
    expect(notifications.at(-1)!.msg).toContain("unexpected argument");
    expect(notifications.at(-1)!.msg).toContain("--full");
    await commands.get("harness")!.handler("list bogus", ctx());
    expect(notifications.at(-1)!.level).toBe("warning");
    expect(notifications.length).toBe(listed + 2); // warnings only, no listing
  });

  it("/harness split steers the agent to classify scopes via harness_mutate", async () => {
    const { pi, tools, commands, ctx, sentMessages, notifications } = makeFakePi([]);
    continualHarness(pi);
    const mutate = tools.get("harness_mutate")!;
    await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(
      undefined,
      { deltas: [
        { op: "create", kind: "memory", content: "PowerShell quirk", evidence: "global ev" },
        { op: "create", kind: "memory", content: "relay deploy procedure", evidence: "project ev" },
      ] },
      undefined,
      undefined,
      ctx(),
    );

    await commands.get("harness")!.handler("split", ctx());
    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0]!;
    expect(msg).toContain("harness_mutate");
    expect(msg).toContain('"scope": "project"');
    expect(msg).toContain("PowerShell quirk");
    expect(msg).toContain("relay deploy procedure");
    expect(msg).toContain('slug "tmp"'); // fake cwd /tmp
    expect(notifications.some((n) => /Steering agent to classify 2/.test(n.msg))).toBe(true);
  });

  it("/harness split is a no-op warning with an empty store", async () => {
    const { pi, commands, ctx, sentMessages, notifications } = makeFakePi([]);
    continualHarness(pi);
    await commands.get("harness")!.handler("split", ctx());
    expect(sentMessages).toHaveLength(0);
    expect(notifications.some((n) => /No active items to split/.test(n.msg))).toBe(true);
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

  it("/harness export-corpus writes dedupe-pairs.jsonl + lifecycle.jsonl from the branch (review gap)", async () => {
    const a = (imp: number) => ({
      id: "h_a",
      kind: "memory",
      content: "fact a",
      evidence: "e",
      importance: imp,
      active: true,
      ownerModel: "test/main",
      createdAt: 1,
      updatedAt: 1,
    });
    const branch = [
      // The first snapshot IS the create batch (implicit empty baseline).
      { type: "custom", customType: "harness-state", data: { state: { items: [a(0.5)] }, version: 1 } },
      { type: "custom", customType: "harness-state", data: { state: { items: [a(0.6)] }, version: 2 } }, // kept (+0.1)
    ];
    const { pi, commands, ctx, notifications } = makeFakePi(branch);
    continualHarness(pi);
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-corpus-"));
    const out = join(dir, "nested", "corpus"); // exercises the recursive mkdir
    try {
      await commands.get("harness")!.handler(`export-corpus ${out}`, ctx());
      expect(notifications.some((n) => /2 lifecycle event/.test(n.msg))).toBe(true);
      const lifecycle = readFileSync(join(out, "lifecycle.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { kind: string; event: string });
      expect(lifecycle.map((r) => r.event)).toEqual(["created", "kept"]);
      expect(lifecycle[0]!.kind).toBe("lifecycle");
      // No dedupe runs on the branch → the pairs file exists but is empty.
      expect(readFileSync(join(out, "dedupe-pairs.jsonl"), "utf8")).toBe("");
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
    // The human signals land in the support counters (Harness² retention evidence).
    expect(getState().items[0]!.support).toEqual({ keeps: 1, drops: 1 });
  });

  it("/harness lessons prints the evidence-gated digest (or a distinct empty state)", async () => {
    const { pi, commands, ctx, notifications } = makeFakePi([]);
    continualHarness(pi);

    // Empty: nothing supportable → guidance, not a blank dump.
    await commands.get("harness")!.handler("lessons", ctx());
    expect(notifications.some((n) => n.msg.includes("No lessons yet"))).toBe(true);
  });

  it("/harness lessons names supported items after feedback", async () => {
    const { pi, tools, commands, ctx, notifications } = makeFakePi([]);
    continualHarness(pi);
    await (tools.get("harness_mutate")!.execute as (...a: unknown[]) => Promise<unknown>)(
      undefined,
      { deltas: [{ op: "create", kind: "memory", content: "supported fact", evidence: "e" }] },
      undefined,
      undefined,
      ctx(),
    );
    const id = getState().items[0]!.id;
    await commands.get("harness")!.handler(`keep ${id}`, ctx());
    notifications.length = 0;
    await commands.get("harness")!.handler("lessons", ctx());
    const digest = notifications.find((n) => n.msg.includes("Lessons from past refines"));
    expect(digest).toBeDefined();
    expect(digest!.msg).toContain(`[${id}] (kept 1×)`);
  });

  it("reports counts, audit-trail impact, per-model annotation, and a hint (issue #20)", async () => {
    const a = (imp: number) => ({
      id: "h_a",
      kind: "memory",
      content: "fact a",
      evidence: "e",
      importance: imp,
      active: true,
      ownerModel: "test/main",
      createdAt: 1,
      updatedAt: 1,
    });
    const branch = [
      { type: "custom", customType: STATE_ENTRY, data: { state: { items: [a(0.5)] }, version: 1 } },
      { type: "custom", customType: STATE_ENTRY, data: { state: { items: [a(0.6)] }, version: 2 } }, // kept
      {
        type: "custom",
        customType: "harness-refinement",
        data: { proposer: "steering", source: "manual", applied: 0, appliedDeltas: [] },
      },
      {
        type: "custom",
        customType: "harness-refinement",
        data: {
          proposer: "dedupe",
          source: "auto",
          applied: 1,
          appliedDeltas: [{ op: "delete", id: "h_z", reason: "merged into h_a (overlap 0.90)" }],
        },
      },
    ];
    const { pi, commands, ctx, notifications, fire } = makeFakePi(branch);
    continualHarness(pi);
    await fire("session_start", { reason: "startup" }, ctx()); // reconstruct from the branch
    await commands.get("harness")!.handler("status", ctx());
    const msg = notifications.find((n) => n.msg.startsWith("Harness:"))!.msg;
    expect(msg).toContain("1 active / 1 total");
    expect(msg).toContain("1 active for [test/main] across 1 model(s)");
    expect(msg).toContain("Impact: 2 refine run(s) (1 manual, 1 auto)");
    expect(msg).toContain("kept 1, cited 0, dropped 0, pruned 0, deleted 0, merged 1");
    expect(msg).toContain("For [test/main]: created 1, updated 0, kept 1"); // a counts via the implicit empty baseline
    expect(msg).toMatch(/Hint: .+/);
    expect(msg).toContain("Durable: global");
    // read-only: nothing new appended by status itself
    expect(getState().items).toHaveLength(1);
  });

  it("zero-state /harness status shows first steps instead of bare zeros", async () => {
    const { pi, commands, ctx, notifications } = makeFakePi([]);
    continualHarness(pi);
    await commands.get("harness")!.handler("status", ctx());
    const msg = notifications.find((n) => n.msg.startsWith("Harness:"))!.msg;
    expect(msg).toContain("0 active / 0 total");
    expect(msg).toContain("First steps");
    expect(msg).toContain("/refine");
    expect(msg).toMatch(/docs\/MANUAL\.md/);
  });

  it("status keys the per-model bands by the physical model under virtualBinding: physical (review #27)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-st-vm-"));
    const cfgFile = join(dir, "harness.json");
    writeFileSync(cfgFile, JSON.stringify({ virtualBinding: "physical" }), "utf8");
    resetConfigCache();
    await loadConfig(cfgFile);
    try {
      const a = {
        id: "h_a",
        kind: "memory",
        content: "fact a",
        evidence: "e",
        importance: 0.5,
        active: true,
        ownerModel: "anthropic/claude-x",
        createdAt: 1,
        updatedAt: 1,
      };
      const branch = [
        // a routed response: the virtual selection resolved to claude-x
        {
          type: "message",
          message: { role: "assistant", provider: "anthropic", model: "claude-x", content: [{ type: "text", text: "ok" }] },
        },
        { type: "custom", customType: STATE_ENTRY, data: { state: { items: [a] }, version: 1 } },
      ];
      const { pi, commands, ctx, notifications, fire } = makeFakePi(branch);
      continualHarness(pi);
      const virtualCtx = () => ({ ...ctx(), model: { provider: "openai-codex", id: "auto", api: "pi-virtual" } });
      await fire("session_start", { reason: "startup" }, virtualCtx());
      await commands.get("harness")!.handler("status", virtualCtx());
      const msg = notifications.find((n) => n.msg.startsWith("Harness:"))!.msg;
      // NOT the router id: items are owned by the routed physical model
      expect(msg).toContain("1 active for [anthropic/claude-x] across 1 model(s)");
      expect(msg).toContain("For [anthropic/claude-x]: created 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      resetConfigCache();
    }
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
      const { pi, fire, ctx, sentMessages, entries } = makeFakePi(branch);
      continualHarness(pi); // turn_end on the fake = auto-refine (last registered)

      // turn 0 seeds the baseline (no fire); turn 1 fires (everyTurns=1)
      await fire("turn_end", { type: "turn_end", turnIndex: 0, entries: [], context: { canContinue: true } }, ctx());
      expect(sentMessages).toHaveLength(0);
      const rets = (await fire("turn_end", { type: "turn_end", turnIndex: 1, entries: [], context: { canContinue: true } }, ctx())) as Array<{
        entries?: Array<{ type: string; customType?: string; content?: string }>;
        continue?: boolean;
      } | undefined>;

      // Boundary delivery (pi ≥ 0.87): the steering prompt is a structural
      // custom-message draft + continue:true — NOT a synthetic user message.
      const boundary = rets.find((r) => r && r.continue === true);
      expect(boundary).toBeDefined();
      expect(sentMessages).toHaveLength(0);
      const draft = boundary!.entries!.find((e) => e.type === "custom_message" && e.customType === "harness.auto-refine-request");
      expect(draft).toBeDefined();
      expect(draft!.content).toContain("/refine");
      const audits = entries.filter((e) => e.customType === "harness-refinement");
      expect(audits).toHaveLength(1);
      expect((audits[0]!.data as { source: string }).source).toBe("auto");
    } finally {
      resetAutoRefine();
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("history gate: skips a cadenced refine after 3 ineffective runs (default refineNoOpSkip)", async () => {
    resetAutoRefine();
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-histgate-"));
    const cfgFile = join(dir, "harness.json");
    writeFileSync(cfgFile, JSON.stringify({ autoRefine: { enabled: true, everyTurns: 1 } }));
    await loadConfig(cfgFile);
    try {
      const noOpRun = (t: number) => ({
        type: "custom",
        customType: "harness-refinement",
        data: { source: "auto", proposer: "steering", applied: 0, startedAt: t },
      });
      const branch = [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "fix bug" }] } },
        noOpRun(1),
        noOpRun(2),
        noOpRun(3),
      ];
      const { pi, fire, ctx, entries, notifications } = makeFakePi(branch);
      continualHarness(pi);

      await fire("turn_end", { type: "turn_end", turnIndex: 0, entries: [], context: { canContinue: true } }, ctx()); // seed
      const rets = (await fire("turn_end", { type: "turn_end", turnIndex: 1, entries: [], context: { canContinue: true } }, ctx())) as Array<{
        continue?: boolean;
      } | undefined>;
      // The cadence elapsed but the history gate vetoed: no new refine ran.
      expect(entries.filter((e) => e.customType === "harness-refinement")).toHaveLength(0);
      expect(rets.every((r) => !r || r.continue !== true)).toBe(true);
      expect(notifications.some((n) => n.msg.includes("history gate"))).toBe(true);
    } finally {
      resetAutoRefine();
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("history gate: one effective run in the window lifts it (refine proceeds)", async () => {
    resetAutoRefine();
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-histgate2-"));
    const cfgFile = join(dir, "harness.json");
    writeFileSync(cfgFile, JSON.stringify({ autoRefine: { enabled: true, everyTurns: 1 } }));
    await loadConfig(cfgFile);
    try {
      const branch = [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "fix bug" }] } },
        { type: "custom", customType: "harness-refinement", data: { source: "auto", proposer: "steering", applied: 0, startedAt: 1 } },
        { type: "custom", customType: "harness-refinement", data: { source: "auto", proposer: "dedupe", applied: 1, startedAt: 2 } },
        { type: "custom", customType: "harness-refinement", data: { source: "auto", proposer: "steering", applied: 0, startedAt: 3 } },
      ];
      const { pi, fire, ctx, entries } = makeFakePi(branch);
      continualHarness(pi);

      await fire("turn_end", { type: "turn_end", turnIndex: 0, entries: [], context: { canContinue: true } }, ctx()); // seed
      await fire("turn_end", { type: "turn_end", turnIndex: 1, entries: [], context: { canContinue: true } }, ctx());
      // Gate lifted by the dedupe run's applied:1 → a new auto-refine happened.
      const audits = entries.filter((e) => e.customType === "harness-refinement");
      expect(audits).toHaveLength(1);
      expect((audits[0]!.data as { source: string }).source).toBe("auto");
    } finally {
      resetAutoRefine();
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("turn_end with an aborted/error outcome never triggers auto-refine", async () => {
    resetAutoRefine();
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-outcome-guard-"));
    const cfgFile = join(dir, "harness.json");
    writeFileSync(cfgFile, JSON.stringify({ autoRefine: { enabled: true, everyTurns: 1 } }));
    await loadConfig(cfgFile);
    try {
      const { pi, fire, ctx, sentMessages, entries } = makeFakePi([
        { type: "message", message: { role: "user", content: [{ type: "text", text: "fix bug" }] } },
      ]);
      continualHarness(pi);

      // Seed on a completed turn; each aborted/error turn would fire at
      // everyTurns=1 if the outcome were ignored. None may produce a boundary
      // continuation, an audit entry, or a steering send.
      await fire("turn_end", { type: "turn_end", turnIndex: 0, entries: [], context: { canContinue: true }, outcome: "completed" }, ctx());
      for (const outcome of ["aborted", "error"]) {
        const rets = (await fire("turn_end", { type: "turn_end", turnIndex: 1, entries: [], context: { canContinue: true }, outcome }, ctx())) as Array<
          { continue?: boolean } | undefined
        >;
        expect(rets.find((r) => r?.continue === true)).toBeUndefined();
      }
      expect(sentMessages).toHaveLength(0);
      expect(entries.filter((e) => e.customType === "harness-refinement")).toHaveLength(0);

      // The aborted turns did not advance the window: the next COMPLETED turn
      // still fires (2 - 0 >= 1 from the seed).
      const rets = (await fire("turn_end", { type: "turn_end", turnIndex: 2, entries: [], context: { canContinue: true }, outcome: "completed" }, ctx())) as Array<
        { continue?: boolean } | undefined
      >;
      expect(rets.find((r) => r?.continue === true)).toBeDefined();
      expect(entries.filter((e) => e.customType === "harness-refinement")).toHaveLength(1);
    } finally {
      resetAutoRefine();
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("boundary omits stale auto-refine drafts from future context (pi ≥ 0.87 context edits); kill-switch off", async () => {
    resetAutoRefine();
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-omit-"));
    const cfgFile = join(dir, "harness.json");
    writeFileSync(cfgFile, JSON.stringify({ autoRefine: { enabled: true, everyTurns: 1 } }));
    await loadConfig(cfgFile);
    try {
      // A prior auto-refine draft still LIVE in the projected context, plus an
      // already-omitted one and an unrelated custom message.
      const contextEntries = [
        {
          sourceEntry: { type: "custom_message", customType: "harness.auto-refine-request", id: "e_stale" },
          messages: [{ role: "custom" }],
        },
        {
          sourceEntry: { type: "custom_message", customType: "harness.auto-refine-request", id: "e_gone" },
          messages: [],
        },
        {
          sourceEntry: { type: "custom_message", customType: "other", id: "e_other" },
          messages: [{ role: "custom" }],
        },
      ];
      const { pi, fire, ctx } = makeFakePi([
        { type: "message", message: { role: "user", content: [{ type: "text", text: "fix bug" }] } },
      ]);
      continualHarness(pi);
      await fire("turn_end", { type: "turn_end", turnIndex: 0, entries: [], context: { canContinue: true, contextEntries } }, ctx());
      const rets = (await fire("turn_end", { type: "turn_end", turnIndex: 1, entries: [], context: { canContinue: true, contextEntries } }, ctx())) as Array<{
        entries?: Array<{ type: string; customType?: string; targetId?: string }>;
        continue?: boolean;
      } | undefined>;
      const boundary = rets.find((r) => r?.continue === true)!;
      const omissions = boundary.entries!.filter((e) => e.type === "context_edit");
      // only the stale LIVE draft, not the already-omitted one, not the other message
      expect(omissions).toEqual([{ type: "context_edit", targetId: "e_stale", replacement: null }]);
      // the new request draft still rides along, AFTER the omissions
      const newDraftIdx = boundary.entries!.findIndex((e) => e.type === "custom_message");
      expect(newDraftIdx).toBeGreaterThan(boundary.entries!.length - 2);
    } finally {
      resetAutoRefine();
      resetConfigCache();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omitStaleDrafts: false disables the context-edit hygiene", async () => {
    resetAutoRefine();
    resetConfigCache();
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-omit-off-"));
    const cfgFile = join(dir, "harness.json");
    writeFileSync(cfgFile, JSON.stringify({ autoRefine: { enabled: true, everyTurns: 1, omitStaleDrafts: false } }));
    await loadConfig(cfgFile);
    try {
      const contextEntries = [
        {
          sourceEntry: { type: "custom_message", customType: "harness.auto-refine-request", id: "e_stale" },
          messages: [{ role: "custom" }],
        },
      ];
      const { pi, fire, ctx } = makeFakePi([
        { type: "message", message: { role: "user", content: [{ type: "text", text: "fix bug" }] } },
      ]);
      continualHarness(pi);
      await fire("turn_end", { type: "turn_end", turnIndex: 0, entries: [], context: { canContinue: true, contextEntries } }, ctx());
      const rets = (await fire("turn_end", { type: "turn_end", turnIndex: 1, entries: [], context: { canContinue: true, contextEntries } }, ctx())) as Array<{
        entries?: Array<{ type: string }>;
        continue?: boolean;
      } | undefined>;
      const boundary = rets.find((r) => r?.continue === true)!;
      expect(boundary.entries!.some((e) => e.type === "context_edit")).toBe(false);
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
      const { pi, fire, ctx, sentMessages } = makeFakePi([]);
      continualHarness(pi);
      for (let i = 0; i < 200; i++) {
        await fire("turn_end", { type: "turn_end", turnIndex: i }, ctx());
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
      const { pi, fire, ctx, sentMessages } = makeFakePi([
        { type: "message", message: { role: "user", content: [{ type: "text", text: "fix bug" }] } },
      ]);
      continualHarness(pi);

      // Fire turn_end at turnIndex N; count boundary continuations across the
      // turn_end handler returns (boundary delivery, not steering sends).
      const fireAndCount = async (turnIndex: number): Promise<number> => {
        const rets = (await fire("turn_end", { type: "turn_end", turnIndex, entries: [], context: { canContinue: true } }, ctx())) as Array<{
          continue?: boolean;
        } | undefined>;
        return rets.filter((r) => r?.continue === true).length;
      };

      let boundaries = (await fireAndCount(0)) + (await fireAndCount(1)); // seed + fire #1
      expect(boundaries).toBe(1);
      expect(sentMessages).toHaveLength(0); // boundary, not steering

      // Simulate a fork/resume: session_start should reset the cadence so the
      // very next turn re-seeds instead of firing immediately.
      await fire("session_start", { reason: "fork" }, ctx());
      boundaries += await fireAndCount(2);
      expect(boundaries).toBe(1); // re-seeded, no immediate fire

      boundaries += await fireAndCount(3); // fire #2
      expect(boundaries).toBe(2);
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
    // merge semantics (0.10.0): the keeper absorbed the duplicate — its
    // evidence is the line-wise union, applied as update + delete (2 deltas).
    expect(getState().items[0]!.evidence).toBe("t1\nt2");
    // audit records which proposer ran + how many it applied
    const audits = entries.filter((e) => e.customType === "harness-refinement");
    expect(audits).toHaveLength(1);
    expect((audits[0]!.data as { proposer: string }).proposer).toBe("dedupe");
    expect((audits[0]!.data as { applied: number }).applied).toBe(2);
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

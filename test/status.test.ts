// /harness status report builder (issue #20) — the three bands:
//  1. impact summary derived from the audit trail (crafted entries, reusing
//     the corpus test fixture style),
//  2. injection stats (recorded by inject.ts),
//  3. zero-state guidance + the rotating one-line hint (rotation/dedupe in
//     hints.ts, contextual applicability in buildStatusReport).

import { describe, it, expect, beforeEach } from "vitest";
import type { HarnessItem, HarnessState } from "../src/types.js";
import { buildStatusReport, renderStatusReport } from "../src/status.js";
import { nextHint, pickHint, resetHints, type StatusHint } from "../src/hints.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { STATE_ENTRY } from "../src/store.js";
import { resetInjectionStats, getInjectionStats, renderHarnessBlock } from "../src/inject.js";
import { reconstruct } from "../src/store.js";

function item(
  over: Partial<HarnessItem> & Pick<HarnessItem, "id" | "kind" | "content">,
): HarnessItem {
  const now = 10_000;
  return {
    evidence: "e",
    importance: 0.5,
    active: true,
    ownerModel: "",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const stateEntry = (items: HarnessItem[]) => ({
  type: "custom",
  customType: STATE_ENTRY,
  data: { state: { items } satisfies HarnessState, version: items.length },
});

const refineEntry = (over: Record<string, unknown> = {}) => ({
  type: "custom",
  customType: "harness-refinement",
  data: { proposer: "steering", source: "manual", applied: 0, appliedDeltas: [], ...over },
});

/** A full config with every hint-driver DISABLED/OFF unless overridden. */
const cfg = (over: Record<string, unknown> = {}): typeof DEFAULT_CONFIG => ({
  ...DEFAULT_CONFIG,
  ...over,
});

describe("buildStatusReport — impact from the audit trail", () => {
  it("counts lifecycle events, runs, merges, and direct-apply updates (whole store)", () => {
    const a = (imp: number, owner = "test/main") =>
      item({ id: "h_a", kind: "prompt", content: "note a", importance: imp, ownerModel: owner });
    const b = (imp: number) =>
      item({
        id: "h_b",
        kind: "memory",
        content: "fact b",
        importance: imp,
        ownerModel: "test/main",
      });
    const entries = [
      refineEntry(), // manual run, steering, nothing applied
      stateEntry([a(0.5)]), // implicit empty baseline → a created (review #27)
      refineEntry({
        source: "auto",
        proposer: "dedupe",
        applied: 1,
        appliedDeltas: [{ op: "update", id: "h_a", importance: 0.7 }],
      }),
      stateEntry([a(0.5), b(0.4)]), // created b
      stateEntry([a(0.6), b(0.4)]), // kept a
      stateEntry([a(0.63), b(0.4)]), // cited a
      stateEntry([a(0.53), b(0.4)]), // dropped a
      stateEntry([a(0.53), b(0.2)]), // b's −0.2 is an explicit set → unclassified
      stateEntry([a(0.53)]), // b removed below the floor → pruned
      stateEntry([]), // a removed above the floor → deleted
      refineEntry({
        proposer: "dedupe",
        appliedDeltas: [
          { op: "delete", id: "h_x", reason: "merged into h_a (overlap 0.90)" },
          { op: "delete", id: "h_y", reason: "near-duplicate of h_a (overlap 0.80)" },
        ],
      }),
    ];
    const r = buildStatusReport({ items: [] }, entries, { config: cfg() });
    expect(r.impact).toEqual({
      manualRuns: 2,
      autoRuns: 1,
      created: 2, // a (first snapshot vs implicit empty baseline) + b
      updated: 1,
      deleted: 1,
      pruned: 1,
      kept: 1,
      dropped: 1,
      cited: 1,
      merged: 1, // only the "merged into" delete; near-duplicate is not a merge
    });
  });

  it("a fresh session's first snapshot IS the create batch: implicit empty baseline (review #27)", () => {
    const a = item({
      id: "h_a",
      kind: "prompt",
      content: "first lesson",
      importance: 0.5,
      ownerModel: "test/main",
    });
    const r = buildStatusReport({ items: [] }, [stateEntry([a])], {
      config: cfg(),
      modelKey: "test/main",
    });
    expect(r.impact.created).toBe(1); // was 0 when the first snapshot was skipped
    expect(r.modelImpact?.created).toBe(1);
  });

  it("attributes lifecycle events per owner for the active-model annotation", () => {
    const mine = item({ id: "h_m", kind: "skill", content: "s", ownerModel: "test/main" });
    const other = item({ id: "h_o", kind: "skill", content: "t", ownerModel: "other/model" });
    const dup = item({ id: "h_d", kind: "skill", content: "s (dup)", ownerModel: "test/main" });
    const entries = [
      stateEntry([]),
      stateEntry([mine]), // created (mine)
      stateEntry([mine, other, dup]), // created (other) + created (dup, mine)
      stateEntry([{ ...mine, importance: 0.53 }, other, dup]), // cited (mine)
      refineEntry({
        proposer: "dedupe",
        appliedDeltas: [
          { op: "update", id: "h_m", importance: 0.8 }, // direct-apply update (mine)
          { op: "delete", id: "h_d", reason: "merged into h_m (overlap 1.00)" }, // merge (mine)
        ],
      }),
    ];
    const r = buildStatusReport({ items: [] }, entries, { config: cfg(), modelKey: "test/main" });
    expect(r.modelImpact).toEqual({
      manualRuns: 0, // run counts are whole-store only
      autoRuns: 0,
      created: 2, // h_m + h_d
      updated: 1, // attributed to the update target's owner (review #27)
      deleted: 0,
      pruned: 0,
      kept: 0,
      dropped: 0,
      cited: 1,
      merged: 1, // attributed to the merged duplicate's owner (review #27)
    });
    // whole store sees both models' events
    expect(r.impact.created).toBe(3);
    expect(r.impact.cited).toBe(1);
    expect(r.impact.updated).toBe(1);
    expect(r.impact.merged).toBe(1);
  });

  it("orphan-owned events attribute to (orphan), not the active model", () => {
    const orphan = item({ id: "h_or", kind: "prompt", content: "x", ownerModel: "" });
    const entries = [stateEntry([]), stateEntry([orphan])];
    const r = buildStatusReport({ items: [] }, entries, { config: cfg(), modelKey: "test/main" });
    expect(r.impact.created).toBe(1);
    expect(r.modelImpact?.created).toBe(0);
  });

  it("classifies citations with the CONFIGURED bump (config-aware, corpus parity)", () => {
    const a = (imp: number) => item({ id: "h_a", kind: "prompt", content: "n", importance: imp });
    const entries = [stateEntry([a(0.5)]), stateEntry([a(0.55)])];
    const withBump = buildStatusReport({ items: [] }, entries, {
      config: cfg({ outcomeImportance: { enabled: true, bump: 0.05 } }),
    });
    expect(withBump.impact.cited).toBe(1);
    const withOther = buildStatusReport({ items: [] }, entries, {
      config: cfg({ outcomeImportance: { enabled: true, bump: 0.02 } }),
    });
    expect(withOther.impact.cited).toBe(0); // +0.05 is an explicit set under a 0.02 bump
  });

  it("legacy count-only refine entries count as runs without crashing", () => {
    const legacy = {
      type: "custom",
      customType: "harness-refinement",
      data: { proposer: "dedupe", applied: 2 },
    };
    const r = buildStatusReport({ items: [] }, [legacy], { config: cfg() });
    expect(r.impact.manualRuns).toBe(1);
    expect(r.impact.autoRuns).toBe(0);
    expect(r.impact.merged).toBe(0);
  });
});

describe("buildStatusReport — counts, scopes, model annotation", () => {
  it("mirrors the classic counts band", () => {
    const items = [
      item({ id: "1", kind: "prompt", content: "a", ownerModel: "test/main" }),
      item({
        id: "2",
        kind: "memory",
        content: "b",
        ownerModel: "test/main",
        scope: "project",
        project: "p",
      }),
      item({ id: "3", kind: "memory", content: "c", ownerModel: "other/model", active: false }),
    ];
    const r = buildStatusReport({ items }, [], { config: cfg(), modelKey: "test/main" });
    expect(r.active).toBe(2);
    expect(r.total).toBe(3);
    expect(r.perKind).toEqual({ prompt: 1, memory: 1, skill: 0, subagent: 0 });
    expect(r.scopeGlobal).toBe(1);
    expect(r.scopeProject).toBe(1);
    expect(r.model).toEqual({ mine: 2, models: 1, key: "test/main" });
  });
});

describe("buildStatusReport — zero-state guidance", () => {
  it("0 active items → actionable first steps + MANUAL pointer", () => {
    const r = buildStatusReport({ items: [] }, [], { config: cfg() });
    expect(r.zeroState).toBeDefined();
    const text = r.zeroState!.join(" ");
    expect(text).toContain("/refine");
    expect(text).toMatch(/MANUAL|docs\/MANUAL\.md/);
  });

  it("inactive items get a mention; active items → no zero-state band", () => {
    const inactive = item({ id: "1", kind: "prompt", content: "a", active: false });
    const empty = buildStatusReport({ items: [] }, [], { config: cfg() });
    expect(empty.zeroState!.join(" ")).not.toContain("inactive");
    const r = buildStatusReport({ items: [inactive] }, [], { config: cfg() });
    expect(r.zeroState!.join(" ")).toContain("1 inactive item");
    const active = buildStatusReport(
      { items: [item({ id: "2", kind: "prompt", content: "x" })] },
      [],
      { config: cfg() },
    );
    expect(active.zeroState).toBeUndefined();
  });
});

describe("buildStatusReport — contextual hints", () => {
  it("empty default-config store: classifier + outcome hints apply (remind nudge is ON by default, #19)", () => {
    const r = buildStatusReport({ items: [] }, [], { config: cfg() });
    expect(r.hints.map((h) => h.id)).toEqual(["classifier-gate", "outcome-loop"]);
    // the remind-refine hint only surfaces for users who explicitly disabled the nudge
    const silenced = buildStatusReport({ items: [] }, [], {
      config: cfg({ remindRefine: { enabled: false, everyTurns: 25, detailEvery: 4 } }),
    });
    expect(silenced.hints.map((h) => h.id)).toContain("remind-refine");
  });

  it("the classifier hint stays until the gate is fully configured (review #27)", () => {
    const memoryGlobal = item({ id: "1", kind: "memory", content: "m", ownerModel: "t/m" });
    const withModelOnly = cfg({ classifier: { model: "typesafe/jev" } });
    // classifier.model alone changes nothing gating-wise — the gate is off
    expect(
      buildStatusReport({ items: [memoryGlobal] }, [], { config: withModelOnly }).hints.map(
        (h) => h.id,
      ),
    ).toContain("classifier-gate");
    const withGate = cfg({
      classifier: { model: "typesafe/jev" },
      autoRefine: {
        enabled: true,
        everyTurns: 100,
        commit: false,
        gate: true,
        omitStaleDrafts: true,
      },
    });
    expect(
      buildStatusReport({ items: [memoryGlobal] }, [], { config: withGate }).hints.map((h) => h.id),
    ).not.toContain("classifier-gate");
  });

  it("each driver appears only while its condition holds", () => {
    const memoryGlobal = item({ id: "1", kind: "memory", content: "m", ownerModel: "t/m" });
    const promptProject = item({
      id: "2",
      kind: "prompt",
      content: "p",
      ownerModel: "t/m",
      scope: "project",
      project: "p",
    });
    const base = cfg({
      classifier: { model: "typesafe/jev" },
      autoRefine: {
        enabled: true,
        everyTurns: 100,
        commit: false,
        gate: true,
        omitStaleDrafts: true,
      },
      remindRefine: { enabled: true, everyTurns: 50 },
    });
    const r = buildStatusReport({ items: [memoryGlobal, promptProject] }, [], { config: base });
    // zero citations + loop off still applies here
    expect(r.hints.map((h) => h.id)).toEqual(["outcome-loop", "push-mem", "split-scopes"]);
    // outcome hint needs BOTH zero citations and the loop off
    const cited = [
      stateEntry([item({ id: "h_a", kind: "prompt", content: "n", importance: 0.5 })]),
      stateEntry([item({ id: "h_a", kind: "prompt", content: "n", importance: 0.53 })]),
    ];
    const withCitations = buildStatusReport({ items: [memoryGlobal] }, cited, { config: cfg() });
    expect(withCitations.hints.map((h) => h.id)).not.toContain("outcome-loop");
    const optedIn = buildStatusReport({ items: [memoryGlobal] }, [], {
      config: cfg({ outcomeImportance: { enabled: true, bump: 0.03 } }),
    });
    expect(optedIn.hints.map((h) => h.id)).not.toContain("outcome-loop");
  });
});

describe("hint rotation (hints.ts)", () => {
  const hints: StatusHint[] = [
    { id: "a", text: "A" },
    { id: "b", text: "B" },
    { id: "c", text: "C" },
  ];

  beforeEach(() => resetHints());

  it("pickHint is pure, rotates from startAt, and skips the last shown", () => {
    expect(pickHint(hints, 0)).toEqual({ hint: hints[0], next: 1 });
    expect(pickHint(hints, 2, "c")).toEqual({ hint: hints[0], next: 1 }); // wraps, skips last
    expect(pickHint(hints, 0, "a")).toEqual({ hint: hints[1], next: 2 });
    expect(pickHint([], 0)).toBeUndefined();
    expect(pickHint(hints, 0, "a")).toEqual(pickHint(hints, 0, "a")); // deterministic
  });

  it("a single hint always shows even when it was the last one", () => {
    expect(pickHint([{ id: "only", text: "x" }], 3, "only")).toEqual({
      hint: { id: "only", text: "x" },
      next: 0,
    });
  });

  it("nextHint rotates through the list and never repeats back-to-back", () => {
    const seen = [
      nextHint(hints)!.id,
      nextHint(hints)!.id,
      nextHint(hints)!.id,
      nextHint(hints)!.id,
    ];
    expect(seen).toEqual(["a", "b", "c", "a"]);
    const two = [nextHint(hints)!.id, nextHint(hints)!.id];
    expect(two[0]).not.toBe(two[1]);
    expect(nextHint([])).toBeUndefined();
  });
});

describe("injection stats (inject.ts)", () => {
  beforeEach(() => {
    reconstruct([]);
    resetInjectionStats();
  });

  it("stays undefined until a render serves items, then accumulates", () => {
    expect(getInjectionStats()).toBeUndefined();
    expect(renderHarnessBlock(undefined)).toBe(""); // no model → nothing
    expect(getInjectionStats()).toBeUndefined();

    reconstruct([
      stateEntry([
        item({ id: "h_1", kind: "prompt", content: "hello world note", ownerModel: "test/main" }),
      ]),
    ] as unknown as Iterable<unknown>);
    const block = renderHarnessBlock("test/main");
    expect(block).toContain("hello world note");
    const s = getInjectionStats()!;
    expect(s.renders).toBe(1);
    expect(s.surfaced).toBe(1);
    expect(s.omitted).toBe(0);
    expect(s.maxTokens).toBe(1500); // DEFAULT_INJECTION.maxTokens
    expect(s.lastTokens).toBeGreaterThan(0);
    expect(s.lastTokens).toBeLessThanOrEqual(s.maxTokens);
  });
});

describe("renderStatusReport", () => {
  beforeEach(() => resetHints());

  it("composes all bands into a single notify string", () => {
    const items = [item({ id: "h_1", kind: "memory", content: "m", ownerModel: "test/main" })];
    const r = buildStatusReport({ items }, [stateEntry([]), stateEntry(items)], {
      config: cfg(),
      modelKey: "test/main",
      injection: { renders: 3, surfaced: 7, omitted: 2, lastTokens: 612, maxTokens: 1500 },
    });
    const hint = nextHint(r.hints)!;
    const text = renderStatusReport(r, { durable: " Durable: global none at ~/.x.", hint });
    expect(text).toContain("Harness: 1 active / 1 total — prompt 0, memory 1, skill 0, subagent 0");
    expect(text).toContain("1 active for [test/main] across 1 model(s)");
    expect(text).toContain(
      "Impact: 0 refine run(s) (0 manual, 0 auto) — created 1, updated 0, kept 0, cited 0",
    );
    expect(text).toContain("For [test/main]: created 1");
    expect(text).toContain(
      "Injection: 3 render(s) this session, 7 item(s) surfaced, ~612/1500 tokens, 2 omitted by selection",
    );
    expect(text).toContain(`Hint: ${hint.text}`);
    expect(text).toContain("Durable: global none at ~/.x.");
    expect(text.split("\n").length).toBeLessThanOrEqual(8); // stays one compact report
  });

  it("zero-state renders guidance lines instead of bare zeros", () => {
    const r = buildStatusReport({ items: [] }, [], { config: cfg() });
    const text = renderStatusReport(r, { durable: " Durable: x" });
    expect(text).toContain("0 active / 0 total");
    expect(text).toContain("First steps");
    expect(text).toContain("/refine");
  });

  it("omits the injection band before the first served render", () => {
    const r = buildStatusReport({ items: [] }, [], { config: cfg() });
    expect(renderStatusReport(r, { durable: " D" })).not.toContain("Injection:");
  });
});

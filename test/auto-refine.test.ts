import { describe, it, expect, beforeEach } from "vitest";
import { buildOmissionDrafts, evaluateAutoRefine, resetAutoRefine, type ProjectedLike } from "../src/auto-refine.js";
import type { HarnessConfig } from "../src/config.js";

const cfg = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  durableScope: "global",
  autoRefine: { enabled: true, everyTurns: 10 },
  ...over,
});

describe("buildOmissionDrafts (pi ≥ 0.87 context edits)", () => {
  const live = (id: string): ProjectedLike => ({
    sourceEntry: { type: "custom_message", customType: "harness.auto-refine-request", id },
    messages: [{ role: "custom", customType: "harness.auto-refine-request" }],
  });
  const omitted = (id: string): ProjectedLike => ({
    sourceEntry: { type: "custom_message", customType: "harness.auto-refine-request", id },
    messages: [],
  });

  it("omits every LIVE prior auto-refine draft", () => {
    const drafts = buildOmissionDrafts([live("e1"), live("e2")]);
    expect(drafts).toEqual([
      { type: "context_edit", targetId: "e1", replacement: null },
      { type: "context_edit", targetId: "e2", replacement: null },
    ]);
  });

  it("skips already-omitted drafts (idempotent, never stacks edits)", () => {
    expect(buildOmissionDrafts([omitted("e1")])).toEqual([]);
    expect(buildOmissionDrafts([live("e1"), omitted("e2")])).toEqual([
      { type: "context_edit", targetId: "e1", replacement: null },
    ]);
  });

  it("ignores other custom messages, plain entries, and id-less drafts", () => {
    const other: ProjectedLike[] = [
      { sourceEntry: { type: "custom_message", customType: "something-else", id: "e3" }, messages: [{}] },
      { sourceEntry: { type: "custom", customType: "harness-state", id: "e4" }, messages: [] },
      { sourceEntry: { type: "custom_message", customType: "harness.auto-refine-request" }, messages: [{}] },
      {},
    ];
    expect(buildOmissionDrafts(other)).toEqual([]);
  });
});

describe("evaluateAutoRefine", () => {
  beforeEach(resetAutoRefine);

  it("never fires when disabled (the default)", () => {
    const disabled = cfg({ autoRefine: { enabled: false, everyTurns: 10 } });
    for (let i = 0; i < 60; i++) {
      expect(evaluateAutoRefine(disabled, i)).toBe(false);
    }
  });

  it("seeds a baseline, then fires exactly every N turns", () => {
    const enabled = cfg({ autoRefine: { enabled: true, everyTurns: 10 } });
    expect(evaluateAutoRefine(enabled, 0)).toBe(false); // seed baseline at 0
    expect(evaluateAutoRefine(enabled, 9)).toBe(false);
    expect(evaluateAutoRefine(enabled, 10)).toBe(true); // first fire
    expect(evaluateAutoRefine(enabled, 11)).toBe(false);
    expect(evaluateAutoRefine(enabled, 19)).toBe(false);
    expect(evaluateAutoRefine(enabled, 20)).toBe(true); // second fire, cadence resets
  });

  it("never fires when everyTurns <= 0", () => {
    const zero = cfg({ autoRefine: { enabled: true, everyTurns: 0 } });
    expect(evaluateAutoRefine(zero, 0)).toBe(false);
    expect(evaluateAutoRefine(zero, 10000)).toBe(false);
  });

  it("falls back to the default cadence (100) when everyTurns is absent", () => {
    const noEvery = cfg({ autoRefine: { enabled: true } });
    expect(evaluateAutoRefine(noEvery, 0)).toBe(false); // seed
    expect(evaluateAutoRefine(noEvery, 99)).toBe(false);
    expect(evaluateAutoRefine(noEvery, 100)).toBe(true); // default 100
  });
});

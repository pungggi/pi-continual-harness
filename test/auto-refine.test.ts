import { describe, it, expect, beforeEach } from "vitest";
import {
  buildOmissionDrafts,
  evaluateAutoRefine,
  resetAutoRefine,
  turnEndedBadly,
  type ProjectedLike,
} from "../src/auto-refine.js";
import type { HarnessConfig } from "../src/config.js";

const cfg = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
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
      {
        sourceEntry: { type: "custom_message", customType: "something-else", id: "e3" },
        messages: [{}],
      },
      { sourceEntry: { type: "custom", customType: "harness-state", id: "e4" }, messages: [] },
      {
        sourceEntry: { type: "custom_message", customType: "harness.auto-refine-request" },
        messages: [{}],
      },
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
      expect(evaluateAutoRefine(disabled)).toBe(false);
    }
  });

  it("seeds a baseline, then fires exactly every N completed turns", () => {
    const enabled = cfg({ autoRefine: { enabled: true, everyTurns: 10 } });
    expect(evaluateAutoRefine(enabled)).toBe(false); // seed (doesn't count)
    for (let n = 1; n < 10; n++) expect(evaluateAutoRefine(enabled)).toBe(false);
    expect(evaluateAutoRefine(enabled)).toBe(true); // 10th completed turn
    for (let n = 1; n < 10; n++) expect(evaluateAutoRefine(enabled)).toBe(false);
    expect(evaluateAutoRefine(enabled)).toBe(true); // second fire, cadence resets
  });

  it("never fires when everyTurns <= 0", () => {
    const zero = cfg({ autoRefine: { enabled: true, everyTurns: 0 } });
    for (let i = 0; i < 5; i++) {
      expect(evaluateAutoRefine(zero)).toBe(false);
    }
  });

  it("falls back to the default cadence (100) when everyTurns is absent", () => {
    const noEvery = cfg({ autoRefine: { enabled: true } });
    expect(evaluateAutoRefine(noEvery)).toBe(false); // seed
    for (let n = 1; n < 100; n++) expect(evaluateAutoRefine(noEvery)).toBe(false);
    expect(evaluateAutoRefine(noEvery)).toBe(true); // default 100
  });

  it("aborted/error turns neither seed nor advance the completed-turn count", () => {
    const enabled = cfg({ autoRefine: { enabled: true, everyTurns: 2 } });
    // The review's exact scenario: completed(0), aborted(1), completed(2)
    // must NOT fire — only one completed turn elapsed since the seed. (Raw
    // turnIndex arithmetic would wrongly fire on the 2.) With counting it
    // takes a second COMPLETED turn:
    expect(evaluateAutoRefine(enabled)).toBe(false); // seed (completed 0)
    expect(evaluateAutoRefine(enabled, "aborted")).toBe(false); // skipped
    expect(evaluateAutoRefine(enabled)).toBe(false); // 1st completed — no fire
    expect(evaluateAutoRefine(enabled, "error")).toBe(false); // skipped
    expect(evaluateAutoRefine(enabled)).toBe(true); // 2nd completed — fire
    // Undefined outcome is treated as completed (synthetic / early 0.99.x).
    expect(evaluateAutoRefine(enabled, undefined)).toBe(false); // count reset
    expect(evaluateAutoRefine(enabled, undefined)).toBe(true);
  });
});

describe("turnEndedBadly", () => {
  it("is true only for aborted and error outcomes", () => {
    expect(turnEndedBadly("aborted")).toBe(true);
    expect(turnEndedBadly("error")).toBe(true);
    expect(turnEndedBadly("completed")).toBe(false);
    expect(turnEndedBadly(undefined)).toBe(false);
  });
});

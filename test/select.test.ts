// Unit tests for the injection selection policy (src/select.ts).
//
// Selection is ON BY DEFAULT, so the highest-value tests here pin the policy:
//   - filter (active + owner)            - importance-ordered, stable ties
//   - maxPerKind cap                      - maxTokens budget (round-robin, skip-not-stop)
//   - opt-out (enabled:false → legacy)    - normalizeInjection coercion

import { describe, it, expect } from "vitest";
import {
  DEFAULT_INJECTION,
  estimateTokens,
  normalizeInjection,
  selectForInjection,
} from "../src/select.js";
import type { HarnessItem } from "../src/types.js";

let n = 0;
/** Build a HarnessItem with sane defaults; only the interesting fields need setting. */
function item(partial: Partial<HarnessItem> & Pick<HarnessItem, "kind" | "content">): HarnessItem {
  n += 1;
  return {
    id: `h_${n}`,
    evidence: "e",
    importance: 0.5,
    active: true,
    ownerModel: "anthropic/sonnet",
    createdAt: n,
    updatedAt: n,
    ...partial,
  };
}

describe("normalizeInjection", () => {
  it("returns the shipped defaults when given nothing", () => {
    expect(normalizeInjection()).toEqual(DEFAULT_INJECTION);
    expect(normalizeInjection({})).toEqual(DEFAULT_INJECTION);
  });

  it("passes valid values through", () => {
    expect(normalizeInjection({ maxTokens: 500, maxPerKind: 3, charsPerToken: 3 })).toEqual({
      enabled: true,
      maxTokens: 500,
      maxPerKind: 3,
      charsPerToken: 3,
    });
  });

  it("honors enabled: false (the opt-out)", () => {
    expect(normalizeInjection({ enabled: false }).enabled).toBe(false);
  });

  it("coerces bad numeric values back to defaults (no NaN / no <=0 leaks)", () => {
    expect(normalizeInjection({ maxTokens: "big" as unknown as number })).toEqual(DEFAULT_INJECTION);
    expect(normalizeInjection({ maxTokens: NaN })).toEqual(DEFAULT_INJECTION);
    expect(normalizeInjection({ maxTokens: 0 })).toEqual(DEFAULT_INJECTION);
    expect(normalizeInjection({ maxTokens: -10 })).toEqual(DEFAULT_INJECTION);
    expect(normalizeInjection({ maxPerKind: "x" as unknown as number }).maxPerKind).toBe(10);
    expect(normalizeInjection({ charsPerToken: 0 }).charsPerToken).toBe(4);
  });

  it("ignores a non-boolean enabled (falls back to default true)", () => {
    expect(normalizeInjection({ enabled: "yes" as unknown as boolean }).enabled).toBe(true);
  });
});

describe("estimateTokens", () => {
  it("ceil-divides length by charsPerToken (default 4)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("abcd", 2)).toBe(2);
  });
});

describe("selectForInjection — filter + order", () => {
  it("returns nothing for an empty store", () => {
    const r = selectForInjection([], "anthropic/sonnet");
    expect(r.selected).toEqual([]);
    expect(r.omitted).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("keeps only active items bound to the active model", () => {
    const items = [
      item({ kind: "prompt", content: "mine-active" }),
      item({ kind: "prompt", content: "inactive", active: false }),
      item({ kind: "prompt", content: "other-model", ownerModel: "google/gemini" }),
    ];
    const r = selectForInjection(items, "anthropic/sonnet");
    expect(r.selected.map((i) => i.content)).toEqual(["mine-active"]);
    // wrong-model + inactive are not "omitted by the policy" — they were never candidates.
    expect(r.omitted).toBe(0);
  });

  it("orders by importance desc within a kind, highest first", () => {
    const items = [
      item({ kind: "prompt", content: "low", importance: 0.2 }),
      item({ kind: "prompt", content: "high", importance: 0.9 }),
      item({ kind: "prompt", content: "mid", importance: 0.5 }),
    ];
    const r = selectForInjection(items, "anthropic/sonnet");
    expect(r.selected.map((i) => i.content)).toEqual(["high", "mid", "low"]);
  });

  it("breaks importance ties by store order (stable)", () => {
    const items = [
      item({ kind: "prompt", content: "first", importance: 0.8 }),
      item({ kind: "prompt", content: "second", importance: 0.8 }),
      item({ kind: "prompt", content: "third", importance: 0.8 }),
    ];
    const r = selectForInjection(items, "anthropic/sonnet");
    expect(r.selected.map((i) => i.content)).toEqual(["first", "second", "third"]);
  });

  it("groups survivors by canonical kind order across mixed kinds", () => {
    const items = [
      item({ kind: "subagent", content: "sub" }),
      item({ kind: "memory", content: "mem" }),
      item({ kind: "prompt", content: "pmt" }),
      item({ kind: "skill", content: "skl" }),
    ];
    const r = selectForInjection(items, "anthropic/sonnet");
    expect(r.selected.map((i) => i.kind)).toEqual(["prompt", "memory", "skill", "subagent"]);
  });
});

describe("selectForInjection — caps", () => {
  it("maxPerKind drops the lowest-importance items in each kind", () => {
    const items = [
      item({ kind: "prompt", content: "a", importance: 0.9 }),
      item({ kind: "prompt", content: "b", importance: 0.5 }),
      item({ kind: "prompt", content: "c", importance: 0.2 }),
    ];
    const r = selectForInjection(items, "anthropic/sonnet", { maxPerKind: 2 });
    expect(r.selected.map((i) => i.content)).toEqual(["a", "b"]);
    expect(r.omitted).toBe(1);
    expect(r.truncated).toBe(true);
  });

  it("maxPerKind applies independently per kind (balanced sections)", () => {
    const items = [
      item({ kind: "prompt", content: "p1", importance: 0.9 }),
      item({ kind: "prompt", content: "p2", importance: 0.8 }),
      item({ kind: "memory", content: "m1", importance: 0.7 }),
      item({ kind: "memory", content: "m2", importance: 0.6 }),
    ];
    const r = selectForInjection(items, "anthropic/sonnet", { maxPerKind: 1 });
    // top-1 of each kind survives
    expect(r.selected.map((i) => i.content)).toEqual(["p1", "m1"]);
    expect(r.omitted).toBe(2);
  });

  it("maxTokens trims by importance (round-robin across kinds), not kind by kind", () => {
    // Long content (~50 tokens/line) so the budget bites clearly. With a budget
    // that fits exactly the two rank-0 items, round-robin keeps BOTH high-
    // importance items (one per kind); a kind-by-kind fill would instead keep
    // both prompt items. Asserting {p-hi, m-hi} survive and {p-lo, m-lo} don't
    // is what distinguishes the round-robin policy.
    const big = (tag: string) => `${tag}:${"x".repeat(200)}`;
    const items = [
      item({ kind: "prompt", content: big("p-hi"), importance: 0.9 }),
      item({ kind: "prompt", content: big("p-lo"), importance: 0.1 }),
      item({ kind: "memory", content: big("m-hi"), importance: 0.8 }),
      item({ kind: "memory", content: big("m-lo"), importance: 0.2 }),
    ];
    const r = selectForInjection(items, "anthropic/sonnet", { maxPerKind: 99, maxTokens: 210 });
    const tags = r.selected.map((i) => i.content.split(":")[0]);
    expect(tags).toContain("p-hi");
    expect(tags).toContain("m-hi");
    expect(tags).not.toContain("p-lo");
    expect(tags).not.toContain("m-lo");
    expect(r.omitted).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it("maxTokens skips (does not hard-stop on) an item that doesn't fit", () => {
    // A huge high-importance item that alone exceeds the remaining budget, plus a
    // tiny low-importance item that still fits after it. The tiny one is taken
    // (skip-not-stop); the huge one is dropped.
    const huge = "x".repeat(2000);
    const items = [
      item({ kind: "prompt", content: huge, importance: 0.99 }),
      item({ kind: "prompt", content: "tiny", importance: 0.1 }),
    ];
    const r = selectForInjection(items, "anthropic/sonnet", { maxPerKind: 99, maxTokens: 400 });
    const contents = r.selected.map((i) => i.content);
    expect(contents).toContain("tiny");
    expect(contents).not.toContain(huge);
    expect(r.omitted).toBe(1);
  });
});

describe("selectForInjection — opt-out (legacy mode)", () => {
  it("enabled:false returns every active item for the model in STORE order", () => {
    // Inserted out of importance order; legacy must preserve insertion order,
    // NOT re-sort by importance.
    const items = [
      item({ kind: "prompt", content: "low-first", importance: 0.1 }),
      item({ kind: "prompt", content: "high-second", importance: 0.9 }),
      item({ kind: "memory", content: "mem", importance: 0.2 }),
    ];
    const r = selectForInjection(items, "anthropic/sonnet", { enabled: false });
    expect(r.selected.map((i) => i.content)).toEqual(["low-first", "high-second", "mem"]);
    expect(r.omitted).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("enabled:false ignores maxPerKind / maxTokens entirely", () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      item({ kind: "prompt", content: `n${i}`, importance: 0.1 * i }),
    );
    const r = selectForInjection(items, "anthropic/sonnet", {
      enabled: false,
      maxPerKind: 1,
      maxTokens: 10,
    });
    expect(r.selected).toHaveLength(20);
    expect(r.omitted).toBe(0);
  });
});

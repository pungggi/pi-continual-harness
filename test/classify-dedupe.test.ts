// Classifier-confirmed dedupe (pi ≥ 0.99, opt-in via classifier.model). The
// shipped `dedupe` proposer recall-widens its candidate pass and then confirms
// pairs with ONE batched yes/no classify call. Pins:
//  - buildPairQuestions / confirmGroups (pure) — cap + conservative missing
//  - dedupeProposer with classify injected — confirm, deny, error-fallback,
//    and the identical-behavior guarantee when NO classify is injected.

import { describe, it, expect } from "vitest";
import {
  buildPairQuestions,
  CLASSIFIER_MAX_PAIRS,
  confirmGroups,
  dedupeProposer,
  planDedupePairs,
  type DedupeGroup,
} from "../src/proposer.js";
import type { HarnessItem, HarnessState } from "../src/types.js";
import type { ClassifyBoolResult, ClassifyFn } from "../src/classify.js";

function item(id: string, content: string, importance = 0.5): HarnessItem {
  return {
    id,
    kind: "prompt",
    content,
    evidence: `e-${id}`,
    importance,
    active: true,
    ownerModel: "test/main",
    createdAt: 1,
    updatedAt: 1,
  };
}

const state = (items: HarnessItem[]): HarnessState => ({ items });

function classifyReturning(answers: Record<string, { value: boolean }>, ok = true): ClassifyFn {
  return async () =>
    ({
      ok,
      answers,
      model: "typesafe/jev-latest",
      ...(ok ? {} : { error: "boom" }),
    }) as ClassifyBoolResult;
}

describe("buildPairQuestions + confirmGroups (pure)", () => {
  it("keys questions p0..pN over flatMap(pair) order with pair texts in state", () => {
    const { state: s, questions } = buildPairQuestions([
      { keeper: item("h_1", "keeper one"), dup: item("h_2", "dup one") },
      { keeper: item("h_3", "keeper two"), dup: item("h_4", "dup two") },
    ]);
    expect(Object.keys(questions)).toEqual(["p0", "p1"]);
    expect((s.pairs as Array<{ keeper: string; duplicate: string }>)[0]).toEqual({
      index: 0,
      keeper: "keeper one",
      duplicate: "dup one",
    });
  });

  it("keeps only confirmed pairs; missing answers and pairs beyond the cap stay out", () => {
    const groups: DedupeGroup[] = [
      { keeper: item("h_1", "k1"), absorbed: [{ dup: item("h_2", "d2"), overlap: 0.7 }, { dup: item("h_3", "d3"), overlap: 0.6 }] },
      { keeper: item("h_4", "k4"), absorbed: [{ dup: item("h_5", "d5"), overlap: 0.65 }] },
    ];
    // confirm p0 only
    const out = confirmGroups(groups, { p0: { value: true } });
    expect(out).toHaveLength(1);
    expect(out[0]!.absorbed.map((a) => a.dup.id)).toEqual(["h_2"]);
    // missing answer for p1/p2 → dropped (conservative)
    // cap=0 → everything beyond question 0 dropped
    expect(confirmGroups(groups, { p0: { value: true } }, 0)).toHaveLength(0);
  });
});

describe("dedupeProposer with a classifier", () => {
  const nearDups = state([
    item("h_1", "always run pnpm install here", 0.9),
    item("h_2", "always run pnpm install in this repo", 0.5),
  ]);

  it("confirms a candidate the classifier marks redundant (recall-widened below threshold)", async () => {
    // Token overlap of these two is BELOW the default 0.6 threshold; the
    // recall-widened candidate pass (0.6-0.15=0.45) surfaces the pair and the
    // classifier confirms it.
    const res = await dedupeProposer.propose({
      evidence: "",
      state: nearDups,
      lookback: 25,
      classify: classifyReturning({ p0: { value: true } }),
    });
    expect(res.deltas?.some((d) => d.delta.op === "delete" && d.delta.id === "h_2")).toBe(true);
    expect(res.modelCall?.ok).toBe(true);
    expect(res.modelCall?.model).toBe("typesafe/jev-latest");
  });

  it("drops a candidate the classifier denies", async () => {
    const res = await dedupeProposer.propose({
      evidence: "",
      state: nearDups,
      lookback: 25,
      classify: classifyReturning({ p0: { value: false } }),
    });
    expect(res.deltas ?? []).toHaveLength(0);
  });

  it("falls back to the plain rule-based plan when the classifier errors (narrow, never block)", async () => {
    const clearDup = state([
      item("h_1", "always run pnpm install here", 0.9),
      item("h_2", "always run pnpm install here", 0.5), // identical → above threshold
    ]);
    const res = await dedupeProposer.propose({
      evidence: "",
      state: clearDup,
      lookback: 25,
      classify: classifyReturning({}, false),
    });
    expect(res.deltas?.some((d) => d.delta.op === "delete" && d.delta.id === "h_2")).toBe(true);
    expect(res.modelCall?.ok).toBe(false);
    expect(res.modelCall?.error).toBe("boom");
  });

  it("without classify the behavior is exactly the historical rule-based plan", async () => {
    const res = await dedupeProposer.propose({ evidence: "", state: nearDups, lookback: 25 });
    // nearDups is below the 0.6 threshold → nothing merges (pre-0.12 behavior)
    expect(res.deltas ?? []).toHaveLength(0);
    expect(res.modelCall).toBeUndefined();
  });

  it("caps the question set at CLASSIFIER_MAX_PAIRS", async () => {
    const many = state(
      Array.from({ length: CLASSIFIER_MAX_PAIRS + 5 }, (_, i) =>
        item(`h_${i}`, `always run pnpm install here variant ${i % 2}`, 0.9 - i * 0.001),
      ),
    );
    let seen = 0;
    const counting: ClassifyFn = async (input) => {
      seen = Object.keys(input.questions).length;
      const answers: Record<string, { value: boolean }> = {};
      for (const k of Object.keys(input.questions)) answers[k] = { value: true };
      return { ok: true, answers, model: "typesafe/jev-latest" };
    };
    await dedupeProposer.propose({ evidence: "", state: many, lookback: 25, classify: counting });
    expect(seen).toBeLessThanOrEqual(CLASSIFIER_MAX_PAIRS);
  });

  it("planDedupePairs is still the pure grouping seam (no classifier involved)", () => {
    const groups = planDedupePairs(nearDups, { threshold: 0.45, merge: true });
    expect(groups.some((g) => g.absorbed.length > 0)).toBe(true);
  });
});

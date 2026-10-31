// Tests for the harnessing-level recursion module (Harness², arXiv 2610.14224):
// refine-run classification, the auto-refine history gate, and the
// evidence-gated lessons digest.

import { describe, it, expect } from "vitest";
import {
  buildLessonsDigest,
  classifyRuns,
  isEffectiveRun,
  recentIneffectiveRuns,
} from "../src/lessons.js";
import type { HarnessItem, HarnessState } from "../src/types.js";

// ---- fixtures -------------------------------------------------------------

const refineEntry = (over: Record<string, unknown> = {}): unknown => ({
  type: "custom",
  customType: "harness-refinement",
  data: { source: "manual", proposer: "steering", applied: 0, startedAt: 1, ...over },
});

const stateEntry = (): unknown => ({
  type: "custom",
  customType: "harness-state",
  data: { state: { items: [] }, version: 1 },
});

const noiseEntry = (): unknown => ({ type: "message", message: { role: "user", content: "hi" } });

function item(over: Partial<HarnessItem>): HarnessItem {
  return {
    id: "h_x",
    kind: "memory",
    content: "some fact",
    evidence: "e",
    importance: 0.5,
    active: true,
    ownerModel: "test/main",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const stateOf = (items: HarnessItem[]): HarnessState => ({ items });

// ---- run classification ---------------------------------------------------

describe("classifyRuns", () => {
  it("parses refine entries and ignores everything else", () => {
    const runs = classifyRuns([noiseEntry(), refineEntry({ applied: 2 }), noiseEntry()]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.applied).toBe(2);
    expect(runs[0]!.source).toBe("manual");
  });

  it("marks a run followed by a state mutation as effective (steering path)", () => {
    const runs = classifyRuns([refineEntry(), stateEntry()]);
    expect(runs[0]!.followedByStateChange).toBe(true);
    expect(isEffectiveRun(runs[0]!)).toBe(true);
  });

  it("a refine entry closes the previous run's window", () => {
    const runs = classifyRuns([refineEntry(), refineEntry({ applied: 1 })]);
    expect(runs).toHaveLength(2);
    // First run: no state entry before the next refine → ineffective.
    expect(isEffectiveRun(runs[0]!)).toBe(false);
    // Second run applied a delta directly (dedupe path) → effective.
    expect(isEffectiveRun(runs[1]!)).toBe(true);
  });

  it("does not mis-credit the next run's direct-apply snapshot to the previous run (review r4341960980)", () => {
    // runRefine writes a direct-apply run's harness-state snapshot BEFORE its
    // own audit entry — a no-op steering run followed by a successful dedupe
    // must count as exactly ONE productive run, not two.
    const entries = [refineEntry({ applied: 0 }), stateEntry(), refineEntry({ applied: 1 })];
    const runs = classifyRuns(entries);
    expect(runs).toHaveLength(2);
    expect(isEffectiveRun(runs[0]!)).toBe(false); // its window's state entry belongs to run 2
    expect(isEffectiveRun(runs[1]!)).toBe(true); // applied: 1
    expect(recentIneffectiveRuns(entries, 1)).toBe(false); // gate stays open on the effective run
  });

  it("still credits a genuine steering mutation between two no-op runs", () => {
    const runs = classifyRuns([
      refineEntry({ applied: 0 }),
      stateEntry(),
      refineEntry({ applied: 0 }),
    ]);
    expect(runs[0]!.followedByStateChange).toBe(true); // no direct-apply next → the entry is the steering mutation
    expect(isEffectiveRun(runs[0]!)).toBe(true);
  });

  it("tolerates malformed entries instead of throwing", () => {
    const runs = classifyRuns([
      { type: "custom", customType: "harness-refinement" },
      { type: "custom" },
      null,
      42,
    ]);
    expect(runs).toHaveLength(1);
    expect(isEffectiveRun(runs[0]!)).toBe(false);
  });
});

// ---- history gate ---------------------------------------------------------

describe("recentIneffectiveRuns", () => {
  it("is off when n <= 0", () => {
    const entries = [refineEntry(), refineEntry(), refineEntry()];
    expect(recentIneffectiveRuns(entries, 0)).toBe(false);
    expect(recentIneffectiveRuns(entries, -1)).toBe(false);
  });

  it("never gates an empty branch or a branch with fewer runs than n", () => {
    expect(recentIneffectiveRuns([], 3)).toBe(false);
    expect(recentIneffectiveRuns([refineEntry(), refineEntry()], 3)).toBe(false);
  });

  it("gates when the last n runs were ALL ineffective", () => {
    const entries = [refineEntry(), refineEntry(), refineEntry()];
    expect(recentIneffectiveRuns(entries, 3)).toBe(true);
    expect(recentIneffectiveRuns(entries, 2)).toBe(true);
  });

  it("does not gate when any run in the window was effective", () => {
    const entries = [refineEntry(), refineEntry(), stateEntry(), refineEntry()];
    // Window of 2: [effective(via state), ineffective] → no gate.
    expect(recentIneffectiveRuns(entries, 2)).toBe(false);
    // Window of 1: just the last ineffective run → gate.
    expect(recentIneffectiveRuns(entries, 1)).toBe(true);
  });

  it("an old effective run does not lift the gate once the window is past it", () => {
    const entries = [refineEntry({ applied: 1 }), refineEntry(), refineEntry(), refineEntry()];
    expect(recentIneffectiveRuns(entries, 3)).toBe(true);
  });
});

// ---- lessons digest -------------------------------------------------------

describe("buildLessonsDigest", () => {
  it("is empty when there is nothing supportable to say (fresh store, no runs)", () => {
    expect(buildLessonsDigest(stateOf([]), [])).toBe("");
  });

  it("lists cited items as proven useful (organic signal)", () => {
    const s = stateOf([
      item({
        id: "h_a",
        content: "always run tests before pushing",
        support: { citations: 3, lastCitedAt: 2 },
      }),
    ]);
    const digest = buildLessonsDigest(s, []);
    expect(digest).toContain("## Lessons from past refines");
    expect(digest).toContain("Proven useful");
    expect(digest).toContain("[h_a] (cited 3×)");
    expect(digest).toContain("always run tests before pushing");
  });

  it("lists kept items as proven useful (human signal)", () => {
    const s = stateOf([item({ id: "h_b", support: { keeps: 2 } })]);
    expect(buildLessonsDigest(s, [])).toContain("[h_b] (kept 2×)");
  });

  it("names dropped-without-use items as rejected signals", () => {
    const s = stateOf([
      item({ id: "h_c", content: "use the staging endpoint", support: { drops: 2 } }),
      item({
        id: "h_d",
        content: "neutral item with drops but more citations",
        support: { drops: 1, citations: 2 },
      }),
    ]);
    const digest = buildLessonsDigest(s, []);
    expect(digest).toContain("Rejected signals");
    expect(digest).toContain("[h_c] (dropped 2×)");
    // h_d's citations outweigh the drop → it belongs on the supported side.
    expect(digest).not.toContain("[h_d] (dropped");
    expect(digest).toContain("[h_d]");
  });

  it("an item dropped then cited afterwards is contested, not rejected (review r4341960962)", () => {
    const s = stateOf([
      item({
        id: "h_flip",
        content: "dropped once, then actually used",
        support: { drops: 1, citations: 1, lastCitedAt: 99 },
      }),
    ]);
    const digest = buildLessonsDigest(s, []);
    // Net-neutral: neither proven useful (score 0) nor rejected (not < 0) —
    // later execution evidence outranks a single stale drop.
    expect(digest).not.toContain("Rejected signals");
    expect(digest).not.toContain("[h_flip]");
    expect(digest).toBe("");
  });

  it("names only the ACTIVE MODEL's items when ownerKey is given (review r4341960955)", () => {
    const s = stateOf([
      item({ id: "h_mine", ownerModel: "test/main", support: { citations: 2 } }),
      item({ id: "h_foreign", ownerModel: "other/model", support: { citations: 9, drops: 3 } }),
    ]);
    const digest = buildLessonsDigest(s, [], { ownerKey: "test/main" });
    expect(digest).toContain("[h_mine]");
    expect(digest).not.toContain("h_foreign");
    // Unknown owner ("" = orphan-only view): foreign + owned items hidden.
    expect(buildLessonsDigest(s, [], { ownerKey: "" })).toBe("");
    // No ownerKey → caller opted out of the filter (e.g. /harness lessons).
    expect(buildLessonsDigest(s, [])).toContain("h_foreign");
  });

  it("never names never-cited-never-dropped items (no signal is not a negative signal)", () => {
    const s = stateOf([item({ id: "h_quiet", content: "unsupported but harmless" })]);
    expect(buildLessonsDigest(s, [])).toBe("");
  });

  it("ignores inactive items entirely", () => {
    const s = stateOf([item({ id: "h_off", active: false, support: { citations: 5 } })]);
    expect(buildLessonsDigest(s, [])).toBe("");
  });

  it("summarizes refine history: all-effective vs. no-op-heavy", () => {
    const effective = buildLessonsDigest(stateOf([]), [
      refineEntry({ applied: 1 }),
      refineEntry({ applied: 2 }),
    ]);
    expect(effective).toContain("all 2 recent run(s) produced durable deltas");
    const noisy = buildLessonsDigest(stateOf([]), [
      refineEntry({ applied: 1 }),
      refineEntry(),
      refineEntry(),
    ]);
    expect(noisy).toContain("2 of the last 3 run(s) proposed nothing durable");
  });

  it("orders supported items by signal strength and caps the list", () => {
    const s = stateOf([
      item({ id: "h_1", support: { citations: 1 } }),
      item({ id: "h_2", support: { citations: 9 } }),
      item({ id: "h_3", support: { citations: 5 } }),
    ]);
    const digest = buildLessonsDigest(s, [], { maxSupported: 2 });
    const i2 = digest.indexOf("[h_2]");
    const i3 = digest.indexOf("[h_3]");
    expect(i2).toBeGreaterThan(-1);
    expect(i3).toBeGreaterThan(-1);
    expect(i2).toBeLessThan(i3);
    expect(digest).not.toContain("[h_1]");
  });

  it("respects the hard character cap (keeps the header, drops trailing sections)", () => {
    const s = stateOf([item({ id: "h_a", support: { citations: 1 } })]);
    const digest = buildLessonsDigest(s, [refineEntry()], { maxChars: 80 });
    expect(digest.length).toBeLessThanOrEqual(80 + 200); // header + at most one section
    expect(digest).toContain("## Lessons from past refines");
  });
});

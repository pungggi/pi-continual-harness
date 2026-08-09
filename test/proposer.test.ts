import { describe, it, expect } from "vitest";
import type { HarnessItem, HarnessState } from "../src/types.js";
import {
  DEDUPE_THRESHOLD,
  dedupeProposer,
  getProposer,
  listProposers,
  registerProposer,
  steeringProposer,
  tokenOverlap,
  tokenize,
} from "../src/proposer.js";

function item(over: Partial<HarnessItem> & Pick<HarnessItem, "id" | "kind" | "content">): HarnessItem {
  const now = 10_000;
  return { evidence: "e", importance: 0.5, active: true, ownerModel: "", createdAt: now, updatedAt: now, ...over };
}

const state = (items: HarnessItem[]): HarnessState => ({ items });

describe("tokenize + tokenOverlap", () => {
  it("is punctuation- and case-insensitive", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
    expect(tokenOverlap("Hello, World!", "hello world")).toBe(1);
  });

  it("is 1.0 for identical text, 0 for disjoint", () => {
    expect(tokenOverlap("the cat sat", "the cat sat")).toBe(1);
    expect(tokenOverlap("alpha beta", "gamma delta")).toBe(0);
  });

  it("returns the Jaccard index for partial overlap", () => {
    // {the,cat,sat} ∩ {the,cat,ran} = 2 ; union = 4 → 0.5
    expect(tokenOverlap("the cat sat", "the cat ran")).toBeCloseTo(0.5);
  });

  it("is 0 when either side has no tokens", () => {
    expect(tokenOverlap("", "something")).toBe(0);
  });
});

describe("dedupeProposer", () => {
  it("drops a near-duplicate, keeping the higher-importance item", async () => {
    const keep = item({ id: "h_keep", kind: "prompt", content: "always use the foo pattern", importance: 0.9 });
    const dup = item({ id: "h_dup", kind: "prompt", content: "use the foo pattern always", importance: 0.4 });
    const r = await dedupeProposer.propose({ evidence: "", state: state([dup, keep]), lookback: 10 });
    expect(r.deltas).toHaveLength(1);
    const d = r.deltas![0]!;
    expect(d.delta).toEqual({ op: "delete", id: "h_dup", reason: expect.stringMatching(/near-duplicate of h_keep/) });
    expect(d.rationale).toContain("h_keep");
  });

  it("proposes nothing for distinct items", async () => {
    const a = item({ id: "h_a", kind: "memory", content: "the api key lives in env", importance: 0.6 });
    const b = item({ id: "h_b", kind: "memory", content: "deploy via the release workflow", importance: 0.5 });
    const r = await dedupeProposer.propose({ evidence: "", state: state([a, b]), lookback: 10 });
    expect(r.deltas ?? []).toHaveLength(0);
  });

  it("ignores near-duplicates of a different kind", async () => {
    const a = item({ id: "h_a", kind: "prompt", content: "always use the foo pattern", importance: 0.9 });
    const b = item({ id: "h_b", kind: "memory", content: "always use the foo pattern", importance: 0.4 });
    const r = await dedupeProposer.propose({ evidence: "", state: state([a, b]), lookback: 10 });
    expect(r.deltas ?? []).toHaveLength(0);
  });

  it("does not dedupe near-duplicates bound to different owner models", async () => {
    // Same kind, near-identical text, but different ownerModel → both kept.
    // Per-model isolation means each model keeps its own copy.
    const a = item({ id: "h_a", kind: "prompt", content: "always use the foo pattern", importance: 0.9, ownerModel: "anthropic/sonnet" });
    const b = item({ id: "h_b", kind: "prompt", content: "use the foo pattern always", importance: 0.4, ownerModel: "google/gemini" });
    const r = await dedupeProposer.propose({ evidence: "", state: state([a, b]), lookback: 10 });
    expect(r.deltas ?? []).toHaveLength(0);
  });

  it("ignores inactive items entirely", async () => {
    const keep = item({ id: "h_keep", kind: "prompt", content: "always use the foo pattern", importance: 0.9 });
    const inactive = item({ id: "h_off", kind: "prompt", content: "use the foo pattern always", importance: 0.4, active: false });
    const r = await dedupeProposer.propose({ evidence: "", state: state([keep, inactive]), lookback: 10 });
    expect(r.deltas ?? []).toHaveLength(0);
  });

  it("is contradiction-free for a duplicate chain", async () => {
    // a≈b≈c but all compared against keepers only; a keeps, b & c both drop.
    const a = item({ id: "h_a", kind: "prompt", content: "use the foo pattern here", importance: 0.9 });
    const b = item({ id: "h_b", kind: "prompt", content: "use the foo pattern here now", importance: 0.6 });
    const c = item({ id: "h_c", kind: "prompt", content: "use the foo pattern here again", importance: 0.5 });
    const r = await dedupeProposer.propose({ evidence: "", state: state([c, b, a]), lookback: 10 });
    const dropped = (r.deltas ?? []).map((d) => d.delta).filter((d) => d.op === "delete").map((d) => (d as { id: string }).id).sort();
    expect(dropped).toEqual(["h_b", "h_c"]);
  });
});

describe("steeringProposer", () => {
  it("returns a steering message (no deltas)", async () => {
    const r = await steeringProposer.propose({ evidence: "some evidence", state: { items: [] }, lookback: 25 });
    expect(r.deltas).toBeUndefined();
    expect(r.steeringMessage).toContain("/refine");
    expect(r.steeringMessage).toContain("some evidence");
  });
});

describe("registry", () => {
  it("resolves built-in proposers and falls back to steering", () => {
    expect(getProposer("steering")).toBe(steeringProposer);
    expect(getProposer("dedupe")).toBe(dedupeProposer);
    expect(getProposer(undefined)).toBe(steeringProposer);
    expect(getProposer("does-not-exist")).toBe(steeringProposer); // safe fallback
  });

  it("lists the built-in proposers", () => {
    expect(listProposers().sort()).toEqual(["dedupe", "steering"]);
  });

  it("registerProposer adds/replaces a named proposer", async () => {
    const custom = { name: "noop", async propose() { return {}; } };
    registerProposer(custom);
    expect(getProposer("noop")).toBe(custom);
    expect(listProposers()).toContain("noop");
  });
});

describe("DEDUPE_THRESHOLD", () => {
  it("is a sane default in (0,1)", () => {
    expect(DEDUPE_THRESHOLD).toBeGreaterThan(0);
    expect(DEDUPE_THRESHOLD).toBeLessThan(1);
  });
});

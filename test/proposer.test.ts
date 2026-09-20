import { describe, it, expect } from "vitest";
import type { HarnessItem, HarnessState } from "../src/types.js";
import {
  DEDUPE_THRESHOLD,
  DEFAULT_DEDUPE,
  EVIDENCE_MERGE_CAP,
  dedupeProposer,
  getProposer,
  listProposers,
  planDedupe,
  registerProposer,
  steeringProposer,
  tokenOverlap,
  tokenize,
  type SimilarityResult,
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

describe("planDedupe (merge-capable planner)", () => {
  const mergeOn = { threshold: 0.6, merge: true };
  const mergeOff = { threshold: 0.6, merge: false };

  it("merges a near-duplicate into the keeper: update(evidence union) + delete, updates first", () => {
    const keep = item({ id: "h_keep", kind: "prompt", content: "always use the foo pattern", importance: 0.9, evidence: "seen in turn 3" });
    const dup = item({ id: "h_dup", kind: "prompt", content: "use the foo pattern always", importance: 0.4, evidence: "seen in turn 9" });
    const deltas = planDedupe(state([dup, keep]), mergeOn);
    expect(deltas).toHaveLength(2);
    // The update touches EVIDENCE ONLY — content is never prose-merged (ACE).
    expect(deltas[0]!.delta).toEqual({ op: "update", id: "h_keep", evidence: "seen in turn 3\nseen in turn 9" });
    expect(deltas[1]!.delta).toEqual({ op: "delete", id: "h_dup", reason: expect.stringMatching(/merged into h_keep \(overlap 1\.00\)/) });
    expect(deltas[1]!.rationale).toContain("h_keep");
  });

  it("one keeper absorbing two duplicates → ONE update with the 3-way union + two deletes", () => {
    const a = item({ id: "h_a", kind: "prompt", content: "use the foo pattern here", importance: 0.9, evidence: "ea" });
    const b = item({ id: "h_b", kind: "prompt", content: "use the foo pattern here now", importance: 0.6, evidence: "eb" });
    const c = item({ id: "h_c", kind: "prompt", content: "use the foo pattern here again", importance: 0.5, evidence: "ec" });
    const deltas = planDedupe(state([c, b, a]), mergeOn);
    expect(deltas).toHaveLength(3);
    // ONE update carrying the FINAL union (applyOne replaces evidence
    // wholesale — per-duplicate updates would clobber each other).
    expect(deltas[0]!.delta).toEqual({ op: "update", id: "h_a", evidence: "ea\neb\nec" });
    expect(deltas.slice(1).map((d) => d.delta)).toEqual([
      { op: "delete", id: "h_b", reason: expect.stringMatching(/merged into h_a/) },
      { op: "delete", id: "h_c", reason: expect.stringMatching(/merged into h_a/) },
    ]);
  });

  it("skips the update when the union equals the keeper's evidence (identical evidence)", () => {
    const keep = item({ id: "h_keep", kind: "prompt", content: "always use the foo pattern", importance: 0.9, evidence: "same" });
    const dup = item({ id: "h_dup", kind: "prompt", content: "use the foo pattern always", importance: 0.4, evidence: "same" });
    const deltas = planDedupe(state([dup, keep]), mergeOn);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.delta.op).toBe("delete");
  });

  it("unions evidence line-wise, dropping empty and exact-duplicate lines (keeper first)", () => {
    const keep = item({ id: "h_k", kind: "memory", content: "alpha beta gamma", importance: 0.9, evidence: "l1\n\nl2" });
    const dup = item({ id: "h_d", kind: "memory", content: "gamma beta alpha", importance: 0.4, evidence: "l2\nl3\n" });
    const deltas = planDedupe(state([dup, keep]), mergeOn);
    expect((deltas[0]!.delta as { evidence: string }).evidence).toBe("l1\nl2\nl3");
  });

  it("caps merged evidence at EVIDENCE_MERGE_CAP with a truncation marker", () => {
    const keep = item({ id: "h_k", kind: "memory", content: "alpha beta gamma", importance: 0.9, evidence: "x".repeat(1500) });
    const dup = item({ id: "h_d", kind: "memory", content: "alpha beta gamma delta", importance: 0.4, evidence: "y".repeat(1500) });
    const deltas = planDedupe(state([dup, keep]), mergeOn);
    const evidence = (deltas[0]!.delta as { evidence: string }).evidence;
    expect(evidence.endsWith("[…merged evidence truncated…]")).toBe(true);
    expect(evidence.length).toBeLessThanOrEqual(EVIDENCE_MERGE_CAP + "\n[…merged evidence truncated…]".length);
  });

  it("respects the threshold: a 0.56-overlap pair merges at 0.5, not at 0.6", () => {
    // {a..g} vs {a..e,h,i}: intersection 5, union 9 → 0.556
    const keep = item({ id: "h_k", kind: "memory", content: "a b c d e f g", importance: 0.9 });
    const dup = item({ id: "h_d", kind: "memory", content: "a b c d e h i", importance: 0.4 });
    expect(planDedupe(state([dup, keep]), { threshold: 0.6, merge: true })).toHaveLength(0);
    expect(planDedupe(state([dup, keep]), { threshold: 0.5, merge: true }).length).toBeGreaterThan(0);
  });

  it("threshold 1.0 merges only identical token sets", () => {
    const keep = item({ id: "h_k", kind: "memory", content: "hello world", importance: 0.9 });
    const reorder = item({ id: "h_r", kind: "memory", content: "world hello", importance: 0.4 });
    const extra = item({ id: "h_x", kind: "memory", content: "hello world foo", importance: 0.3 });
    const deltas = planDedupe(state([extra, reorder, keep]), { threshold: 1, merge: false });
    expect(deltas.map((d) => (d.delta as { id: string }).id)).toEqual(["h_r"]);
  });

  it("does not merge across durable layers (global vs project)", () => {
    const g = item({ id: "h_g", kind: "prompt", content: "always use the foo pattern", importance: 0.9 });
    const p = item({ id: "h_p", kind: "prompt", content: "use the foo pattern always", importance: 0.4, scope: "project", project: "proj" });
    expect(planDedupe(state([p, g]), mergeOn)).toHaveLength(0);
  });

  it("does not merge project items with different slugs; same slug merges", () => {
    const a = item({ id: "h_a", kind: "prompt", content: "always use the foo pattern", importance: 0.9, scope: "project", project: "one" });
    const b = item({ id: "h_b", kind: "prompt", content: "use the foo pattern always", importance: 0.4, scope: "project", project: "two" });
    const c = item({ id: "h_c", kind: "prompt", content: "use foo pattern always the", importance: 0.3, scope: "project", project: "one" });
    expect(planDedupe(state([b, a]), mergeOn)).toHaveLength(0);
    expect(planDedupe(state([c, a]), mergeOn).length).toBeGreaterThan(0);
  });

  it("merge:false is delete-only with the legacy reason and rationale", () => {
    const keep = item({ id: "h_keep", kind: "prompt", content: "always use the foo pattern", importance: 0.9, evidence: "t1" });
    const dup = item({ id: "h_dup", kind: "prompt", content: "use the foo pattern always", importance: 0.4, evidence: "t2" });
    const deltas = planDedupe(state([dup, keep]), mergeOff);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.delta).toEqual({ op: "delete", id: "h_dup", reason: expect.stringMatching(/near-duplicate of h_keep \(overlap 1\.00\)/) });
    expect(deltas[0]!.rationale).toContain("kept higher-importance h_keep");
  });

  it("defaults to DEFAULT_DEDUPE (merge on, shipped threshold) when opts are omitted", () => {
    const keep = item({ id: "h_keep", kind: "prompt", content: "always use the foo pattern", importance: 0.9, evidence: "t1" });
    const dup = item({ id: "h_dup", kind: "prompt", content: "use the foo pattern always", importance: 0.4, evidence: "t2" });
    expect(planDedupe(state([dup, keep]))).toEqual(planDedupe(state([dup, keep]), DEFAULT_DEDUPE));
  });

  it("accepts an injected similarity function (the semantic seam)", () => {
    const exact = (a: string, b: string): number => (a === b ? 1 : 0);
    const keep = item({ id: "h_k", kind: "memory", content: "run tests", importance: 0.9 });
    const same = item({ id: "h_s", kind: "memory", content: "run tests", importance: 0.4 });
    const similar = item({ id: "h_i", kind: "memory", content: "execute the tests", importance: 0.3 });
    const deltas = planDedupe(state([similar, same, keep]), { threshold: 0.99, merge: false, similarity: exact });
    expect(deltas.map((d) => (d.delta as { id: string }).id)).toEqual(["h_s"]);
  });
});

describe("dedupeProposer (wrapper)", () => {
  it("default (no config): merges — identical evidence degenerates to a single delete", async () => {
    const keep = item({ id: "h_keep", kind: "prompt", content: "always use the foo pattern", importance: 0.9 });
    const dup = item({ id: "h_dup", kind: "prompt", content: "use the foo pattern always", importance: 0.4 });
    const r = await dedupeProposer.propose({ evidence: "", state: state([dup, keep]), lookback: 10 });
    expect(r.deltas).toHaveLength(1);
    const d = r.deltas![0]!;
    expect(d.delta).toEqual({ op: "delete", id: "h_dup", reason: expect.stringMatching(/merged into h_keep/) });
    expect(d.rationale).toContain("h_keep");
  });

  it("threads config.dedupe through (merge:false → legacy delete-only)", async () => {
    const keep = item({ id: "h_keep", kind: "prompt", content: "always use the foo pattern", importance: 0.9, evidence: "t1" });
    const dup = item({ id: "h_dup", kind: "prompt", content: "use the foo pattern always", importance: 0.4, evidence: "t2" });
    const r = await dedupeProposer.propose({
      evidence: "",
      state: state([dup, keep]),
      lookback: 10,
      config: { dedupe: { threshold: 0.6, merge: false } },
    });
    expect(r.deltas).toHaveLength(1);
    expect((r.deltas![0]!.delta as { reason?: string }).reason).toMatch(/near-duplicate of h_keep/);
  });

  it("threads config.dedupe.threshold through", async () => {
    // 0.556-overlap pair: below the default, above 0.5
    const keep = item({ id: "h_k", kind: "memory", content: "a b c d e f g", importance: 0.9 });
    const dup = item({ id: "h_d", kind: "memory", content: "a b c d e h i", importance: 0.4 });
    const base = { evidence: "", state: state([dup, keep]), lookback: 10 } as const;
    const strict = await dedupeProposer.propose({ ...base, config: { dedupe: { threshold: 0.6, merge: false } } });
    const loose = await dedupeProposer.propose({ ...base, config: { dedupe: { threshold: 0.5, merge: false } } });
    expect(strict.deltas ?? []).toHaveLength(0);
    expect(loose.deltas ?? []).toHaveLength(1);
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

describe("similarity seam (SimilarityResult)", () => {
  const mergeOn = { threshold: 0.6, merge: true };

  it("accepts { score } objects exactly like plain numbers", () => {
    const keep = item({ id: "h_k", kind: "memory", content: "a b c d e", importance: 0.9 });
    const dup = item({ id: "h_d", kind: "memory", content: "a b c d e", importance: 0.4 });
    const deltas = planDedupe(state([dup, keep]), { ...mergeOn, similarity: () => ({ score: 0.9 }) });
    // Identical default evidence "e" → merge degenerates to a plain delete.
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.delta).toMatchObject({ op: "delete", id: "h_d" });
  });

  it("an abstaining pair is never merged, even with score ≥ threshold", () => {
    const keep = item({ id: "h_k", kind: "prompt", content: "always use the foo pattern", importance: 0.9, evidence: "e1" });
    const dup = item({ id: "h_d", kind: "prompt", content: "use the foo pattern always", importance: 0.4, evidence: "e2" });
    const deltas = planDedupe(state([dup, keep]), {
      ...mergeOn,
      similarity: () => ({ score: 0.99, abstain: true }),
    });
    expect(deltas).toHaveLength(0); // keep both — uncertainty never deletes state
  });

  it("abstain on the best keeper still allows merging into a lower-overlap keeper", () => {
    const a = item({ id: "h_a", kind: "skill", content: "alpha beta gamma", importance: 0.9, evidence: "ea" });
    const b = item({ id: "h_b", kind: "skill", content: "alpha beta delta", importance: 0.7, evidence: "eb" });
    const c = item({ id: "h_c", kind: "skill", content: "alpha beta epsilon", importance: 0.4, evidence: "ec" });
    const similarity = (x: string, y: string): number | SimilarityResult => {
      const pair = [x, y].sort().join("|");
      if (pair === "alpha beta delta|alpha beta gamma") return { score: 0.95, abstain: true }; // A~B
      if (pair === "alpha beta epsilon|alpha beta gamma") return { score: 0.95, abstain: true }; // A~C
      return { score: 0.8 }; // B~C merges
    };
    const deltas = planDedupe(state([c, b, a]), { ...mergeOn, similarity });
    // A and B both stay keepers (A abstains against everyone); C joins B.
    expect(deltas).toHaveLength(2);
    expect(deltas[0]!.delta).toMatchObject({ op: "update", id: "h_b" });
    expect(deltas[1]!.delta).toMatchObject({ op: "delete", id: "h_c", reason: expect.stringMatching(/merged into h_b/) });
  });
});

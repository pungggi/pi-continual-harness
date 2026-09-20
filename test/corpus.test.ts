import { describe, it, expect } from "vitest";
import type { HarnessItem, HarnessState } from "../src/types.js";
import {
  buildCorpus,
  NOT_DUP_FLOOR,
  parseDedupeDelete,
} from "../src/corpus.js";

function item(over: Partial<HarnessItem> & Pick<HarnessItem, "id" | "kind" | "content">): HarnessItem {
  const now = 10_000;
  return { evidence: "e", importance: 0.5, active: true, ownerModel: "", createdAt: now, updatedAt: now, ...over };
}

const stateEntry = (items: HarnessItem[]) => ({
  type: "custom",
  customType: "harness-state",
  data: { state: { items } satisfies HarnessState, version: items.length },
});

const refineEntry = (applied: unknown[], proposer = "dedupe") => ({
  type: "custom",
  customType: "harness-refinement",
  data: { proposer, applied, source: "manual" },
});

describe("parseDedupeDelete", () => {
  it("parses merge and delete-only reasons", () => {
    expect(parseDedupeDelete("merged into h_k (overlap 0.71)")).toEqual({ keeperId: "h_k", overlap: 0.71 });
    expect(parseDedupeDelete("near-duplicate of h_ab12_cd (overlap 1.00)")).toEqual({
      keeperId: "h_ab12_cd",
      overlap: 1,
    });
  });

  it("rejects foreign reasons", () => {
    expect(parseDedupeDelete("stale after import")).toBeUndefined();
    expect(parseDedupeDelete("merged into h_k (overlap 2.5)")).toBeUndefined();
  });
});

describe("buildCorpus — lifecycle", () => {
  it("classifies created/kept/cited/dropped/pruned from snapshot diffs", () => {
    const a = (imp: number) => item({ id: "h_a", kind: "prompt", content: "note a", importance: imp });
    const b = (imp: number) => item({ id: "h_b", kind: "memory", content: "fact b", importance: imp });
    const entries = [
      stateEntry([a(0.5)]), // baseline
      stateEntry([a(0.5), b(0.4)]), // created b
      stateEntry([a(0.6), b(0.4)]), // kept a (+0.1)
      stateEntry([a(0.63), b(0.4)]), // cited a (+0.03)
      stateEntry([a(0.53), b(0.25)]), // dropped a (−0.1); b's −0.15 is an explicit set → unclassified
      stateEntry([a(0.53)]), // b removed below the floor → pruned
    ];
    const { lifecycle, pairs } = buildCorpus(entries);
    expect(pairs).toHaveLength(0);
    const events = lifecycle.map((r) => `${r.event}:${r.item_kind}`);
    expect(events).toEqual(["created:memory", "kept:prompt", "cited:prompt", "dropped:prompt", "pruned:memory"]);
    // hashes, not contents, in lifecycle records
    expect(lifecycle[0]!.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(lifecycle[2]!.importance).toBeCloseTo(0.63);
  });

  it("removal above the floor is 'deleted', not 'pruned'", () => {
    const x = (imp: number) => item({ id: "h_x", kind: "skill", content: "s", importance: imp });
    const { lifecycle } = buildCorpus([stateEntry([x(0.8)]), stateEntry([])]);
    expect(lifecycle.map((r) => r.event)).toEqual(["deleted"]);
  });
});

describe("buildCorpus — dedupe pairs", () => {
  const keeper = item({ id: "h_k", kind: "prompt", content: "always use the foo pattern", importance: 0.9, evidence: "e1" });
  const dup = item({ id: "h_d", kind: "prompt", content: "use the foo pattern always", importance: 0.4, evidence: "e2" });
  const mergedKeeper = { ...keeper, evidence: "e1\ne2" };

  it("emits a dup pair from a merged dedupe run (pre snapshot supplies dup content)", () => {
    const entries = [
      stateEntry([keeper, dup]),
      stateEntry([mergedKeeper]),
      refineEntry([{ op: "delete", id: "h_d", reason: "merged into h_k (overlap 0.90)" }]),
    ];
    const { pairs, lifecycle } = buildCorpus(entries);
    expect(pairs).toHaveLength(1);
    const p = pairs[0]!;
    expect(p).toMatchObject({
      v: 1,
      kind: "dedupe_pair",
      label: "dup",
      similarity: 0.9,
      a: keeper.content,
      b: dup.content,
      source: "tokenOverlap",
    });
    expect(p.meta).toEqual({ kinds: ["prompt"], owners: ["", ""] });
    expect(p.needs_review).toBeUndefined();
    // the delete also shows up as a lifecycle event (honest, by design)
    expect(lifecycle.map((r) => r.event)).toEqual(["deleted"]);
  });

  it("emits not_dup candidates from a no-merge run, needs_review set, deduped across runs", () => {
    const x = item({ id: "h_x", kind: "memory", content: "a b c d e f", importance: 0.9 });
    const y = item({ id: "h_y", kind: "memory", content: "a b c d g h", importance: 0.5 }); // overlap 0.5
    const z = item({ id: "h_z", kind: "memory", content: "q r s t u v", importance: 0.3 }); // disjoint → skipped
    const noMerge = [stateEntry([x, y, z]), stateEntry([x, y, z]), refineEntry([])];
    const { pairs } = buildCorpus([...noMerge, ...noMerge]); // same run twice → one record
    expect(pairs).toHaveLength(1);
    const p = pairs[0]!;
    expect(p).toMatchObject({ label: "not_dup", needs_review: true, similarity: 0.5 });
    expect(p.a).toBe(x.content);
    expect(p.b).toBe(y.content);
    expect(NOT_DUP_FLOOR).toBeGreaterThan(0);
  });

  it("ignores non-dedupe refinement runs and cross-key-field pairs", () => {
    const a1 = item({ id: "h_1", kind: "prompt", content: "a b c d e f", importance: 0.9 });
    const a2 = item({ id: "h_2", kind: "memory", content: "a b c d e f", importance: 0.5 }); // different kind
    const a3 = item({ id: "h_3", kind: "prompt", content: "a b c d g h", importance: 0.4, ownerModel: "other/model" });
    const { pairs } = buildCorpus([
      stateEntry([a1, a2, a3]),
      stateEntry([a1, a2, a3]),
      refineEntry([], "steering"), // steering runs are not dedupe evidence
    ]);
    expect(pairs).toHaveLength(0);
  });
});

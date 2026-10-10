// /harness adopt (issue #21) — audited, agent-filtered cross-model adoption.
//
// Covers the three acceptance criteria:
//  1. handler + --from value completion from store owners,
//  2. pure buildAdoptPrompt / selectAdoptSource incl. empty-store /
//     unknown-model guards and the batch cap,
//  3. store-level: creates stamped to the ACTIVE model, source items
//     untouched (adopt is copy, not move).

import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import continualHarness, { ADOPT_BATCH_CAP, buildAdoptPrompt, selectAdoptSource } from "../src/index.js";
import { applyDeltas, getState, reconstruct, setActiveModelKey } from "../src/store.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import type { Delta, HarnessItem } from "../src/types.js";
import { makeFakePi } from "./helpers.js";

async function reset(): Promise<void> {
  reconstruct([]);
  setActiveModelKey(undefined);
  resetConfigCache();
  await loadConfig(join(tmpdir(), `pi-ch-test-no-config-${Date.now()}.json`));
}

/** A HarnessItem-shaped fixture (only the fields adopt reads). */
function item(partial: Partial<HarnessItem> & { content: string }): HarnessItem {
  return {
    id: partial.id ?? `h_${partial.content.slice(0, 6)}`,
    kind: partial.kind ?? "memory",
    evidence: partial.evidence ?? "e",
    importance: partial.importance ?? 0.5,
    active: partial.active ?? true,
    ownerModel: partial.ownerModel ?? "",
    scope: partial.scope ?? "global",
    createdAt: 1,
    updatedAt: 1,
    content: partial.content,
    ...(partial.project ? { project: partial.project } : {}),
  };
}

describe("selectAdoptSource — filter, importance order, batch cap", () => {
  it("keeps only active items, importance desc, ties stable on input order", () => {
    const picked = selectAdoptSource([
      item({ content: "low", importance: 0.3 }),
      item({ content: "inactive-high", importance: 0.9, active: false }),
      item({ content: "tie-a", importance: 0.7 }),
      item({ content: "high", importance: 0.9 }),
      item({ content: "tie-b", importance: 0.7 }),
    ]);
    expect(picked.map((i) => i.content)).toEqual(["high", "tie-a", "tie-b", "low"]);
  });

  it("caps the batch to ADOPT_BATCH_CAP (highest importance first)", () => {
    const many = Array.from({ length: ADOPT_BATCH_CAP + 25 }, (_, n) =>
      item({ content: `c${n}`, importance: n / 100 }),
    );
    const picked = selectAdoptSource(many);
    expect(picked).toHaveLength(ADOPT_BATCH_CAP);
    // the cap keeps the MOST important items, not the first ones
    expect(picked[0]!.content).toBe(`c${ADOPT_BATCH_CAP + 24}`);
    expect(picked.at(-1)!.content).toBe(`c${ADOPT_BATCH_CAP + 5}`);
  });

  it("the cap matches harness_mutate's per-call delta limit (ONE batch)", async () => {
    const { pi, tools } = makeFakePi([]);
    continualHarness(pi);
    const schema = (tools.get("harness_mutate")!.parameters as {
      properties: { deltas: { maxItems?: number } };
    }).properties.deltas;
    expect(schema?.maxItems).toBe(ADOPT_BATCH_CAP);
  });
});

describe("buildAdoptPrompt — pure steering builder", () => {
  const items = [
    item({ id: "h_src1", content: "prefer splice-free rewrites", evidence: "review #42", kind: "prompt", importance: 0.62 }),
    item({ id: "h_src2", content: "PS7 path quirk", evidence: "saw it twice", scope: "project", project: "relay" }),
  ];

  it("lists every item verbatim with kind/importance/scope and evidence", () => {
    const msg = buildAdoptPrompt(items, "anthropic/claude");
    expect(msg).toContain("2 item(s) up for adoption from anthropic/claude");
    expect(msg).toContain("h_src1");
    expect(msg).toContain("prefer splice-free rewrites"); // content verbatim
    expect(msg).toContain("h_src2");
    expect(msg).toContain('project "relay"');
    expect(msg).toContain("evidence: review #42");
    expect(msg).toContain("evidence: saw it twice");
  });

  it("steers generalizes-vs-stays with ONE harness_mutate create batch (copy, stamped, annotated)", () => {
    const msg = buildAdoptPrompt(items, "anthropic/claude");
    expect(msg).toContain("generalizes");
    expect(msg).toContain("stays");
    expect(msg).toContain("harness_mutate");
    expect(msg).toContain("(adopted from anthropic/claude)"); // evidence annotation
    expect(msg).toContain("COPY, not move");
    expect(msg).toContain("Never set ownerModel"); // stamped server-side → active model
    expect(msg).toContain("copied verbatim");
    expect(msg).toContain("/refine --proposer dedupe"); // the cleanup pass
  });

  it("--all skips the filter and adopts everything", () => {
    const msg = buildAdoptPrompt(items, "anthropic/claude", { all: true });
    expect(msg).toContain("/harness adopt --all");
    expect(msg).not.toContain("generalizes");
    expect(msg).not.toContain("stays");
    expect(msg).toContain("adopt EVERY item");
    // the copy discipline is identical without the filter
    expect(msg).toContain("COPY, not move");
    expect(msg).toContain("(adopted from anthropic/claude)");
  });
});

describe("/harness adopt handler — guards", () => {
  beforeEach(reset);

  it("requires --from <provider/id>", async () => {
    const { pi, commands, ctx, sentMessages, notifications } = makeFakePi([]);
    continualHarness(pi);
    await commands.get("harness")!.handler("adopt", ctx());
    await commands.get("harness")!.handler("adopt --all", ctx());
    expect(sentMessages).toHaveLength(0);
    expect(notifications.filter((n) => n.level === "warning" && /requires --from/.test(n.msg))).toHaveLength(2);
  });

  it("empty store → warning, nothing sent", async () => {
    const { pi, commands, ctx, sentMessages, notifications } = makeFakePi([]);
    continualHarness(pi);
    await commands.get("harness")!.handler("adopt --from anthropic/claude", ctx());
    expect(sentMessages).toHaveLength(0);
    expect(notifications.some((n) => /No active items in the harness — nothing to adopt/.test(n.msg))).toBe(true);
  });

  it("unknown model → warning listing the owners actually present", async () => {
    const { pi, commands, ctx, sentMessages, notifications } = makeFakePi([]);
    continualHarness(pi);
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "a", evidence: "e", ownerModel: "anthropic/sonnet" },
        { op: "create", kind: "prompt", content: "b", evidence: "e", ownerModel: "anthropic/sonnet" },
        { op: "create", kind: "memory", content: "c", evidence: "e", ownerModel: "google/gemini" },
      ] as Delta[],
      () => {},
    );
    await commands.get("harness")!.handler("adopt --from openai/gpt", ctx());
    expect(sentMessages).toHaveLength(0);
    expect(
      notifications.some(
        (n) =>
          n.level === "warning" &&
          /No active items owned by openai\/gpt\. Model\(s\) in the store: anthropic\/sonnet \(2\), google\/gemini \(1\)\./.test(n.msg),
      ),
    ).toBe(true);
  });

  it("adopting from the ACTIVE model is refused (would only duplicate)", async () => {
    const { pi, commands, ctx, sentMessages, notifications } = makeFakePi([]);
    continualHarness(pi);
    applyDeltas(
      [{ op: "create", kind: "memory", content: "mine", evidence: "e", ownerModel: "test/main" }] as Delta[],
      () => {},
    );
    // the fake ctx drives model test/main
    await commands.get("harness")!.handler("adopt --from test/main", ctx());
    expect(sentMessages).toHaveLength(0);
    expect(notifications.some((n) => /already the active model's harness/.test(n.msg))).toBe(true);
  });
});

describe("/harness adopt handler — steering", () => {
  beforeEach(reset);

  it("collects the source model's ACTIVE items only and steers with notify", async () => {
    const { pi, commands, ctx, sentMessages, notifications } = makeFakePi([]);
    continualHarness(pi);
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "kept", evidence: "src ev", ownerModel: "anthropic/sonnet" },
        { op: "create", kind: "memory", content: "inactive", evidence: "src ev", ownerModel: "anthropic/sonnet" },
        { op: "create", kind: "memory", content: "other model", evidence: "e", ownerModel: "google/gemini" },
      ] as Delta[],
      () => {},
    );
    const inactiveId = getState().items.find((i) => i.content === "inactive")!.id;
    applyDeltas([{ op: "update", id: inactiveId, active: false }] as Delta[], () => {});
    await commands.get("harness")!.handler("adopt --from anthropic/sonnet", ctx());
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("kept");
    expect(sentMessages[0]).not.toContain("inactive");
    expect(sentMessages[0]).not.toContain("other model");
    expect(sentMessages[0]).toContain("adopted from anthropic/sonnet");
    expect(notifications.some((n) => /Steering agent to review for adoption 1 item\(s\) from anthropic\/sonnet\./.test(n.msg))).toBe(true);
  });

  it("caps an oversized source batch and says so", async () => {
    const { pi, commands, ctx, sentMessages, notifications } = makeFakePi([]);
    continualHarness(pi);
    applyDeltas(
      Array.from({ length: ADOPT_BATCH_CAP + 5 }, (_, n) => ({
        op: "create" as const,
        kind: "memory" as const,
        content: `src ${n}`,
        evidence: "e",
        ownerModel: "anthropic/sonnet",
      })),
      () => {},
    );
    await commands.get("harness")!.handler("adopt --from anthropic/sonnet --all", ctx());
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain(`${ADOPT_BATCH_CAP} item(s) up for adoption`);
    expect(notifications.some((n) => /adopt 20 item\(s\) from anthropic\/sonnet \(capped to the 20 highest-importance of 25\)/.test(n.msg))).toBe(true);
  });
});

describe("/harness adopt — store-level: copy, not move; stamped to the ACTIVE model", () => {
  beforeEach(reset);

  it("the steered creates land on the active model and leave the source untouched", async () => {
    const { pi, tools, commands, ctx, sentMessages, entries } = makeFakePi([]);
    continualHarness(pi);
    applyDeltas(
      [
        { op: "create", kind: "prompt", content: "verify flags before push", evidence: "postmortem #7", importance: 0.8, ownerModel: "anthropic/sonnet" },
        { op: "create", kind: "memory", content: "sonnet over-explains JSON", evidence: "observed", importance: 0.4, ownerModel: "anthropic/sonnet" },
      ] as Delta[],
      () => {},
    );

    await commands.get("harness")!.handler("adopt --from anthropic/sonnet", ctx());
    expect(sentMessages).toHaveLength(1);

    // Simulate the steered agent: it applies ONE harness_mutate create batch
    // (filtering "generalizes" — here only the model-agnostic item — and
    // annotating evidence with the source). The active model in this turn is
    // the adopter, exactly like production.
    setActiveModelKey("openai/gpt");
    const mutate = tools.get("harness_mutate")!;
    await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(
      undefined,
      {
        deltas: [
          {
            op: "create",
            kind: "prompt",
            content: "verify flags before push",
            evidence: "postmortem #7 (adopted from anthropic/sonnet)",
            importance: 0.8,
          },
        ],
      },
      undefined,
      undefined,
      ctx(),
    );

    const all = getState().items;
    // adopted copy: NEW id, stamped to the active (adopting) model
    const adopted = all.filter((i) => i.content === "verify flags before push");
    expect(adopted).toHaveLength(2);
    const copy = adopted.find((i) => i.ownerModel === "openai/gpt")!;
    expect(copy).toBeDefined();
    expect(copy.id).not.toBe(adopted.find((i) => i.ownerModel === "anthropic/sonnet")!.id);
    expect(copy.evidence).toBe("postmortem #7 (adopted from anthropic/sonnet)");
    expect(copy.importance).toBe(0.8);
    // source harness untouched: both original items remain, owned by the source
    expect(all.filter((i) => i.ownerModel === "anthropic/sonnet")).toHaveLength(2);
    expect(all.find((i) => i.content === "sonnet over-explains JSON")!.ownerModel).toBe("anthropic/sonnet");
    // audited as harness-state snapshots (→ /tree rollback covers adoption)
    expect(entries.some((e) => e.customType === "harness-state")).toBe(true);
  });
});

describe("/harness adopt completions", () => {
  beforeEach(reset);

  it("offers --from/--all flags", () => {
    const { pi, commands } = makeFakePi([]);
    continualHarness(pi);
    const complete = commands.get("harness")!.getArgumentCompletions!;
    expect(complete("adopt ")).toEqual([
      { value: "adopt --from", label: "--from", description: expect.any(String) },
      { value: "adopt --all", label: "--all", description: expect.any(String) },
    ]);
    // used flags are not re-offered
    expect(complete("adopt --all --")).toEqual([
      { value: "adopt --all --from", label: "--from", description: expect.any(String) },
    ]);
  });

  it("completes --from values from the model keys present in the store", () => {
    const { pi, commands } = makeFakePi([]);
    continualHarness(pi);
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "a", evidence: "e", ownerModel: "anthropic/sonnet" },
        { op: "create", kind: "memory", content: "b", evidence: "e", ownerModel: "google/gemini" },
        { op: "create", kind: "memory", content: "c", evidence: "e", ownerModel: "google/gemini" },
        // orphans are not adoption sources (adopted automatically instead)
        { op: "create", kind: "memory", content: "orphan", evidence: "e" },
        { op: "create", kind: "memory", content: "d", evidence: "e", ownerModel: "openai/gpt" },
      ] as Delta[],
      () => {},
    );
    // ...and neither are inactive items
    const inactiveId = getState().items.find((i) => i.content === "d")!.id;
    applyDeltas([{ op: "update", id: inactiveId, active: false }] as Delta[], () => {});
    const complete = commands.get("harness")!.getArgumentCompletions!;
    expect(complete("adopt --from ")).toEqual([
      { value: "adopt --from anthropic/sonnet", label: "anthropic/sonnet", description: "1 active item(s) owned by this model" },
      { value: "adopt --from google/gemini", label: "google/gemini", description: "2 active item(s) owned by this model" },
    ]);
    // prefix filtering, replacing the whole argument text
    expect(complete("adopt --from go")).toEqual([
      { value: "adopt --from google/gemini", label: "google/gemini", description: expect.any(String) },
    ]);
    expect(complete("adopt --from nope")).toBeNull();
  });
});

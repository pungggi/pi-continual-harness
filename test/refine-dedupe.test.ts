// Wiring tests for the merge-capable dedupe (0.10.0):
//  (1) runRefine threads the loaded config into ProposeInput (proposers read
//      tuned knobs without file I/O);
//  (2) RefineOptions.threshold / `/refine --threshold` overrides the
//      configured dedupe threshold for that run; invalid values are ignored
//      with a warning;
//  (3) end-to-end: the dedupe proposer's update+delete batch lands in the
//      store and the audit records both rationales.

import { describe, it, expect, beforeEach } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerRefine, runRefine } from "../src/refine.js";
import { registerProposer } from "../src/proposer.js";
import type { ProposeInput } from "../src/proposer.js";
import { applyDeltas, getState, reconstruct } from "../src/store.js";
import { resetConfigCache } from "../src/config.js";
import { makeFakePi } from "./helpers.js";

const REFINE_AUDIT = "harness-refinement";

function reset(): void {
  reconstruct([]);
}

function spyProposer(name: string, seen: ProposeInput[]): void {
  registerProposer({
    name,
    async propose(input) {
      seen.push(input);
      return { deltas: [] };
    },
  });
}

describe("dedupe wiring: config threading + --threshold", () => {
  beforeEach(() => {
    reset();
    resetConfigCache();
  });

  it("runRefine threads the loaded (resolved) config into ProposeInput", async () => {
    const seen: ProposeInput[] = [];
    spyProposer("w-config-spy", seen);
    const { pi, ctx } = makeFakePi([]);
    await runRefine(pi, ctx() as unknown as ExtensionCommandContext, {
      proposer: "w-config-spy",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.config).toBeDefined();
    // always fully-populated (loadConfig resolves over DEFAULT_CONFIG)
    expect(seen[0]!.config!.dedupe).toEqual({ threshold: 0.6, merge: true });
  });

  it("RefineOptions.threshold overrides the configured threshold for the run", async () => {
    const seen: ProposeInput[] = [];
    spyProposer("w-threshold-spy", seen);
    const { pi, ctx } = makeFakePi([]);
    await runRefine(pi, ctx() as unknown as ExtensionCommandContext, {
      proposer: "w-threshold-spy",
      threshold: 0.75,
    });
    expect(seen[0]!.config!.dedupe).toEqual({ threshold: 0.75, merge: true });
  });

  it("/refine --threshold=0.8 flows through the command path", async () => {
    const seen: ProposeInput[] = [];
    spyProposer("w-cli-spy", seen);
    const { pi, commands, ctx } = makeFakePi([]);
    registerRefine(pi);
    await (commands.get("refine")!.handler as (args: string, ctx: unknown) => Promise<void>)(
      "25 --proposer w-cli-spy --threshold=0.8",
      ctx(),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.config!.dedupe!.threshold).toBe(0.8);
  });

  it("an invalid --threshold is ignored with a warning (no crash, defaults intact)", async () => {
    const seen: ProposeInput[] = [];
    spyProposer("w-bad-threshold", seen);
    const { pi, commands, ctx, notifications } = makeFakePi([]);
    registerRefine(pi);
    await (commands.get("refine")!.handler as (args: string, ctx: unknown) => Promise<void>)(
      "25 --proposer w-bad-threshold --threshold abc",
      ctx(),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.config!.dedupe!.threshold).toBe(0.6); // default retained
    expect(notifications.some((n) => n.msg.includes("Invalid --threshold ignored"))).toBe(true);
  });

  it("end-to-end: dedupe proposer merges a duplicate pair (update + delete, audited)", async () => {
    const { pi, ctx, entries, sentMessages } = makeFakePi([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "fix bug" }] } },
    ]);
    applyDeltas(
      [
        { op: "create", kind: "prompt", content: "always use the foo pattern", evidence: "t1", importance: 0.9 },
        { op: "create", kind: "prompt", content: "use the foo pattern always", evidence: "t2", importance: 0.4 },
      ],
      () => {},
    );
    expect(getState().items).toHaveLength(2);

    await runRefine(pi, ctx() as unknown as ExtensionCommandContext, { proposer: "dedupe" });

    // keeper survives with the unioned evidence; duplicate gone; no steering
    expect(getState().items).toHaveLength(1);
    expect(getState().items[0]!.content).toBe("always use the foo pattern");
    expect(getState().items[0]!.evidence).toBe("t1\nt2");
    expect(sentMessages).toHaveLength(0);
    const audits = entries.filter((e) => e.customType === REFINE_AUDIT);
    expect(audits).toHaveLength(1);
    const audit = audits[0]!.data as { proposer: string; applied: number; rationales: string[] };
    expect(audit.proposer).toBe("dedupe");
    expect(audit.applied).toBe(2); // update + delete
    expect(audit.rationales.some((r) => r.includes("evidence unioned"))).toBe(true);
    expect(audit.rationales.some((r) => r.includes("merged into"))).toBe(true);
  });
});

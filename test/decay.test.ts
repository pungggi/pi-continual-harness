// Tests for the opt-in trial-decay pass (the expiry half of the provenance
// trust boundary). planTrialDecay / isOnTrial / hasPositiveSupport are pure
// and tested directly; evaluateTrialDecay mirrors the cadence contract of
// evaluateAutoRefine; the turn_end handler is tested against a minimal fake
// pi (same shape as outcome.test.ts). makeMini CHAINS turn_end handlers in
// registration order, mirroring the real TURN_END_CHAIN, so the combined
// outcome → trial-decay same-tick semantics can be pinned behaviorally.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TRIAL_AFTER_DAYS,
  DEFAULT_TRIAL_STEP,
  evaluateTrialDecay,
  hasPositiveSupport,
  isOnTrial,
  planTrialDecay,
  registerTrialDecay,
  resetTrialDecay,
} from "../src/decay.js";
import { getState, reconstruct, STATE_ENTRY, IMPORTANCE_FLOOR } from "../src/store.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { registerOutcome, resetOutcome } from "../src/outcome.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DAY = 86_400_000;

type Handler = (event?: unknown, ctx?: unknown) => unknown | Promise<unknown>;

interface MiniCtx {
  ui: { notify: (msg: string, level: string) => void; setStatus: () => void };
  sessionManager: { getBranch: () => unknown[] };
  model: { provider: string; id: string };
}

function makeMini(branch: unknown[]) {
  const handlers = new Map<string, Handler>();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const notifications: Array<{ msg: string; level: string }> = [];
  const pi = {
    on: (ev: string, h: Handler) => {
      // Chain same-event handlers in registration order (like the real chain).
      const prev = handlers.get(ev);
      handlers.set(
        ev,
        prev
          ? async (event?: unknown, c?: unknown) => {
              await prev(event, c);
              await h(event, c);
            }
          : h,
      );
    },
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
    sendUserMessage: () => {},
  };
  const ctx = (): MiniCtx => ({
    ui: { notify: (msg, level) => notifications.push({ msg, level }), setStatus: () => {} },
    sessionManager: { getBranch: () => branch },
    model: { provider: "test", id: "main" },
  });
  return { pi: pi as unknown as ExtensionAPI, handlers, entries, notifications, ctx };
}

type Seed = Partial<{
  id: string;
  provenance: "agent" | "owner";
  support: { citations?: number; keeps?: number; drops?: number };
  createdAt: number;
  updatedAt: number;
  importance: number;
  active: boolean;
}>;

/** A store-snapshot item shape (shared by the pure-planner input and the
 *  reconstruct'd live store). createdAt defaults to ancient (1) so a fixture
 *  is stale unless the test says otherwise; updatedAt is irrelevant to
 *  staleness (creation is the trial clock) and tests that care about that
 *  pin it explicitly. */
function item(over: Seed = {}) {
  const {
    id = "h_abc",
    provenance,
    support,
    createdAt = 1,
    updatedAt = 1,
    importance = 0.5,
    active = true,
  } = over;
  return {
    id,
    kind: "memory" as const,
    content: "fact",
    evidence: "e",
    importance,
    active,
    ownerModel: "test/main",
    ...(provenance ? { provenance } : {}),
    ...(support ? { support } : {}),
    createdAt,
    updatedAt,
  };
}

/** One item in the live store via a reconstruct'd snapshot. */
function seedItem(over: Seed = {}): void {
  reconstruct([
    {
      type: "custom",
      customType: STATE_ENTRY,
      data: { state: { items: [item(over)] } },
    },
  ]);
}

const NOW = 1_000_000_000_000;

describe("hasPositiveSupport / isOnTrial", () => {
  it("citations and keeps count as positive support; drops alone do not", () => {
    expect(hasPositiveSupport(item({ support: { citations: 1 } }))).toBe(true);
    expect(hasPositiveSupport(item({ support: { keeps: 2 } }))).toBe(true);
    expect(hasPositiveSupport(item({ support: { drops: 3 } }))).toBe(false);
    expect(hasPositiveSupport(item({}))).toBe(false);
  });

  it("on trial = active + agent-authored + unsupported", () => {
    expect(isOnTrial(item({ provenance: "agent" }))).toBe(true);
    expect(isOnTrial(item({}))).toBe(false); // trusted (owner/legacy)
    expect(isOnTrial(item({ provenance: "agent", active: false }))).toBe(false);
    expect(isOnTrial(item({ provenance: "agent", support: { keeps: 1 } }))).toBe(false);
    expect(isOnTrial(item({ provenance: "agent", support: { citations: 1 } }))).toBe(false);
  });
});

describe("planTrialDecay (pure planner)", () => {
  it("decays a stale on-trial item by step, without touching it", () => {
    const stale = item({ id: "h_1", provenance: "agent", createdAt: NOW - 30 * DAY });
    const plan = planTrialDecay([stale], { now: NOW });
    expect(plan.stale).toBe(1);
    expect(plan.actions).toEqual([{ op: "decay", id: "h_1", from: 0.5, to: 0.45 }]);
    expect(stale.importance).toBe(0.5); // pure: input untouched
  });

  it("keys staleness on CREATION: a recent rewrite does not restart the trial", () => {
    // The review's finding: every update path touches updatedAt, so an
    // updatedAt clock only ever reaped abandoned notes. An old creation with
    // a fresh last-update must still be stale — only support (citation/keep)
    // exempts, and no delta can rewind createdAt.
    const rewritten = item({
      provenance: "agent",
      createdAt: NOW - 30 * DAY,
      updatedAt: NOW - DAY, // rewritten yesterday — still on trial
    });
    expect(planTrialDecay([rewritten], { now: NOW }).stale).toBe(1);
    const fresh = item({
      id: "h_new",
      provenance: "agent",
      createdAt: NOW - DAY, // created yesterday — fresh trial, no decay yet
      updatedAt: NOW - DAY,
    });
    expect(planTrialDecay([fresh], { now: NOW }).stale).toBe(0);
  });

  it("uses the shipped defaults (14 days, 0.05 step) when opts are omitted", () => {
    const thirteenDays = item({ provenance: "agent", createdAt: NOW - 13 * DAY });
    const fifteenDays = item({ provenance: "agent", createdAt: NOW - 15 * DAY });
    const plan = planTrialDecay([thirteenDays, fifteenDays], { now: NOW });
    expect(plan.actions.map((a) => a.id)).toEqual([fifteenDays.id]);
    expect(DEFAULT_TRIAL_AFTER_DAYS).toBe(14);
    expect(DEFAULT_TRIAL_STEP).toBe(0.05);
  });

  it("treats exactly-afterDays-old as stale (boundary is inclusive)", () => {
    const exactly = item({
      provenance: "agent",
      createdAt: NOW - DEFAULT_TRIAL_AFTER_DAYS * DAY,
    });
    expect(planTrialDecay([exactly], { now: NOW }).stale).toBe(1);
    const justUnder = item({
      id: "h_fresh",
      provenance: "agent",
      createdAt: NOW - (DEFAULT_TRIAL_AFTER_DAYS * DAY - 1),
    });
    expect(planTrialDecay([justUnder], { now: NOW }).stale).toBe(0);
  });

  it("never considers trusted, inactive, or supported items", () => {
    const trusted = item({ id: "h_t", createdAt: NOW - 30 * DAY }); // no provenance
    const inactive = item({
      id: "h_i",
      provenance: "agent",
      active: false,
      createdAt: NOW - 30 * DAY,
    });
    const cited = item({
      id: "h_c",
      provenance: "agent",
      support: { citations: 1 },
      createdAt: NOW - 30 * DAY,
    });
    const kept = item({
      id: "h_k",
      provenance: "agent",
      support: { keeps: 1 },
      createdAt: NOW - 30 * DAY,
    });
    const plan = planTrialDecay([trusted, inactive, cited, kept], { now: NOW });
    expect(plan.actions).toEqual([]);
    expect(plan.stale).toBe(0);
  });

  it("expires (deletes) when the next step would land below the prune floor", () => {
    const atFloor = item({
      provenance: "agent",
      importance: IMPORTANCE_FLOOR,
      createdAt: NOW - 30 * DAY,
    });
    // 0.30 − 0.05 = 0.25 < floor → expire, not decay.
    expect(planTrialDecay([atFloor], { now: NOW }).actions).toEqual([
      { op: "expire", id: atFloor.id, from: IMPORTANCE_FLOOR },
    ]);
    // Just above the floor decays to exactly the floor and survives this pass.
    const above = item({ provenance: "agent", importance: 0.35, createdAt: NOW - 30 * DAY });
    expect(planTrialDecay([above], { now: NOW }).actions).toEqual([
      { op: "decay", id: above.id, from: 0.35, to: IMPORTANCE_FLOOR },
    ]);
  });

  it("a dropped agent item is still on trial (drops are not positive support)", () => {
    const dropped = item({
      provenance: "agent",
      support: { drops: 2 },
      createdAt: NOW - 30 * DAY,
    });
    const plan = planTrialDecay([dropped], { now: NOW });
    expect(plan.stale).toBe(1);
  });

  it("respects custom afterDays/step", () => {
    const fiveDays = item({ provenance: "agent", createdAt: NOW - 6 * DAY });
    expect(planTrialDecay([fiveDays], { now: NOW, afterDays: 5, step: 0.2 }).actions).toEqual([
      { op: "decay", id: fiveDays.id, from: 0.5, to: 0.3 },
    ]);
    expect(planTrialDecay([fiveDays], { now: NOW, afterDays: 7 }).stale).toBe(0);
  });
});

describe("evaluateTrialDecay (cadence)", () => {
  beforeEach(resetTrialDecay);

  it("never fires when disabled (the default)", () => {
    expect(evaluateTrialDecay(false, 1)).toBe(false);
    expect(evaluateTrialDecay(false, 1)).toBe(false);
  });

  it("seeds a baseline, then fires exactly every N completed turns", () => {
    expect(evaluateTrialDecay(true, 2)).toBe(false); // seed (doesn't count)
    expect(evaluateTrialDecay(true, 2)).toBe(false); // 1st completed
    expect(evaluateTrialDecay(true, 2)).toBe(true); // 2nd completed — fire
    expect(evaluateTrialDecay(true, 2)).toBe(false); // count reset
    expect(evaluateTrialDecay(true, 2)).toBe(true); // fires again
  });

  it("aborted/error turns are inert (neither seed nor advance)", () => {
    expect(evaluateTrialDecay(true, 1, "aborted")).toBe(false); // not even seeded
    expect(evaluateTrialDecay(true, 1)).toBe(false); // seed
    expect(evaluateTrialDecay(true, 1, "error")).toBe(false); // skipped
    expect(evaluateTrialDecay(true, 1)).toBe(true); // fire
  });

  it("every <= 0 disables the cadence", () => {
    expect(evaluateTrialDecay(true, 0)).toBe(false);
    expect(evaluateTrialDecay(true, -1)).toBe(false);
  });
});

describe("handleTrialDecayTurnEnd", () => {
  beforeEach(() => {
    resetTrialDecay();
    resetConfigCache();
    reconstruct([]);
  });

  let dir: string | undefined;
  afterEach(() => {
    resetTrialDecay();
    resetConfigCache();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function setConfig(
    enabled: boolean,
    over: { everyTurns?: number; afterDays?: number; step?: number } = {},
  ): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), "pi-ch-decay-"));
    const cfgFile = join(dir, "harness.json");
    writeFileSync(cfgFile, JSON.stringify({ trialDecay: { enabled, ...over } }));
    await loadConfig(cfgFile); // populate the in-process cache (deterministic)
  }

  it("is inert when trialDecay is disabled (the default)", async () => {
    await setConfig(false);
    seedItem({ provenance: "agent", updatedAt: 1 });
    const { pi, handlers, ctx, notifications, entries } = makeMini([]);
    registerTrialDecay(pi);

    await handlers.get("turn_end")!({ outcome: "completed" }, ctx());
    await handlers.get("turn_end")!({ outcome: "completed" }, ctx());
    expect(getState().items[0]!.importance).toBe(0.5);
    expect(notifications).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("seeds on the first fire, then decays a stale item and persists + notifies", async () => {
    await setConfig(true, { everyTurns: 1, step: 0.05 });
    seedItem({ provenance: "agent", updatedAt: 1 });
    const { pi, handlers, ctx, notifications, entries } = makeMini([]);
    registerTrialDecay(pi);

    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // seed
    expect(notifications).toHaveLength(0);
    expect(getState().items[0]!.importance).toBe(0.5);

    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // fire
    expect(getState().items[0]!.importance).toBeCloseTo(0.45);
    expect(entries.some((e) => e.customType === STATE_ENTRY)).toBe(true);
    expect(notifications.some((n) => /Trial decay/.test(n.msg))).toBe(true);
  });

  it("expires (deletes) an item whose decay would land below the floor", async () => {
    await setConfig(true, { everyTurns: 1, step: 0.05 });
    seedItem({ provenance: "agent", importance: IMPORTANCE_FLOOR, updatedAt: 1 });
    const { pi, handlers, ctx, notifications } = makeMini([]);
    registerTrialDecay(pi);

    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // seed
    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // fire
    expect(getState().items).toHaveLength(0); // expired, not decayed
    expect(notifications.some((n) => /expired/.test(n.msg))).toBe(true);
  });

  it("notifies once per item per session (first decay + expiry, silent between)", async () => {
    await setConfig(true, { everyTurns: 1, step: 0.05 });
    seedItem({ provenance: "agent" }); // 0.5 importance, ancient createdAt
    const { pi, handlers, ctx, notifications } = makeMini([]);
    registerTrialDecay(pi);

    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // seed
    // 0.5 → 0.45 → 0.40 → 0.35 → 0.30 across four passes: only the FIRST notifies.
    for (let i = 0; i < 4; i++) {
      await handlers.get("turn_end")!({ outcome: "completed" }, ctx());
    }
    const decayNotes = notifications.filter((n) => /Trial decay/.test(n.msg));
    expect(decayNotes).toHaveLength(1);
    expect(decayNotes[0]!.msg).toMatch(/1 stale unverified/);
    expect(getState().items[0]!.importance).toBeCloseTo(IMPORTANCE_FLOOR);

    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // expire
    expect(getState().items).toHaveLength(0);
    const afterExpiry = notifications.filter((n) => /Trial decay/.test(n.msg));
    expect(afterExpiry).toHaveLength(2); // expiry always notifies
    expect(afterExpiry[1]!.msg).toMatch(/expired/);
  });

  it("does not touch updatedAt (decay must not churn the store's activity clock)", async () => {
    await setConfig(true, { everyTurns: 1 });
    seedItem({ provenance: "agent", updatedAt: 1 });
    const { pi, handlers, ctx } = makeMini([]);
    registerTrialDecay(pi);

    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // seed
    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // fire
    expect(getState().items[0]!.updatedAt).toBe(1);
  });

  it("is a quiet no-op when nothing is stale (no persist, no notify)", async () => {
    await setConfig(true, { everyTurns: 1 });
    seedItem({ provenance: "agent", createdAt: Date.now() }); // fresh trial
    const { pi, handlers, ctx, notifications, entries } = makeMini([]);
    registerTrialDecay(pi);

    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // seed
    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // fire, nothing stale
    expect(getState().items[0]!.importance).toBe(0.5);
    expect(notifications).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("skips aborted/error turns entirely (cadence inert)", async () => {
    await setConfig(true, { everyTurns: 1 });
    seedItem({ provenance: "agent" });
    const { pi, handlers, ctx, notifications } = makeMini([]);
    registerTrialDecay(pi);

    await handlers.get("turn_end")!({ outcome: "aborted" }, ctx()); // not seeded
    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // seed
    await handlers.get("turn_end")!({ outcome: "error" }, ctx()); // skipped
    expect(getState().items[0]!.importance).toBe(0.5);
    expect(notifications).toHaveLength(0);
  });
});

describe("trial decay × outcome loop (same-tick citation exemption)", () => {
  let dir: string | undefined;
  beforeEach(() => {
    resetTrialDecay();
    resetOutcome();
    resetConfigCache();
    reconstruct([]);
  });
  afterEach(() => {
    resetTrialDecay();
    resetOutcome();
    resetConfigCache();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("a citation recorded this turn exempts the item from the same turn's decay pass", async () => {
    // entry.test pins the chain ORDER (outcome before trial-decay); this pins
    // the SEMANTICS behind it: support recorded by the outcome handler is
    // already visible to the decay pass dispatched later in the same
    // turn_end, so a usefully-cited item never decays for the turn that
    // earned its exemption.
    dir = mkdtempSync(join(tmpdir(), "pi-ch-decay2-"));
    const cfgFile = join(dir, "harness.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        outcomeImportance: { enabled: true, bump: 0.05 },
        trialDecay: { enabled: true, everyTurns: 1, step: 0.05 },
      }),
    );
    await loadConfig(cfgFile);

    // Ancient createdAt: without the same-tick citation this item WOULD decay.
    seedItem({ id: "h_abc", provenance: "agent" });
    const branch: unknown[] = [
      { type: "message", message: { role: "assistant", content: "prior turn" } },
    ];
    const { pi, handlers, ctx, notifications } = makeMini(branch);
    registerOutcome(pi); // chain order mirrors TURN_END_CHAIN: outcome first
    registerTrialDecay(pi);

    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // seed both
    branch.push({
      type: "message",
      message: { role: "assistant", content: "solved it using [h_abc]" },
    });
    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // cite + decay tick

    const item = getState().items[0]!;
    expect(item.support?.citations).toBe(1); // grounded in this very turn
    expect(item.importance).toBeCloseTo(0.55); // bumped, NOT decayed
    expect(item.active).toBe(true);
    expect(notifications.some((n) => /Outcome/.test(n.msg))).toBe(true);
    expect(notifications.some((n) => /Trial decay/.test(n.msg))).toBe(false);
  });
});

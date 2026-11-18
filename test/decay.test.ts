// Tests for the opt-in trial-decay pass (the expiry half of the provenance
// trust boundary). planTrialDecay / isOnTrial / hasPositiveSupport are pure
// and tested directly; evaluateTrialDecay mirrors the cadence contract of
// evaluateAutoRefine; the turn_end handler is tested against a minimal fake
// pi (same shape as outcome.test.ts — the handler must be the SOLE turn_end
// subscriber on its fake).

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
    on: (ev: string, h: Handler) => handlers.set(ev, h),
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
  updatedAt: number;
  importance: number;
  active: boolean;
}>;

/** A store-snapshot item shape (shared by the pure-planner input and the
 *  reconstruct'd live store). */
function item(over: Seed = {}) {
  const {
    id = "h_abc",
    provenance,
    support,
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
    createdAt: 1,
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
    const stale = item({ id: "h_1", provenance: "agent", updatedAt: NOW - 30 * DAY });
    const plan = planTrialDecay([stale], { now: NOW });
    expect(plan.stale).toBe(1);
    expect(plan.actions).toEqual([{ op: "decay", id: "h_1", from: 0.5, to: 0.45 }]);
    expect(stale.importance).toBe(0.5); // pure: input untouched
  });

  it("uses the shipped defaults (14 days, 0.05 step) when opts are omitted", () => {
    const thirteenDays = item({ provenance: "agent", updatedAt: NOW - 13 * DAY });
    const fifteenDays = item({ provenance: "agent", updatedAt: NOW - 15 * DAY });
    const plan = planTrialDecay([thirteenDays, fifteenDays], { now: NOW });
    expect(plan.actions.map((a) => a.id)).toEqual([fifteenDays.id]);
    expect(DEFAULT_TRIAL_AFTER_DAYS).toBe(14);
    expect(DEFAULT_TRIAL_STEP).toBe(0.05);
  });

  it("treats exactly-afterDays-old as stale (boundary is inclusive)", () => {
    const exactly = item({ provenance: "agent", updatedAt: NOW - DEFAULT_TRIAL_AFTER_DAYS * DAY });
    expect(planTrialDecay([exactly], { now: NOW }).stale).toBe(1);
    const justUnder = item({
      id: "h_fresh",
      provenance: "agent",
      updatedAt: NOW - (DEFAULT_TRIAL_AFTER_DAYS * DAY - 1),
    });
    expect(planTrialDecay([justUnder], { now: NOW }).stale).toBe(0);
  });

  it("never considers trusted, inactive, or supported items", () => {
    const trusted = item({ id: "h_t", updatedAt: NOW - 30 * DAY }); // no provenance
    const inactive = item({
      id: "h_i",
      provenance: "agent",
      active: false,
      updatedAt: NOW - 30 * DAY,
    });
    const cited = item({
      id: "h_c",
      provenance: "agent",
      support: { citations: 1 },
      updatedAt: NOW - 30 * DAY,
    });
    const kept = item({
      id: "h_k",
      provenance: "agent",
      support: { keeps: 1 },
      updatedAt: NOW - 30 * DAY,
    });
    const plan = planTrialDecay([trusted, inactive, cited, kept], { now: NOW });
    expect(plan.actions).toEqual([]);
    expect(plan.stale).toBe(0);
  });

  it("expires (deletes) when the next step would land below the prune floor", () => {
    const atFloor = item({
      provenance: "agent",
      importance: IMPORTANCE_FLOOR,
      updatedAt: NOW - 30 * DAY,
    });
    // 0.30 − 0.05 = 0.25 < floor → expire, not decay.
    expect(planTrialDecay([atFloor], { now: NOW }).actions).toEqual([
      { op: "expire", id: atFloor.id, from: IMPORTANCE_FLOOR },
    ]);
    // Just above the floor decays to exactly the floor and survives this pass.
    const above = item({ provenance: "agent", importance: 0.35, updatedAt: NOW - 30 * DAY });
    expect(planTrialDecay([above], { now: NOW }).actions).toEqual([
      { op: "decay", id: above.id, from: 0.35, to: IMPORTANCE_FLOOR },
    ]);
  });

  it("a dropped agent item is still on trial (drops are not positive support)", () => {
    const dropped = item({
      provenance: "agent",
      support: { drops: 2 },
      updatedAt: NOW - 30 * DAY,
    });
    const plan = planTrialDecay([dropped], { now: NOW });
    expect(plan.stale).toBe(1);
  });

  it("respects custom afterDays/step", () => {
    const fiveDays = item({ provenance: "agent", updatedAt: NOW - 6 * DAY });
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

  it("does not touch updatedAt (a decaying item must not restart its window)", async () => {
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
    seedItem({ provenance: "agent", updatedAt: Date.now() }); // fresh trial
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
    seedItem({ provenance: "agent", updatedAt: 1 });
    const { pi, handlers, ctx, notifications } = makeMini([]);
    registerTrialDecay(pi);

    await handlers.get("turn_end")!({ outcome: "aborted" }, ctx()); // not seeded
    await handlers.get("turn_end")!({ outcome: "completed" }, ctx()); // seed
    await handlers.get("turn_end")!({ outcome: "error" }, ctx()); // skipped
    expect(getState().items[0]!.importance).toBe(0.5);
    expect(notifications).toHaveLength(0);
  });
});

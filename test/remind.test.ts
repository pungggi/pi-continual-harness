import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDetailGuide,
  buildNudge,
  detailSlot,
  DETAIL_GUIDES,
  DETAIL_LOOP_VARIANTS,
  evaluateReminder,
  reminderState,
  resetReminder,
  type ReminderState,
} from "../src/remind.js";
import { DEFAULT_CONFIG, loadConfig, resetConfigCache, type HarnessConfig } from "../src/config.js";
import { applyDeltas, getState, reconstruct } from "../src/store.js";
import { makeFakePi } from "./helpers.js";

const cfg = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  remindRefine: { enabled: true, everyTurns: 5 },
  ...over,
});

const facts = (over: Partial<ReminderState> = {}): ReminderState => ({
  activeItems: 12,
  neverCited: 4,
  everyTurns: 25,
  detailEvery: 4,
  ...over,
});

describe("evaluateReminder", () => {
  beforeEach(resetReminder);

  it("never reminds when disabled", () => {
    const disabled = cfg({ remindRefine: { enabled: false, everyTurns: 5 } });
    for (let i = 0; i < 30; i++) {
      expect(evaluateReminder(disabled, i).fire).toBe(false);
    }
  });

  it("seeds a baseline on the first turn, then reminds exactly every N turns", () => {
    const enabled = cfg({ remindRefine: { enabled: true, everyTurns: 5 } });
    expect(evaluateReminder(enabled, 0).fire).toBe(false); // seed baseline at 0
    expect(evaluateReminder(enabled, 1).fire).toBe(false);
    expect(evaluateReminder(enabled, 4).fire).toBe(false);
    expect(evaluateReminder(enabled, 5).fire).toBe(true); // first nudge
    expect(evaluateReminder(enabled, 6).fire).toBe(false);
    expect(evaluateReminder(enabled, 9).fire).toBe(false);
    expect(evaluateReminder(enabled, 10).fire).toBe(true); // second nudge, cadence resets
    expect(evaluateReminder(enabled, 14).fire).toBe(false);
    expect(evaluateReminder(enabled, 15).fire).toBe(true); // third nudge
  });

  it("never reminds when everyTurns <= 0", () => {
    const zero = cfg({ remindRefine: { enabled: true, everyTurns: 0 } });
    expect(evaluateReminder(zero, 0).fire).toBe(false);
    expect(evaluateReminder(zero, 1000).fire).toBe(false);
  });

  it("falls back to the default cadence (25) when everyTurns is absent", () => {
    const noEvery = cfg({ remindRefine: { enabled: true } });
    expect(evaluateReminder(noEvery, 0).fire).toBe(false); // seed
    expect(evaluateReminder(noEvery, 24).fire).toBe(false);
    expect(evaluateReminder(noEvery, 25).fire).toBe(true); // new default 25
  });

  it("escalates to the detailed tier every detailEvery-th fired reminder", () => {
    const c = cfg({ remindRefine: { enabled: true, everyTurns: 1, detailEvery: 4 } });
    // turns 0 seeds; each later turn fires (everyTurns 1). Track fires.
    const decisions = [evaluateReminder(c, 0)];
    for (let t = 1; t <= 10; t++) decisions.push(evaluateReminder(c, t));
    const fired = decisions.filter((d) => d.fire);
    expect(fired.map((d) => d.fires)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(fired.map((d) => d.detail)).toEqual([
      false, false, false, true, // fire 4 → detail ordinal 1
      false, false, false, true, // fire 8 → detail ordinal 2
      false, false,
    ]);
    expect(fired.filter((d) => d.detail).map((d) => d.detailOrdinal)).toEqual([1, 2]);
  });

  it("detailEvery: 1 makes every reminder detailed", () => {
    const c = cfg({ remindRefine: { enabled: true, everyTurns: 1, detailEvery: 1 } });
    evaluateReminder(c, 0); // seed
    for (let t = 1; t <= 3; t++) {
      const d = evaluateReminder(c, t);
      expect(d.detail).toBe(true);
      expect(d.detailOrdinal).toBe(t);
    }
  });

  it("rotation state resets with the reminder (fresh session, fresh cycle)", () => {
    const c = cfg({ remindRefine: { enabled: true, everyTurns: 1, detailEvery: 1 } });
    evaluateReminder(c, 0);
    expect(evaluateReminder(c, 1).detailOrdinal).toBe(1);
    resetReminder();
    evaluateReminder(c, 0); // re-seed
    expect(evaluateReminder(c, 1).fires).toBe(1); // counter restarted
  });
});

describe("detail library", () => {
  it("has at least 5 slots (issue #19 acceptance)", () => {
    expect(DETAIL_GUIDES.length).toBeGreaterThanOrEqual(5);
  });

  it("detailSlot rotates through every slot in order, cycling", () => {
    const n = DETAIL_GUIDES.length;
    const first = Array.from({ length: n }, (_, i) => detailSlot(i + 1));
    expect(first).toEqual([...Array(n).keys()]);
    expect(detailSlot(n + 1)).toBe(0); // wraps
    expect(detailSlot(0)).toBe(n - 1); // tolerant of a 0 ordinal
  });

  it("buildDetailGuide renders distinct content per slot and repeats the cycle", () => {
    const state = facts();
    const seen = new Set(
      Array.from({ length: DETAIL_GUIDES.length }, (_, i) => buildDetailGuide(i + 1, state)),
    );
    expect(seen.size).toBe(DETAIL_GUIDES.length); // every slot distinct
    // Cycle 2 repeats the same slot copy (variant only alternates slot 0).
    expect(buildDetailGuide(1 + DETAIL_GUIDES.length, state)).not.toBe(
      buildDetailGuide(1 + 2 * DETAIL_GUIDES.length, state),
    );
    expect(buildDetailGuide(2, state)).toBe(buildDetailGuide(2 + DETAIL_GUIDES.length, state));
  });

  it("the loop slot alternates between descriptions across cycles", () => {
    const state = facts();
    const a = buildDetailGuide(1, state); // cycle 1, variant 0
    const b = buildDetailGuide(1 + DETAIL_GUIDES.length, state); // cycle 2, variant 1
    const c = buildDetailGuide(1 + 2 * DETAIL_GUIDES.length, state); // cycle 3, variant 2
    const d = buildDetailGuide(1 + 3 * DETAIL_GUIDES.length, state); // cycle 4, variant 0 again
    expect(new Set([a, b, c]).size).toBe(DETAIL_LOOP_VARIANTS);
    expect(d).toBe(a); // variants themselves cycle
  });

  it("the guide footer states rotation position and the kill-switch", () => {
    const msg = buildDetailGuide(1, facts());
    expect(msg).toContain(`guide 1/${DETAIL_GUIDES.length}`);
    expect(msg).toContain("about every 100 completed turns"); // 25 × 4
    expect(msg).toContain('"remindRefine"');
  });
});

describe("buildNudge (cheap tier, data-aware garnish)", () => {
  it("carries the active/never-cited garnish when there is data", () => {
    const msg = buildNudge(facts({ activeItems: 12, neverCited: 4 }));
    expect(msg).toContain("12 active item(s)");
    expect(msg).toContain("4 never cited since creation");
    expect(msg).toContain("/refine");
    expect(msg).toContain('"remindRefine"');
  });

  it("omits the never-cited clause when everything has been touched", () => {
    const msg = buildNudge(facts({ activeItems: 3, neverCited: 0 }));
    expect(msg).toContain("3 active item(s)");
    expect(msg).not.toContain("never cited");
  });

  it("speaks to the empty store (fresh installs are the point)", () => {
    const msg = buildNudge(facts({ activeItems: 0, neverCited: 0 }));
    expect(msg).toContain("still empty");
    expect(msg).toContain("/refine");
    expect(msg).toContain('"remindRefine"');
  });
});

describe("reminderState (store-derived facts)", () => {
  beforeEach(() => {
    reconstruct([]);
    resetReminder();
  });

  it("counts active items and never-cited proxies from the live store", async () => {
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "fresh", evidence: "e1" },
        { op: "create", kind: "prompt", content: "touched", evidence: "e2" },
      ],
      () => {},
    );
    // Let the clock advance so the touch below lands on a later timestamp
    // (createdAt/updatedAt share millisecond precision).
    await new Promise((r) => setTimeout(r, 3));
    // Touch the second item so updatedAt > createdAt (a citation would too).
    applyDeltas(
      [{ op: "update", id: getState().items[1]!.id, importance: 0.6 }],
      () => {},
    );
    const state = reminderState({ ...DEFAULT_CONFIG });
    expect(state.activeItems).toBe(2);
    expect(state.neverCited).toBe(1);
    expect(state.everyTurns).toBe(25);
    expect(state.detailEvery).toBe(4);
  });

  it("empty store → zero facts", () => {
    expect(reminderState({ ...DEFAULT_CONFIG })).toMatchObject({ activeItems: 0, neverCited: 0 });
  });
});

describe("registerReminder end-to-end", () => {
  let dir: string;

  beforeEach(() => {
    reconstruct([]);
    resetReminder();
    dir = mkdtempSync(join(tmpdir(), "pi-ch-remind-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetConfigCache();
  });

  function primeConfig(cfgJson: object): Promise<void> {
    const file = join(dir, "harness.json");
    writeFileSync(file, JSON.stringify(cfgJson), "utf8");
    resetConfigCache();
    return loadConfig(file).then(() => undefined);
  }

  it("is on by default: nudges at 25, detailed at the 4th fire (turn 100)", async () => {
    await primeConfig({}); // no remindRefine key → defaults
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    const { registerReminder } = await import("../src/remind.js");
    registerReminder(pi);
    for (let t = 0; t <= 100; t++) {
      await fire("turn_end", { type: "turn_end", turnIndex: t }, ctx());
    }
    const nudges = notifications.filter((n) => /turns since the last check|still empty/.test(n.msg));
    const guides = notifications.filter((n) => /guide 1\/\d+/.test(n.msg));
    expect(nudges).toHaveLength(3); // turns 25, 50, 75
    expect(guides).toHaveLength(1); // turn 100 = 4th fire
    expect(guides[0]!.msg).toContain("Continual Harness");
  });

  it("explicit enabled: false restores silence (overridable in both directions)", async () => {
    await primeConfig({ remindRefine: { enabled: false } });
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    const { registerReminder } = await import("../src/remind.js");
    registerReminder(pi);
    for (let t = 0; t <= 60; t++) {
      await fire("turn_end", { type: "turn_end", turnIndex: t }, ctx());
    }
    expect(notifications).toHaveLength(0);
  });
});

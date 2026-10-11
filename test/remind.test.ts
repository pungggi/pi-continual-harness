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
  registerReminder,
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

/** Fire n COMPLETED turn_end evaluations (missing outcome = completed). */
function completed(c: HarnessConfig, n: number) {
  return Array.from({ length: n }, () => evaluateReminder(c));
}

describe("evaluateReminder", () => {
  beforeEach(resetReminder);

  it("never reminds when disabled", () => {
    const disabled = cfg({ remindRefine: { enabled: false, everyTurns: 5 } });
    for (const d of completed(disabled, 30)) expect(d.fire).toBe(false);
  });

  it("seeds a baseline on the first turn, then reminds exactly every N completed turns", () => {
    const enabled = cfg({ remindRefine: { enabled: true, everyTurns: 5 } });
    expect(evaluateReminder(enabled).fire).toBe(false); // seed (doesn't count)
    for (const d of completed(enabled, 4)) expect(d.fire).toBe(false);
    expect(evaluateReminder(enabled).fire).toBe(true); // 5th completed turn
    for (const d of completed(enabled, 4)) expect(d.fire).toBe(false);
    expect(evaluateReminder(enabled).fire).toBe(true); // cadence resets
  });

  it("never reminds when everyTurns <= 0", () => {
    const zero = cfg({ remindRefine: { enabled: true, everyTurns: 0 } });
    for (const d of completed(zero, 5)) expect(d.fire).toBe(false);
  });

  it("falls back to the default cadence (25) when everyTurns is absent", () => {
    const noEvery = cfg({ remindRefine: { enabled: true } });
    expect(evaluateReminder(noEvery).fire).toBe(false); // seed
    for (const d of completed(noEvery, 24)) expect(d.fire).toBe(false);
    expect(evaluateReminder(noEvery).fire).toBe(true); // new default 25
  });

  it("aborted/error turns neither seed nor advance the completed-turn count", () => {
    const enabled = cfg({ remindRefine: { enabled: true, everyTurns: 2 } });
    expect(evaluateReminder(enabled, "aborted").fire).toBe(false); // bad turn: no seed
    expect(evaluateReminder(enabled).fire).toBe(false); // seed
    expect(evaluateReminder(enabled, "error").fire).toBe(false); // skipped
    expect(evaluateReminder(enabled).fire).toBe(false); // 1st completed: no nudge
    expect(evaluateReminder(enabled).fire).toBe(true); // 2nd completed: nudge
    expect(evaluateReminder(enabled, undefined).fire).toBe(false); // undefined = completed
    expect(evaluateReminder(enabled, undefined).fire).toBe(true);
  });

  it("aborted turns do not advance the detail rotation either", () => {
    const c = cfg({ remindRefine: { enabled: true, everyTurns: 1, detailEvery: 1 } });
    evaluateReminder(c); // seed
    expect(evaluateReminder(c, "aborted").fires).toBe(0); // inert, no rotation
    expect(evaluateReminder(c).detailOrdinal).toBe(1);
  });

  it("escalates to the detailed tier every detailEvery-th fired reminder", () => {
    const c = cfg({ remindRefine: { enabled: true, everyTurns: 1, detailEvery: 4 } });
    evaluateReminder(c); // seed (doesn't count)
    const fired = completed(c, 10).filter((d) => d.fire);
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
    evaluateReminder(c); // seed
    for (let n = 1; n <= 3; n++) {
      const d = evaluateReminder(c);
      expect(d.detail).toBe(true);
      expect(d.detailOrdinal).toBe(n);
    }
  });

  it("rotation state resets with the reminder (fresh session, fresh cycle)", () => {
    const c = cfg({ remindRefine: { enabled: true, everyTurns: 1, detailEvery: 1 } });
    evaluateReminder(c); // seed
    expect(evaluateReminder(c).detailOrdinal).toBe(1);
    resetReminder();
    evaluateReminder(c); // re-seed
    expect(evaluateReminder(c).fires).toBe(1); // counter restarted
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

  it("guide copy is truthful (review #28): decay needs <days>; the starter config owns its autonomy", () => {
    const state = facts();
    // Slot 0's decay mention must carry the required <days> argument.
    expect(buildDetailGuide(1, state)).toContain("--decay <days>");
    expect(buildDetailGuide(1, state)).not.toContain("--decay)");
    // The starter-config slot must not pair autoImport: true with a
    // "commit false is the safe option" claim — autoImport already writes
    // durable layers autonomously on every store change.
    const starter = buildDetailGuide(DETAIL_GUIDES.length, state);
    expect(starter).toContain("autoImport");
    expect(starter).toContain("autonomous");
    expect(starter).not.toContain("Keep commit false until you trust");
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
    registerReminder(pi);
    for (let t = 0; t <= 100; t++) {
      // Synthetic events carry no outcome → treated as completed (0.14.0).
      await fire("turn_end", { type: "turn_end", turnIndex: t }, ctx());
    }
    const nudges = notifications.filter((n) => /turns since the last check|still empty/.test(n.msg));
    const guides = notifications.filter((n) => /guide 1\/\d+/.test(n.msg));
    expect(nudges).toHaveLength(3); // turns 25, 50, 75
    expect(guides).toHaveLength(1); // turn 100 = 4th fire
    expect(guides[0]!.msg).toContain("Continual Harness");
  });

  it("aborted turns are inert end-to-end: they never advance the cadence", async () => {
    await primeConfig({ remindRefine: { everyTurns: 3 } });
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    registerReminder(pi);
    await fire("turn_end", { type: "turn_end", turnIndex: 0 }, ctx()); // seed
    for (let t = 1; t <= 20; t++) {
      await fire("turn_end", { type: "turn_end", turnIndex: t, outcome: "aborted" }, ctx());
    }
    expect(notifications).toHaveLength(0); // 20 aborted turns → still just the seed
  });

  it("explicit enabled: false restores silence (overridable in both directions)", async () => {
    await primeConfig({ remindRefine: { enabled: false } });
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    registerReminder(pi);
    for (let t = 0; t <= 60; t++) {
      await fire("turn_end", { type: "turn_end", turnIndex: t }, ctx());
    }
    expect(notifications).toHaveLength(0);
  });
});

describe("registerReminder (event counting, review #26)", () => {
  let dir: string;

  beforeEach(() => {
    resetReminder();
    dir = mkdtempSync(join(tmpdir(), "pi-ch-remind-"));
    writeFileSync(
      join(dir, "harness.json"),
      JSON.stringify({ remindRefine: { enabled: true, everyTurns: 5 } }),
      "utf8",
    );
    resetConfigCache();
    return loadConfig(join(dir, "harness.json")).then(() => undefined);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts turn_end events, not pi's per-run turnIndex (reset to 0 each agent_start)", async () => {
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    registerReminder(pi);
    // 6 separate prompts, each a fresh agent run → turnIndex resets to 0
    // every time. Absolute-index math would NEVER reach a 5-turn cadence;
    // event counting does (seed on the first, fire 5 events later).
    for (let i = 0; i < 6; i++) {
      await fire("turn_end", { type: "turn_end", turnIndex: 0 }, ctx());
    }
    expect(notifications.some((n) => n.msg.includes("/refine"))).toBe(true);
  });

  it("does not fire before the cadence elapses", async () => {
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    registerReminder(pi);
    for (let i = 0; i < 5; i++) {
      await fire("turn_end", { type: "turn_end", turnIndex: 0 }, ctx());
    }
    expect(notifications).toHaveLength(0);
  });
});

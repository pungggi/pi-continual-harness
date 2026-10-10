import { describe, it, expect, beforeEach } from "vitest";
import { evaluateReminder, resetReminder } from "../src/remind.js";
import type { HarnessConfig } from "../src/config.js";

const cfg = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  durableScope: "global",
  remindRefine: { enabled: true, everyTurns: 5 },
  ...over,
});

describe("evaluateReminder", () => {
  beforeEach(resetReminder);

  it("never reminds when disabled", () => {
    const disabled = cfg({ remindRefine: { enabled: false, everyTurns: 5 } });
    for (let i = 0; i < 30; i++) {
      expect(evaluateReminder(disabled, i)).toBe(false);
    }
  });

  it("seeds a baseline on the first turn, then reminds exactly every N turns", () => {
    const enabled = cfg({ remindRefine: { enabled: true, everyTurns: 5 } });
    expect(evaluateReminder(enabled, 0)).toBe(false); // seed baseline at 0
    expect(evaluateReminder(enabled, 1)).toBe(false);
    expect(evaluateReminder(enabled, 4)).toBe(false);
    expect(evaluateReminder(enabled, 5)).toBe(true); // first nudge
    expect(evaluateReminder(enabled, 6)).toBe(false);
    expect(evaluateReminder(enabled, 9)).toBe(false);
    expect(evaluateReminder(enabled, 10)).toBe(true); // second nudge, cadence resets
    expect(evaluateReminder(enabled, 14)).toBe(false);
    expect(evaluateReminder(enabled, 15)).toBe(true); // third nudge
  });

  it("never reminds when everyTurns <= 0", () => {
    const zero = cfg({ remindRefine: { enabled: true, everyTurns: 0 } });
    expect(evaluateReminder(zero, 0)).toBe(false);
    expect(evaluateReminder(zero, 1000)).toBe(false);
  });

  it("falls back to the default cadence when everyTurns is absent", () => {
    const noEvery = cfg({ remindRefine: { enabled: true } });
    expect(evaluateReminder(noEvery, 0)).toBe(false); // seed
    expect(evaluateReminder(noEvery, 49)).toBe(false);
    expect(evaluateReminder(noEvery, 50)).toBe(true); // default 50
  });

  it("aborted/error turns neither seed nor advance the cadence window", () => {
    const enabled = cfg({ remindRefine: { enabled: true, everyTurns: 5 } });
    expect(evaluateReminder(enabled, 0, "aborted")).toBe(false); // no seed
    expect(evaluateReminder(enabled, 2)).toBe(false); // seed at 2
    expect(evaluateReminder(enabled, 6, "error")).toBe(false); // bad turn: no nudge
    expect(evaluateReminder(enabled, 7)).toBe(true); // 7 - 2 >= 5
    expect(evaluateReminder(enabled, 12, undefined)).toBe(true); // undefined = completed
  });
});

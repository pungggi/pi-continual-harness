import { describe, it, expect, beforeEach } from "vitest";
import { evaluateReminder, resetReminder } from "../src/remind.js";
import type { HarnessConfig } from "../src/config.js";

const cfg = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  remindRefine: { enabled: true, everyTurns: 5 },
  ...over,
});

describe("evaluateReminder", () => {
  beforeEach(resetReminder);

  it("never reminds when disabled", () => {
    const disabled = cfg({ remindRefine: { enabled: false, everyTurns: 5 } });
    for (let i = 0; i < 30; i++) {
      expect(evaluateReminder(disabled)).toBe(false);
    }
  });

  it("seeds a baseline on the first turn, then reminds exactly every N completed turns", () => {
    const enabled = cfg({ remindRefine: { enabled: true, everyTurns: 5 } });
    expect(evaluateReminder(enabled)).toBe(false); // seed (doesn't count)
    for (let n = 1; n < 5; n++) expect(evaluateReminder(enabled)).toBe(false);
    expect(evaluateReminder(enabled)).toBe(true); // 5th completed turn
    for (let n = 1; n < 5; n++) expect(evaluateReminder(enabled)).toBe(false);
    expect(evaluateReminder(enabled)).toBe(true); // cadence resets
  });

  it("never reminds when everyTurns <= 0", () => {
    const zero = cfg({ remindRefine: { enabled: true, everyTurns: 0 } });
    for (let i = 0; i < 5; i++) {
      expect(evaluateReminder(zero)).toBe(false);
    }
  });

  it("falls back to the default cadence when everyTurns is absent", () => {
    const noEvery = cfg({ remindRefine: { enabled: true } });
    expect(evaluateReminder(noEvery)).toBe(false); // seed
    for (let n = 1; n < 50; n++) expect(evaluateReminder(noEvery)).toBe(false);
    expect(evaluateReminder(noEvery)).toBe(true); // default 50
  });

  it("aborted/error turns neither seed nor advance the completed-turn count", () => {
    const enabled = cfg({ remindRefine: { enabled: true, everyTurns: 2 } });
    expect(evaluateReminder(enabled, "aborted")).toBe(false); // bad turn: no seed
    expect(evaluateReminder(enabled)).toBe(false); // seed
    expect(evaluateReminder(enabled, "error")).toBe(false); // skipped
    expect(evaluateReminder(enabled)).toBe(false); // 1st completed — no nudge
    expect(evaluateReminder(enabled)).toBe(true); // 2nd completed — nudge
    expect(evaluateReminder(enabled, undefined)).toBe(false); // undefined = completed, count reset
    expect(evaluateReminder(enabled, undefined)).toBe(true);
  });
});

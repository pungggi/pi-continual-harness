import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateReminder, registerReminder, resetReminder } from "../src/remind.js";
import { loadConfig, resetConfigCache, type HarnessConfig } from "../src/config.js";
import { makeFakePi } from "./helpers.js";

const cfg = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
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
    expect(notifications.some((n) => /consider running \/refine/.test(n.msg))).toBe(true);
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

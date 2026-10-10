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

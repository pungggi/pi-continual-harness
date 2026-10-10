// turn_end reminder (Phase 2 of the roadmap). Purely informational — it nudges
// the user to run /refine on a cadence; it never mutates state. Opt-in via
// harness.json { remindRefine: { enabled: true, everyTurns: 50 } }.
//
// The decision logic is factored into evaluateReminder() so it is unit-testable
// without a live pi runtime; registerReminder() is thin glue over pi.on. The
// cadence counts completed turn_end EVENTS (session-stable), not pi's
// `turnIndex` — pi resets that to 0 on every agent_start (each user prompt),
// so absolute-index deltas would never accumulate across prompts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_EVERY_TURNS, type HarnessConfig, loadConfig } from "./config.js";

// turnIndex of the last reminder (or the baseline we seeded from). -1 = unseen.
let lastTurn = -1;

// Completed turn_end events this session (the cadence's ordinal).
let turnsSeen = 0;

/** Test hook: reset internal counter. */
export function resetReminder(): void {
  lastTurn = -1;
  turnsSeen = 0;
}

/**
 * Decide whether to remind this turn. Side-effectful: the first observed turn
 * seeds the baseline (no reminder then), and each fired reminder resets it.
 * `turnOrdinal` is the session-stable count of completed turn_end events (NOT
 * pi's per-run `turnIndex`, which resets every agent_start). Returns true
 * when it is time to nudge.
 */
export function evaluateReminder(config: HarnessConfig, turnOrdinal: number): boolean {
  if (!config.remindRefine?.enabled) return false;
  const every = config.remindRefine.everyTurns ?? DEFAULT_EVERY_TURNS;
  if (every <= 0) return false;
  if (lastTurn < 0) {
    lastTurn = turnOrdinal;
    return false;
  }
  if (turnOrdinal - lastTurn >= every) {
    lastTurn = turnOrdinal;
    return true;
  }
  return false;
}

/** Subscribe to turn_end and notify on the configured cadence. */
export function registerReminder(pi: ExtensionAPI): void {
  pi.on("turn_end", async (_event, ctx) => {
    const config = await loadConfig();
    turnsSeen += 1; // session-stable ordinal — see the header comment
    if (!evaluateReminder(config, turnsSeen)) return;
    const every = config.remindRefine?.everyTurns ?? DEFAULT_EVERY_TURNS;
    ctx.ui.notify(
      `${every} turns since the last check — consider running /refine to refine harness state.`,
      "info",
    );
  });
}

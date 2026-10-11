// turn_end reminder (Phase 2 of the roadmap). Purely informational — it nudges
// the user to run /refine on a cadence; it never mutates state. Opt-in via
// harness.json { remindRefine: { enabled: true, everyTurns: 50 } }.
//
// The decision logic is factored into evaluateReminder() so it is unit-testable
// without a live pi runtime; registerReminder() is thin glue over pi.on.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_EVERY_TURNS, type HarnessConfig, loadConfig } from "./config.js";
import { turnEndedBadly } from "./auto-refine.js";

// Completed turns observed since the last reminder (or the seeded baseline).
// -1 = unseen. Aborted/error turns never touch this count.
let completedTurns = -1;

/** Test hook: reset internal counter. */
export function resetReminder(): void {
  completedTurns = -1;
}

/**
 * Decide whether to remind this turn. Side-effectful: the first observed
 * completed turn seeds the baseline (no reminder then); every completed turn
 * after it advances the count, and each fired reminder resets it.
 * Aborted/error turns are inert — the cadence counts completed turns of work,
 * never raw turn indices. Returns true when it is time to nudge.
 */
export function evaluateReminder(config: HarnessConfig, outcome?: string): boolean {
  if (!config.remindRefine?.enabled) return false;
  if (turnEndedBadly(outcome)) return false;
  const every = config.remindRefine.everyTurns ?? DEFAULT_EVERY_TURNS;
  if (every <= 0) return false;
  if (completedTurns < 0) {
    completedTurns = 0; // seed: the seed turn itself doesn't count
    return false;
  }
  completedTurns += 1;
  if (completedTurns >= every) {
    completedTurns = 0;
    return true;
  }
  return false;
}

/** Subscribe to turn_end and notify on the configured cadence. */
export function registerReminder(pi: ExtensionAPI): void {
  pi.on("turn_end", async (event, ctx) => {
    const config = await loadConfig();
    if (!evaluateReminder(config, event.outcome)) return;
    const every = config.remindRefine?.everyTurns ?? DEFAULT_EVERY_TURNS;
    ctx.ui.notify(
      `${every} turns since the last check — consider running /refine to refine harness state.`,
      "info",
    );
  });
}

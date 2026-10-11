// Shared completed-turn cadence counter (review simplification #1).
//
// Three features — auto-refine, the /refine reminder, and the import-awareness
// reminder — used to each re-implement the same side-effectful counter: seed
// on the first observed COMPLETED turn, count completed turns, fire and reset
// every N. They drifted once already (review #26's turnIndex → turn_end fix
// had to touch several of them), so the counter now lives here exactly once.
//
// Semantics (identical for every consumer):
//  - Aborted/error turns are inert: they neither seed nor advance the count,
//    so an aborted turn in between can never shorten the window.
//  - The seed turn itself does not count.
//  - every <= 0 disables the cadence (tick never fires).
//  - Firing resets the count, so the firing turn itself never re-triggers.

/** True when a turn_end's outcome marks a turn that ended badly (pi's
 *  BoundaryState.outcome: "aborted" | "error"). Undefined is treated as
 *  completed — current pi always reports the field, but synthetic events and
 *  the earliest 0.99.x may omit it. */
export function turnEndedBadly(outcome?: string): boolean {
  return outcome === "aborted" || outcome === "error";
}

export interface TurnCadence {
  /** Observe a turn boundary; true when the cadence fires this turn.
   *  Aborted/error outcomes and every <= 0 are inert (state untouched). */
  tick(every: number, outcome?: string): boolean;
  /** Back to the unseen baseline (session_start: a fork/resume opens a fresh window). */
  reset(): void;
}

/** One independent cadence counter. Feature gates stay with the caller. */
export function makeTurnCadence(): TurnCadence {
  // Completed turns observed since the last fire (or the seeded baseline).
  // -1 = unseen.
  let completedTurns = -1;
  return {
    tick(every, outcome) {
      if (turnEndedBadly(outcome)) return false;
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
    },
    reset() {
      completedTurns = -1;
    },
  };
}

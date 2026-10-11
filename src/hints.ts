// One-line feature hints for `/harness status` (issue #20) — a rotating,
// contextual "advertisement" of under-discovered features, so the package's
// value compounds visibly instead of silently.
//
// This module is the shared COPY SOURCE for single-line nudges: issue #19's
// rotating educational content library (detailed tier) should import its
// one-liners from (or live beside) this file so both features speak with one
// voice. Copy stays terse on purpose — one line, one feature, one action.
//
// Rotation & dedupe: at most one hint per /harness status call, never the hint
// shown on the previous call (when an alternative exists). The decision is a
// pure function (pickHint); the tiny cursor memory (cursor + last shown id)
// is module-scoped and reset on session_start, like remind.ts / outcome.ts.

/** A single one-line feature hint. */
export interface StatusHint {
  /** Stable id (dedupe + rotation bookkeeping). */
  id: string;
  /** One-line copy; markdown backticks render in the TUI as-is. */
  text: string;
}

/**
 * Pick the next hint from `hints`, starting the rotation at `startAt` and
 * skipping `lastId` (the hint shown last) when an alternative exists — so
 * back-to-back status calls never repeat themselves. Pure; returns the pick
 * plus the next start index. Undefined when nothing applies.
 */
export function pickHint(
  hints: StatusHint[],
  startAt: number,
  lastId?: string,
): { hint: StatusHint; next: number } | undefined {
  if (hints.length === 0) return undefined;
  if (hints.length === 1) return { hint: hints[0]!, next: 1 % hints.length };
  for (let step = 0; step < hints.length; step++) {
    const idx = (startAt + step) % hints.length;
    const hint = hints[idx]!;
    if (hint.id !== lastId) return { hint, next: (idx + 1) % hints.length };
  }
  // Degenerate: every hint shares the last-shown id — show the cursor target.
  return { hint: hints[startAt % hints.length]!, next: (startAt + 1) % hints.length };
}

// ---- session-scoped cursor ---------------------------------------------------

let cursor = 0;
let lastId: string | undefined;

/** Test/session hook: reset the rotation cursor and dedupe memory. */
export function resetHints(): void {
  cursor = 0;
  lastId = undefined;
}

/**
 * Select the next hint from the applicable list, advancing the session cursor
 * and remembering the pick for next-call dedupe. Side-effectful by design
 * (one call = one rotation); pure selection lives in pickHint.
 */
export function nextHint(applicable: StatusHint[]): StatusHint | undefined {
  const pick = pickHint(applicable, cursor, lastId);
  if (!pick) return undefined;
  cursor = pick.next;
  lastId = pick.hint.id;
  return pick.hint;
}

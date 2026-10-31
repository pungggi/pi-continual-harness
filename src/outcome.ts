// turn_end outcome loop (Phase 5 / limit B-phase-2). The package's SECOND
// autonomous-mutation path (after auto-refine), so — like auto-refine — it is
// locked behind an explicit opt-in:
//
//   ~/.pi/agent/harness.json
//   { "outcomeImportance": { "enabled": true, "bump": 0.03 } }
//
// What it does: when the agent's own output cites an injected item by its
// [h_xxxx] tag, that is unambiguous POSITIVE evidence the item was useful, so
// we nudge its importance up (+bump). This closes the outcome half of the
// fitness loop that manual /harness keep|drop (B-phase-1) and /harness prune
// --decay (A) started: useful items gain importance AND get their updatedAt
// touched (so they survive time-based decay); ignored items keep decaying.
//
// Hard scope cut — CORRECTION/demotion from outcomes is genuinely fuzzy and
// high-false-positive, so it is intentionally NOT autonomized here. Demotion is
// served by the existing audited, reviewable primitives: /harness drop,
// /harness prune --decay, and the dedupe proposer. (See ROADMAP.md.)
//
// Safety properties (promotion only, never deletes): clamped to [0,1]; persisted
// via the same harness-state entries as harness_mutate (branch-local, /tree
// rollback); visible (notify per turn). Pure reference extraction is factored
// into findReferences() so it is unit-testable without a live pi runtime.

import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_REF_BUMP, loadConfig } from "./config.js";
import { turnEndedBadly } from "./auto-refine.js";
import { bumpImportance, getState, makePersist, modelKey } from "./store.js";
import { messageText } from "./refine.js";
import type { AnyEntry } from "./types.js";

// Matches [h_xxxx] citation tags (the same form inject.ts emits).
const REF_RE = /\[(h_[a-z0-9_]+)\]/gi;

/**
 * Extract distinct harness-item ids the agent cited by their [h_xxxx] tag,
 * keeping only those that are currently known (active or not). Pure.
 */
export function findReferences(text: string, knownIds: Set<string>): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(REF_RE)) {
    const id = m[1]!.toLowerCase();
    if (knownIds.has(id)) found.add(id);
  }
  return [...found];
}

// Number of assistant message-entries already consumed. -1 = unseen; the first
// observed turn_end seeds the cursor (so enabling mid-session never bumps
// retroactively for the whole history).
let scannedMessages = -1;

/** Test hook: reset internal cursor. */
export function resetOutcome(): void {
  scannedMessages = -1;
}

/** turn_end handler — promote importance of referenced items (opt-in).
 *  Exported so the thin entry (entry.ts) can delegate via dynamic import
 *  (issue #36). */
export async function handleOutcomeTurnEnd(
  pi: ExtensionAPI,
  event: TurnEndEvent,
  ctx: ExtensionContext,
): Promise<void> {
  const config = await loadConfig();
  if (!config.outcomeImportance?.enabled) return;
  const bump = config.outcomeImportance.bump ?? DEFAULT_REF_BUMP;
  if (bump <= 0) return;

  const entries = ctx.sessionManager.getBranch() as AnyEntry[];
  const asst = entries.filter((e) => e.type === "message" && e.message?.role === "assistant");
  if (scannedMessages < 0) {
    // Seed on the FIRST observed turn_end regardless of outcome: enabling
    // mid-session never bumps retroactively, and the seed turn's own text
    // (partial or not) is never scanned — the same swallow as a normal
    // seed. Seeding here is what keeps a later completed turn's own
    // citations scannable after an aborted first observation.
    scannedMessages = asst.length;
    return;
  }
  // Aborted/error turns end mid-work: their partial assistant text is not a
  // final outcome. The cursor holds; the next completed turn scans that text
  // together with its own.
  if (turnEndedBadly(event.outcome)) return;
  const fresh = asst.slice(scannedMessages);
  scannedMessages = asst.length;

  const text = fresh.map((e) => messageText(e.message?.content)).join("\n");
  if (!text.trim()) return;

  // Only the active model's items are injected, so only those can be cited.
  // Filter accordingly; an unknown model → no candidates → no bumps.
  const key = modelKey(ctx.model);
  const activeIds = new Set(
    key === undefined
      ? []
      : getState()
          .items.filter((i) => i.active && i.ownerModel === key)
          .map((i) => i.id),
  );
  const refs = findReferences(text, activeIds);
  if (refs.length === 0) return;

  let bumped = 0;
  for (const id of refs) {
    // "citation" records the support signal (Harness²: retention needs
    // execution evidence, not creation-time enthusiasm).
    const item = bumpImportance(id, bump, makePersist(pi), { support: "citation" });
    if (item) bumped += 1;
  }
  if (bumped > 0) {
    ctx.ui.notify(
      `Outcome: +${bump} importance for ${bumped} referenced item(s): ${refs.join(", ")}`,
      "info",
    );
  }
}

/** Subscribe to turn_end and promote importance of referenced items (opt-in). */
export function registerOutcome(pi: ExtensionAPI): void {
  pi.on("turn_end", (event, ctx) => handleOutcomeTurnEnd(pi, event, ctx));
}

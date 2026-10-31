// turn_end /refine reminder — the activation nudge. Notify-only by design:
// it never mutates state, which is why it is ON by default (issue #19).
// Explicit config always wins; `"remindRefine": { "enabled":
// false }` restores the old silence.
//
// Two tiers, rotated so the nudge teaches instead of nagging:
//   short  — every `everyTurns` (default 25) completed turns: a one-line
//            nudge with cheap data garnish from the live store.
//   detail — every `detailEvery`-th fired reminder (default 4, i.e. roughly
//            every 100 turns at the default cadence): an educational guide
//            from a rotating library (how the loop works — with alternate
//            descriptions so it never reads as boilerplate — the /refine
//            workflow, hygiene, push-mem, split, export-corpus, and the
//            recommended starter config).
//
// The decision logic is factored into evaluateReminder() and the copy into
// pure builders (buildNudge / buildDetailGuide) so they are unit-testable
// without a live pi runtime — and reusable by the richer /harness status
// (companion issue). Cadence counting follows the 0.14.0 semantics (#18):
// everyTurns literally counts COMPLETED turns — aborted/error turns are
// inert (they neither seed nor advance the window), a missing outcome
// (synthetic events, earliest 0.99.x) counts as completed.

import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_DETAIL_EVERY,
  DEFAULT_EVERY_TURNS,
  type HarnessConfig,
  loadConfig,
} from "./config.js";
import { makeTurnCadence } from "./cadence.js";
import { getState } from "./store.js";

// The reminder cadence counter (shared implementation — see cadence.ts).
const cadence = makeTurnCadence();
// Fired reminders this session — the rotation seed for the detailed tier.
let fires = 0;

/** Test hook: reset cadence baseline and rotation state. */
export function resetReminder(): void {
  cadence.reset();
  fires = 0;
}

/** Snapshot of everything the copy builders need. Pure over the live store
 *  and the resolved config — no new persisted state (issue #19 garnish). */
export interface ReminderState {
  /** Active items in the whole store. */
  activeItems: number;
  /** Active items never touched since creation (updatedAt === createdAt —
   *  citations and updates both touch updatedAt, so this is a cheap
   *  "never cited" proxy). */
  neverCited: number;
  /** Resolved nudge cadence. */
  everyTurns: number;
  /** Resolved escalation cadence (every Nth fired reminder is detailed). */
  detailEvery: number;
}

/** Derive the builder input from the live store + resolved config. */
export function reminderState(config: HarnessConfig): ReminderState {
  const active = getState().items.filter((i) => i.active);
  return {
    activeItems: active.length,
    neverCited: active.filter((i) => i.updatedAt === i.createdAt).length,
    everyTurns: config.remindRefine?.everyTurns ?? DEFAULT_EVERY_TURNS,
    detailEvery: config.remindRefine?.detailEvery ?? DEFAULT_DETAIL_EVERY,
  };
}

/** Outcome of evaluateReminder: whether to fire, and at which tier. */
export interface ReminderDecision {
  fire: boolean;
  /** True when this fire is the detailed tier (every detailEvery-th fire). */
  detail: boolean;
  /** 1-based count of fired reminders this session (0 when not firing). */
  fires: number;
  /** 1-based ordinal among DETAIL fires (0 when this fire is a short nudge). */
  detailOrdinal: number;
}

/**
 * Decide whether to remind this turn. Side-effectful: the first observed
 * COMPLETED turn seeds the baseline (no reminder then); every completed turn
 * after it advances the count, each fired reminder resets it, and the fire
 * count advances the detail-tier rotation. Aborted/error turns are inert.
 */
export function evaluateReminder(config: HarnessConfig, outcome?: string): ReminderDecision {
  const idle: ReminderDecision = { fire: false, detail: false, fires, detailOrdinal: 0 };
  if (!config.remindRefine?.enabled) return idle;
  const every = config.remindRefine.everyTurns ?? DEFAULT_EVERY_TURNS;
  if (!cadence.tick(every, outcome)) return idle;
  fires += 1;
  const detailEvery = config.remindRefine.detailEvery ?? DEFAULT_DETAIL_EVERY;
  const detail = detailEvery > 0 && fires % detailEvery === 0;
  return {
    fire: true,
    detail,
    fires,
    detailOrdinal: detail ? Math.floor(fires / detailEvery) : 0,
  };
}

/** Alternate descriptions of the core loop, rotated per library cycle so the
 *  explanation doesn't read as boilerplate on repeat viewings. */
export const DETAIL_LOOP_VARIANTS = 3;

/** Input every guide builder receives: the data snapshot + which alternate
 *  variant applies (only the loop slot uses `variant`; others ignore it). */
export interface GuideInput {
  state: ReminderState;
  variant: number;
}

/** The rotating detailed-guide library. Order is the rotation order. */
export const DETAIL_GUIDES: Array<(g: GuideInput) => string> = [
  // Slot 0 — how the package works (alternates between descriptions).
  ({ variant }) => {
    if (variant % 3 === 1) {
      return [
        "Continual Harness: why it exists",
        "Every correction you repeat by hand is a prompt improvement waiting to be captured. This package captures them:",
        "- Structured items (prompt notes, memories, skill descriptions, sub-agent specs), each grounded in trajectory evidence and scored by importance.",
        "- Injected each turn, importance-ordered within a token budget: the strongest knowledge makes the cut, not the loudest.",
        "- Audited and reversible: every mutation is a delta on the branch, and /tree rolls it back.",
        "- Composable: durable layers sync sessions (autoImport), pi-mem indexes items (push-mem), pi-reflex calibrates (export-corpus).",
        "/refine is the entry point: it proposes deltas from what just happened.",
      ].join("\n");
    }
    if (variant % 3 === 2) {
      return [
        "Continual Harness: the machinery, briefly",
        "- A store of evidence-backed items (four kinds: prompt, memory, skill, sub-agent), created only through audited deltas.",
        "- A selector that renders the important ones into each turn's system prompt within a budget (default 1500 tokens).",
        "- A fitness loop: /harness keep|drop nudges importance, [h_xxxx] citations promote (opt-in outcomeImportance), decay prunes the rest.",
        "- A durable seam: export/import layers the store across sessions; autoImport automates it.",
        "The habit that powers all of it: run /refine when a session teaches you something.",
      ].join("\n");
    }
    return [
      "Continual Harness: how it works, the loop",
      "- **Work**: the session runs normally; nothing mutates behind your back.",
      "- **/refine**: reviews the recent trajectory and proposes evidence-backed structured deltas (create / update / delete).",
      "- **Injection**: active items surface in the system prompt each turn, importance-ordered within a token budget, so the prompt stays finite as the store grows.",
      "- **Outcome citations**: with outcomeImportance on, any item you cite by its [h_xxxx] tag gains importance.",
      "- **Decay**: untouched items fade (/harness prune --decay <days>); cited and kept ones survive.",
      "Run /refine now to turn this session's corrections into durable items.",
    ].join("\n");
  },
  // Slot 1 — the /refine workflow.
  () =>
    [
      "Continual Harness: the /refine workflow",
      "1. Run /refine whenever a session taught you something (it never fires on its own unless you opt into autoRefine).",
      "2. The agent reviews the recent trajectory (default lookback ~25 turns) and proposes structured deltas; every create cites evidence.",
      "3. Deltas apply through the same audited path as harness_mutate: branch-local, /tree rollback-able.",
      "4. /refine --commit additionally flushes the durable layer files.",
      "Check /harness status afterward; an empty listing is diagnostic, not broken.",
    ].join("\n"),
  // Slot 2 — importance hygiene.
  () =>
    [
      "Continual Harness: importance hygiene with keep / drop / prune",
      "- **/harness keep <id>**: +0.1 importance: you noticed an item paying off.",
      "- **/harness drop <id>**: -0.1 importance: it stopped earning its prompt space.",
      "- **/harness prune --decay <days>**: ages untouched items, prunes those below the 0.3 floor.",
      "Why bother: importance orders the injection budget, so honest scores keep the strongest items in the prompt and let stale ones go. With outcomeImportance on, citing an item by its [h_xxxx] tag promotes it automatically; decay does the demoting.",
    ].join("\n"),
  // Slot 3 — composing with pi-mem.
  () =>
    [
      "Continual Harness: /harness push-mem, composing with pi-mem",
      "- Pushes active items into pi-mem's semantic memory (default: memory-kind items; --all, --kind <kind>, --model <id|active> to scope) by steering the agent to call save_memory.",
      "- No dependency is assumed: if no memory tool is installed, the agent says so instead of fabricating one.",
      "- The harness store is untouched: pi-mem gets a copy that stays searchable across sessions.",
      "Install the companion with: pi install npm:pi-mem",
    ].join("\n"),
  // Slot 4 — durable scopes.
  () =>
    [
      "Continual Harness: /harness split, global vs project scope",
      "- Every item lives in one durable layer: global (~/.pi/agent/harness-state.md) or per-project (harness-state/<slug>.md).",
      "- /harness split steers the agent to classify every active item in one audited batch; /harness move <id> <global|project> moves a single one.",
      "- Why it matters: project quirks stop leaking into unrelated sessions while general lessons travel everywhere. With autoImport on, both layers sync themselves.",
    ].join("\n"),
  // Slot 5 — calibration corpus.
  () =>
    [
      "Continual Harness: /harness export-corpus, calibration for pi-reflex",
      "- Exports the branch's audit trail as two JSONL files (dedupe pairs + lifecycle events) into ./harness-corpus/<date>/.",
      "- Local files only: nothing leaves your machine.",
      "- Feed them to pi-reflex to calibrate dedupe thresholds and prune policy against your real sessions.",
    ].join("\n"),
  // Slot 6 — the recommended starter config.
  ({ state }) =>
    [
      "Continual Harness: a recommended starter config (~/.pi/agent/harness.json)",
      "{",
      '  "autoImport": true,',
      '  "importRemind": { "enabled": true, "everyTurns": 25 },',
      '  "remindRefine": { "enabled": true, "everyTurns": 25, "detailEvery": 4 },',
      '  "autoRefine": { "enabled": true, "everyTurns": 100, "gate": true, "commit": false },',
      '  "outcomeImportance": { "enabled": true, "bump": 0.03 },',
      '  "classifier": { "model": "typesafe/jev-latest" }',
      "}",
      `Guidance: gate (needs classifier.model) spends one cheap yes/no question before each auto-refine, so cadence becomes signal. Durable writes are autonomous in this config: with autoImport on, the layers re-export on every store change (that is what makes /refine output survive into new sessions); commit only adds a flush at each auto-run and matters when autoImport is off. Prefer autoImport off + manual /harness export until you trust the refinements, then opt in. This nudge fires every ${state.everyTurns} completed turns and shows a guide every ${state.detailEvery}th reminder (about every ${state.everyTurns * state.detailEvery} completed turns).`,
    ].join("\n"),
];

/** Rotation slot for the ordinal-th detailed reminder (1-based, pure). */
export function detailSlot(ordinal: number): number {
  const n = DETAIL_GUIDES.length;
  return (((Math.trunc(ordinal) - 1) % n) + n) % n;
}

/** Variant index for the loop slot: advances once per full library cycle,
 *  so each time slot 0 comes back it reads differently. Pure. */
function loopVariant(ordinal: number): number {
  return Math.floor((Math.trunc(ordinal) - 1) / DETAIL_GUIDES.length) % DETAIL_LOOP_VARIANTS;
}

/** The one-line nudge with data-aware garnish. Pure. */
export function buildNudge(state: ReminderState): string {
  const disable = `"remindRefine": { "enabled": false }`;
  if (state.activeItems === 0) {
    return (
      `Continual Harness: ${state.everyTurns} turns and the harness store is still empty. ` +
      `Run /refine after a few more turns to capture your first evidence-backed item ` +
      `(disable via ${disable} in harness.json).`
    );
  }
  const garnish =
    state.neverCited > 0
      ? ` (${state.activeItems} active item(s), ${state.neverCited} never cited since creation`
      : ` (${state.activeItems} active item(s)`;
  return (
    `Continual Harness: ${state.everyTurns} turns since the last check. ` +
    `Consider /refine to capture durable corrections${garnish}; disable via ${disable} in harness.json).`
  );
}

/** The detailed educational guide for the ordinal-th detailed reminder
 *  (1-based). Rotates through DETAIL_GUIDES; the loop slot additionally
 *  alternates between descriptions. Pure. */
export function buildDetailGuide(ordinal: number, state: ReminderState): string {
  const slot = detailSlot(ordinal);
  const body = DETAIL_GUIDES[slot]!({ state, variant: loopVariant(ordinal) });
  const period = state.everyTurns * state.detailEvery;
  const footer =
    `\n(guide ${slot + 1}/${DETAIL_GUIDES.length}; detailed guides rotate every ${state.detailEvery}th ` +
    `reminder, about every ${period} completed turns; disable via "remindRefine": { "enabled": false } in harness.json)`;
  return `${body}${footer}`;
}

/** turn_end handler — notify on the configured cadence. Exported so the
 *  thin entry (entry.ts) can delegate via dynamic import (issue #36). */
export async function handleRemindTurnEnd(
  event: TurnEndEvent,
  ctx: ExtensionContext,
): Promise<void> {
  const config = await loadConfig();
  const decision = evaluateReminder(config, event.outcome);
  if (!decision.fire) return;
  const state = reminderState(config);
  ctx.ui.notify(
    decision.detail ? buildDetailGuide(decision.detailOrdinal, state) : buildNudge(state),
    "info",
  );
}

/** Subscribe to turn_end and notify on the configured cadence. */
export function registerReminder(pi: ExtensionAPI): void {
  pi.on("turn_end", (event, ctx) => handleRemindTurnEnd(event, ctx));
}

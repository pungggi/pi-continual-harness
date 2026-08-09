// pi-continual-harness — online self-improvement layer for pi.
//
// Owns ONLY the online optimizer layer over a unified harness-state store.
// Composes with pi-reflect (offline refinement) and pi-mem (storage); does not
// reinvent either. Manual /refine only — no autonomous mutation.
//
// See README for design rationale and the research it is grounded in.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHarness } from "./harness.js";
import { registerInjection } from "./inject.js";
import { registerRefine } from "./refine.js";
import { registerTools } from "./tools.js";
import { registerReminder, resetReminder } from "./remind.js";
import { registerAutoRefine, resetAutoRefine } from "./auto-refine.js";
import { registerOutcome, resetOutcome } from "./outcome.js";
import { getState, reconstruct, setActiveModelKey, STATE_ENTRY } from "./store.js";

export default function continualHarness(pi: ExtensionAPI): void {
  // Rebuild in-memory state from the current branch on every session start /
  // reload / resume / fork. This is what makes refinements branch-local and
  // rollback-able via /tree.
  pi.on("session_start", async (_event, ctx) => {
    // A new/resumed/forked session starts from a fresh cadence baseline: reset
    // the turn_end counters so a fork does not inherit the parent's window.
    resetAutoRefine();
    resetReminder();
    resetOutcome();
    // Drop any stale active-model key from the previous session: the next
    // before_agent_start re-caches it before any tool can run.
    setActiveModelKey(undefined);
    reconstruct(ctx.sessionManager.getBranch() as Iterable<unknown>);
    const n = getState().items.length;
    if (n > 0) {
      ctx.ui.notify(`Continual Harness: ${n} item(s) restored`, "info");
    }
  });

  registerInjection(pi);
  registerTools(pi);
  registerRefine(pi);
  registerHarness(pi);
  registerReminder(pi);
  // Register outcome BEFORE auto-refine: the test fake overwrites turn_end on
  // each registration (Map.set), and the auto-refine integration tests assume
  // auto-refine is the surviving handler. In production pi, all three run.
  registerOutcome(pi);
  registerAutoRefine(pi);
}

export { STATE_ENTRY };

// Core domain types (re-exported so companion packages — e.g. a dedicated-model
// proposer — can build and validate deltas without reaching into internal paths).
export {
  type AppliedDelta,
  type ComponentKind,
  type Delta,
  type HarnessItem,
  type HarnessState,
} from "./types.js";

// Public extension API: other extensions can register their own delta proposer
// (see src/proposer.ts) and it becomes selectable via /refine --proposer <name>
// or the `proposer` config key.
export {
  listProposers,
  registerProposer,
  type CompleteOptions,
  type CompleteResult,
  type DeltaProposer,
  type ModelCallTelemetry,
  type ProposeInput,
  type ProposedDelta,
  type ProposeResult,
} from "./proposer.js";

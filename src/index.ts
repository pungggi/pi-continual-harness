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
import { registerAutoExport, resetDurableSync, syncDurableOnStart } from "./durable.js";
import { getState, reconstruct, setActiveModelKey, setSessionProject, STATE_ENTRY } from "./store.js";
import { projectSlug } from "./config.js";

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
    resetDurableSync();
    // Drop any stale active-model key from the previous session: the next
    // before_agent_start re-caches it before any tool can run.
    setActiveModelKey(undefined);
    // Cache the session's project slug BEFORE any tool delta can arrive: it is
    // the server-side stamp for scope:"project" (harness_mutate has no ctx).
    setSessionProject(projectSlug(ctx.cwd));
    reconstruct(ctx.sessionManager.getBranch() as Iterable<unknown>);
    const n = getState().items.length;
    if (n > 0) {
      ctx.ui.notify(`Continual Harness: ${n} item(s) restored`, "info");
    }
    // Opt-in durable sync (issue #7): layered auto-import on top of the
    // branch-restored state, so refinements made in OTHER sessions reach this
    // one. No-op (and quiet) when autoImport is off or nothing changed.
    await syncDurableOnStart(pi, ctx);
  });

  registerInjection(pi);
  registerTools(pi);
  registerRefine(pi);
  registerHarness(pi);
  registerReminder(pi);
  // Durable sync's turn_end export (opt-in via autoImport) registers before
  // outcome/auto-refine; in production pi every turn_end handler runs.
  registerAutoExport(pi);
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
  DEFAULT_DEDUPE,
  DEDUPE_THRESHOLD,
  EVIDENCE_MERGE_CAP,
  listProposers,
  planDedupe,
  registerProposer,
  unionEvidence,
  type CompleteOptions,
  type CompleteResult,
  type DedupeOptions,
  type DeltaProposer,
  type ModelCallTelemetry,
  type ProposeInput,
  type ProposedDelta,
  type ProposeResult,
  type SimilarityResult,
} from "./proposer.js";

// Calibration corpus exporter (pi-reflex contract §4, formerly pi-jev). Re-exported so companion
// packages can build corpora from exported session branches without reaching
// into internal paths.
export {
  buildCorpus,
  NOT_DUP_FLOOR,
  parseDedupeDelete,
  type CorpusResult,
  type DedupePairRecord,
  type LifecycleEvent,
  type LifecycleRecord,
} from "./corpus.js";

// Injection selection policy (on by default). Re-exported so companion packages
// and tests can reuse the pure selection/normalization without reaching into
// internal paths.
export {
  DEFAULT_INJECTION,
  estimateTokens,
  normalizeInjection,
  selectForInjection,
  type InjectionConfig,
  type NormalizedInjection,
  type SelectionResult,
} from "./select.js";

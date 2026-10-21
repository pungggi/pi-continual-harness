// pi-continual-harness — online self-improvement layer for pi.
//
// Owns ONLY the online optimizer layer over a unified harness-state store.
// Composes with pi-reflect (offline refinement) and pi-mem (storage); does not
// reinvent either. Manual /refine only — no autonomous mutation.
//
// See README for design rationale and the research it is grounded in.
//
// LAYOUT NOTE (issue #36): this module is the PACKAGE API (main), NOT the pi
// extension entry. pi loads ./entry.js (see package.json pi.extensions), a
// thin factory that registers hooks/commands/tools and dynamic-imports every
// feature implementation — so importing THIS file (companion packages, tests)
// still pulls the full graph, but pi startup does not.

// The extension factory (thin entry; see entry.ts).
export { default } from "./entry.js";

export { STATE_ENTRY } from "./store.js";

// Core domain types (re-exported so companion packages — e.g. a dedicated-model
// proposer — can build and validate deltas without reaching into internal paths).
export {
  type AppliedDelta,
  type ComponentKind,
  type Delta,
  type HarnessItem,
  type HarnessState,
  type SupportInfo,
} from "./types.js";

// Public extension API: other extensions can register their own delta proposer
// (see src/proposer.ts) and it becomes selectable via /refine --proposer <name>
// or the `proposer` config key.
export { DEFAULT_DEDUPE, DEDUPE_THRESHOLD, EVIDENCE_MERGE_CAP, buildSteeringPrompt, listProposers, planDedupe, registerProposer, unionEvidence,
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

// Harnessing-level recursion (Harness², arXiv 2610.14224): evidence-gated
// lessons from past refines + the auto-refine history gate. Re-exported for
// tests and companion packages.
export {
  buildLessonsDigest,
  classifyRuns,
  isEffectiveRun,
  recentIneffectiveRuns,
  type DigestOptions,
  type RefineRun,
} from "./lessons.js";
export { mergeSupport, renderSupport, parseSupport } from "./store.js";
export { DEFAULT_REFINE_NOOP_SKIP } from "./config.js";

// Calibration corpus exporter (pi-reflex contract §4, formerly pi-jev). Re-exported so companion
// packages can build corpora from exported session branches without reaching
// into internal paths.
export {
  buildCorpus,
  classifyTransition,
  NOT_DUP_FLOOR,
  parseDedupeDelete,
  type CorpusResult,
  type DedupePairRecord,
  type LifecycleEvent,
  type LifecycleRecord,
  type LifecycleTransition,
} from "./corpus.js";

// Status report (issue #20): the pure /harness status builder + the rotating
// one-line hint library (shared copy source with #19's content library), plus
// the session injection telemetry. Re-exported for tests and companions.
export {
  buildStatusReport,
  renderStatusReport,
  type ImpactCounts,
  type StatusOptions,
  type StatusReport,
} from "./status.js";
export {
  nextHint,
  pickHint,
  resetHints,
  type StatusHint,
} from "./hints.js";
export { getInjectionStats, resetInjectionStats, type InjectionStats } from "./inject.js";

// /harness list (issue #31): pure selection + rendering for the read view of
// the store (compact rows / full text + evidence). Re-exported for tests and
// companions without reaching into internal paths.
export {
  preview,
  renderListReport,
  selectListItems,
  type ListOptions,
  type ListScope,
} from "./list.js";

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

// Virtual-model binding policy (pi ≥ 0.99, 0.12.0): strict per-model isolation
// across router selections. Re-exported so companion packages and tests reuse
// the pure resolution without reaching into internal paths.
export {
  branchEntries,
  isVirtualModel,
  physicalKeyFromBranch,
  resolveBindingKey,
  VIRTUAL_MODEL_API,
} from "./vmodel.js";

// /refine reminder copy (issue #19): pure nudge/guide builders + the
// state snapshot they render from, exported so tests and companions (e.g. a
// richer /harness status) share the same copy source.
export {
  buildDetailGuide,
  buildNudge,
  reminderState,
  type ReminderState,
} from "./remind.js";

// Classifier seam (pi ≥ 0.99, 0.12.0): the minimal structural ClassifyFn
// contract proposers see, plus the gate builders (pure, testable).
export {
  buildGateRequest,
  gateDecision,
  type ClassifyBoolAnswer,
  type ClassifyBoolQuestion,
  type ClassifyBoolResult,
  type ClassifyFn,
} from "./classify.js";

// Auto-refine boundary helpers (pi ≥ 0.87, 0.12.0–0.13.0): the steering draft,
// the stale-draft context-edit omissions, and the shared aborted/error-turn
// predicate (pi BoundaryState.outcome). Re-exported for tests and companion
// packages without reaching into internal paths.
export {
  AUTO_REFINE_ENTRY,
  buildOmissionDrafts,
  buildRefineDraft,
  turnEndedBadly,
  type OmissionDraft,
  type ProjectedLike,
} from "./auto-refine.js";

// Message-content flattening (0.15.1): pi message content is a plain string OR
// a block array; every trajectory reader must go through this instead of
// assuming blocks. Re-exported for tests and companion packages.
export { messageText } from "./refine.js";

// Setup wizard (issue #22): presets as pure data + expandPreset, and the one
// reviewed write path for harness.json (backup + atomic write + reload).
// Re-exported so tests and companion packages never reach into internal
// paths.
export {
  deepMergeConfig,
  readConfigRaw,
  saveConfig,
  type SaveConfigResult,
} from "./config.js";
export {
  expandPreset,
  getPath,
  planWrite,
  PRESETS,
  setPath,
  type Preset,
  type PresetDelta,
  type PresetName,
} from "./setup.js";

// Cross-model adoption (issue #21, /harness adopt --from <provider/id>): the
// pure steering-prompt builder and the importance-ordered, batch-capped
// source selection. Re-exported for tests and companion packages without
// reaching into internal paths.
export { ADOPT_BATCH_CAP, buildAdoptPrompt, selectAdoptSource } from "./harness.js";

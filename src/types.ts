// Continual Harness — core types.
//
// Design notes (see README for the full rationale):
//  - Four components per Continual Harness (arXiv 2605.09998): prompt, memory,
//    skill, sub-agent spec. Each item carries `evidence` grounding it in the
//    trajectory and an `importance` fitness signal (ACE-style).
//  - Mutations are expressed as structured CRUD deltas, never as prose prompt
//    rewrites. This follows ACE (arXiv 2510.04618): itemized, deterministic
//    merges prevent context collapse and brevity bias.
//  - The store is session-scoped (reset-free, online). A durable markdown
//    export is the composition seam with pi-reflect / pi-mem (see store.ts).

/** The four Continual Harness components, as the schema enum order. The one
 *  list every module derives from (schemas.ts's enum, select.ts's KIND_ORDER,
 *  the durable renderer's section order) — import, never re-enumerate. */
export const KIND_VALUES = ["prompt", "memory", "skill", "subagent"] as const;

/** The four Continual Harness components. */
export type ComponentKind = (typeof KIND_VALUES)[number];

/** Canonical kind iteration order (durable sections, injection sections,
 *  per-kind tallies). Same members as KIND_VALUES; named separately because
 *  it is an ORDER, not an enum. */
export const KIND_ORDER: ComponentKind[] = [...KIND_VALUES];

/** `/harness keep|drop` importance nudge magnitude. The lifecycle classifier
 *  (corpus.ts) reads ±this value from snapshot diffs, so the bump and the
 *  classification must come from the same constant (review of the former
 *  harness.ts/corpus.ts hand-synced pair). */
export const KEEP_DROP_BUMP = 0.1;

/** Minimal loose shape of a pi session entry, shared by every branch walker
 *  (refine evidence, outcome scanning, status/corpus audit walks). Kept
 *  structural on purpose: pi's real entry types are richer and versioned;
 *  walkers only read these fields. Message content is a plain string OR a
 *  block array depending on the message source — never assume either. */
export type AnyEntry = {
  type?: string;
  customType?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
  data?: {
    state?: HarnessState;
    source?: string;
    proposer?: string;
    applied?: unknown;
    appliedDeltas?: unknown[];
    startedAt?: number;
  };
};

/**
 * Post-adoption support signals (Harness², arXiv 2610.14224: a lesson should
 * be retained when supported by execution evidence, not by the mere fact of
 * creation). Counters accumulate over the item's life and feed the refine
 * digest (lessons.ts) and `/harness list -f`. Optional everywhere: legacy
 * snapshots and durable files simply have no support yet.
 */
export type SupportInfo = {
  /** Completed turns in which the agent cited this item's [h_xxxx] tag. */
  citations?: number;
  /** Times a human ran `/harness keep` on the item. */
  keeps?: number;
  /** Times a human ran `/harness drop` on the item. */
  drops?: number;
  /** Last citation time (ms epoch). */
  lastCitedAt?: number;
};

/** A single item in the unified harness store. */
export interface HarnessItem {
  id: string;
  kind: ComponentKind;
  /** Payload: a prompt note, a memory fact, a skill description, or a sub-agent spec. */
  content: string;
  /** Why this item exists, grounded in trajectory evidence. Required for every create. */
  evidence: string;
  /** Fitness signal in [0,1]. Items below a threshold can be pruned/deactivated. */
  importance: number;
  /** Whether the item is injected into the system prompt each turn. */
  active: boolean;
  /**
   * The model this item is bound to, as "provider/id". Empty string = orphan
   * (not yet adopted by any model). Model binding is STRICT per-model: an item
   * is only injected for the exact model it belongs to, so a brand-new model
   * id starts from a blank harness and never inherits another model's notes.
   * Orphans are adopted by the active model on first contact (see store.ts).
   */
  ownerModel: string;
  /**
   * Durable-layer scope: "global" (default) → the shared durable file
   * (~/.pi/agent/harness-state.md); "project" → the per-project file
   * (~/.pi/agent/harness-state/<slug>.md). Scope decides WHERE an item is
   * exported / imported from — it does NOT affect per-turn injection.
   * Undefined is treated as "global" (legacy snapshots / durable files).
   */
  scope?: "global" | "project";
  /** Project slug (see projectSlug in config.ts); set iff scope === "project". */
  project?: string;
  /** Post-adoption support signals (see SupportInfo). Absent = no feedback yet. */
  support?: SupportInfo | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface HarnessState {
  items: HarnessItem[];
}

/** Structured CRUD delta. The unit of self-improvement. */
export type Delta =
  | {
      op: "create";
      kind: ComponentKind;
      content: string;
      evidence: string;
      importance?: number;
      /** Owner "provider/id". Stamped server-side from the active model when the
       *  agent omits it; set explicitly by direct-apply proposers. Absent → orphan. */
      ownerModel?: string;
      /** Durable-layer scope (default "global"). "project" requires a slug:
       *  taken from the session cwd (stamped at session_start) when omitted. */
      scope?: "global" | "project";
      /** Explicit project slug for scope:"project" (server-side use). */
      project?: string;
    }
  | {
      op: "update";
      id: string;
      content?: string;
      evidence?: string;
      importance?: number;
      active?: boolean;
      /** Reassign ownership (rare; used by migration/import). Absent → keep current. */
      ownerModel?: string;
      /** Move the item between durable layers. Absent → keep current scope.
       *  "project" requires `project` (set by /harness move) or a cached
       *  session slug; "global" clears the project binding. */
      scope?: "global" | "project";
      /** Explicit project slug for scope:"project" (server-side use). */
      project?: string;
      /** Replace the support counters (server-side use — NOT exposed on the
       *  model-facing tool). The dedupe proposer uses this to carry the
       *  absorbed duplicates' support onto the keeper (see mergeSupport). */
      support?: SupportInfo | undefined;
    }
  | { op: "delete"; id: string; reason: string };

/** Result of applying a single delta; returned to the model for confirmation. */
export type AppliedDelta =
  | { op: "create"; item: HarnessItem }
  | { op: "update"; before: HarnessItem; after: HarnessItem }
  | { op: "delete"; id: string; reason: string };

export const KIND_LABEL: Record<ComponentKind, string> = {
  prompt: "Supplemental prompt notes",
  memory: "Memory facts",
  skill: "Skill descriptions",
  subagent: "Sub-agent specs",
};

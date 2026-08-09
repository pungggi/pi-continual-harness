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

/** The four Continual Harness components. */
export type ComponentKind = "prompt" | "memory" | "skill" | "subagent";

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

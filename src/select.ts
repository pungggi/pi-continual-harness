// Injection selection policy: WHICH active items for the active model get
// surfaced in the system-prompt block, and in what order.
//
// The harness ACCUMULATES notes (create / refine / auto-refine /
// outcome-promotion), but the system prompt is a finite resource. Without
// selection, every active item for the model is injected every turn, unbounded —
// so a long-running session's prompt grows without limit and the most valuable
// notes compete with the least for attention. Selection is ON BY DEFAULT with
// conservative knobs that are a NO-OP for small stores (nothing trimmed) and
// protective for large ones. Opt out entirely with `injection.enabled = false`
// → legacy "all items, in store order".
//
// Policy (pure, deterministic, unit-tested in test/select.test.ts):
//   1. FILTER — active items bound to the active model (strict per-model
//      isolation, same rule inject.ts always enforced).
//   2. ORDER  — importance desc; ties keep store/insertion order (stable), so
//      the highest-fitness notes lead each section.
//   3. CAP    — `maxPerKind` (balanced sections: no single kind drowns the
//      block), then `maxTokens` (total budget). The budget is filled
//      round-robin across kinds by importance rank, so one kind cannot starve
//      the others; within that order an item that does not fit is *skipped*
//      (not a hard stop), so a single large item never blocks smaller
//      higher-priority ones after it.
//
// Kept pure + side-effect-free on purpose: inject.ts is thin glue over this, and
// the decision is fully unit-testable without a live pi runtime (the same
// factoring pattern remind.ts / auto-refine.ts / outcome.ts use).

import type { ComponentKind, HarnessItem } from "./types.js";

/** Canonical kind order (shared with inject.ts so there is one source of truth). */
export const KIND_ORDER: ComponentKind[] = ["prompt", "memory", "skill", "subagent"];

/** User-facing injection config (all optional; defaults applied on read). */
export interface InjectionConfig {
  /** Master switch. `false` → selection disabled (legacy: inject all, in store
   *  order). Default `true`. */
  enabled?: boolean;
  /** Max total tokens (≈ chars / charsPerToken) for the rendered block,
   *  including the intro + section headers + items. Default 1500. */
  maxTokens?: number;
  /** Max items surfaced per kind. Default 10. */
  maxPerKind?: number;
  /** Token estimate: characters per token. Default 4. */
  charsPerToken?: number;
}

/** Fully-resolved injection config (post-defaults; what loadConfig returns). */
export interface NormalizedInjection {
  enabled: boolean;
  maxTokens: number;
  maxPerKind: number;
  charsPerToken: number;
}

/** The shipped defaults — ON, but generous enough to never trim a small store. */
export const DEFAULT_INJECTION: NormalizedInjection = {
  enabled: true,
  maxTokens: 1500,
  maxPerKind: 10,
  charsPerToken: 4,
};

// Token-overhead estimates for the parts of the rendered block that are not item
// text, so the budget reflects the real appended size (see inject.ts). These are
// deliberately rough heuristics; the goal is a meaningful ceiling, not exactness.
const INTRO_TOKENS = 55; // "## Continual Harness state" + the two description lines
const SECTION_HEADER_TOKENS = 8; // "### <title>" per present section
const FOOTER_TOKENS = 18; // the omitted-count footer, when it renders

/** Resolve a (possibly partial / absent / malformed) config against the defaults.
 *  Defensive: bad types fall back to defaults, never throws. */
export function normalizeInjection(cfg?: Partial<InjectionConfig>): NormalizedInjection {
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  return {
    enabled: typeof cfg?.enabled === "boolean" ? cfg.enabled : DEFAULT_INJECTION.enabled,
    maxTokens: num(cfg?.maxTokens) ? cfg.maxTokens : DEFAULT_INJECTION.maxTokens,
    maxPerKind: num(cfg?.maxPerKind) ? cfg.maxPerKind : DEFAULT_INJECTION.maxPerKind,
    charsPerToken: num(cfg?.charsPerToken) ? cfg.charsPerToken : DEFAULT_INJECTION.charsPerToken,
  };
}

/** Rough token estimate for a string. Exported for tests/companions. */
export function estimateTokens(text: string, charsPerToken = DEFAULT_INJECTION.charsPerToken): number {
  return Math.ceil(text.length / charsPerToken);
}

export interface SelectionResult {
  /** Chosen items, grouped by KIND_ORDER, importance-desc within each group. */
  selected: HarnessItem[];
  /** Active items for the model that did NOT make the cut (per-kind + budget). */
  omitted: number;
  /** True when any item was dropped (drives the transparency footer). */
  truncated: boolean;
}

interface Ranked {
  item: HarnessItem;
  index: number; // store position, for a stable tie-break on equal importance
}

/** importance desc, then store index asc (stable). */
function byImportance(a: Ranked, b: Ranked): number {
  if (b.item.importance !== a.item.importance) return b.item.importance - a.item.importance;
  return a.index - b.index;
}

/**
 * Select the items to inject for `ownerKey`. Pure: takes a snapshot, returns a
 * decision. See the module doc for the policy.
 *
 * `items` is read-only here — callers (inject.ts) pass `getState().items` plus
 * the active model key; nothing is mutated.
 */
export function selectForInjection(
  items: HarnessItem[],
  ownerKey: string,
  cfg?: Partial<InjectionConfig>,
): SelectionResult {
  const n = normalizeInjection(cfg);

  // 1. FILTER: group active items bound to the active model, per kind, in
  //    store order. (Importance ranking happens below, only when enabled.)
  const groups = new Map<ComponentKind, Ranked[]>();
  for (const kind of KIND_ORDER) groups.set(kind, []);
  items.forEach((item, index) => {
    if (item.active && item.ownerModel === ownerKey) {
      groups.get(item.kind)!.push({ item, index });
    }
  });
  if (!n.enabled) {
    // Legacy opt-out: every active item for the model, grouped by kind, in
    // STORE (insertion) order — deliberately NOT importance-sorted. Returning to
    // the pre-selection behaviour is the whole point of `enabled: false`.
    const selected = KIND_ORDER.flatMap((kind) => groups.get(kind)!.map((r) => r.item));
    return { selected, omitted: 0, truncated: false };
  }

  // Importance desc, stable on store index (ties keep insertion order).
  for (const arr of groups.values()) arr.sort(byImportance);

  // 2a. CAP per kind (maxPerKind): drop the lowest-importance tail of each kind.
  let omitted = 0;
  const capped = new Map<ComponentKind, Ranked[]>();
  for (const kind of KIND_ORDER) {
    const arr = groups.get(kind)!;
    const kept = arr.slice(0, n.maxPerKind);
    omitted += arr.length - kept.length;
    capped.set(kind, kept);
  }

  // 2b. CAP total (maxTokens): flatten round-robin (rank-major, kind order
  // within a rank) so importance is prioritized across kinds fairly, then take
  // greedily while the budget allows — skipping (not stopping on) an item that
  // does not fit, so a large item never blocks smaller higher-priority ones.
  const presentKinds = KIND_ORDER.filter((k) => capped.get(k)!.length > 0);
  const maxRank = presentKinds.reduce((m, k) => Math.max(m, capped.get(k)!.length), 0);
  const queue: Ranked[] = [];
  for (let rank = 0; rank < maxRank; rank++) {
    for (const kind of presentKinds) {
      const r = capped.get(kind)![rank];
      if (r) queue.push(r);
    }
  }

  const overhead = INTRO_TOKENS + presentKinds.length * SECTION_HEADER_TOKENS + FOOTER_TOKENS;
  let remaining = Math.max(0, n.maxTokens - overhead);
  const taken: Ranked[] = [];
  for (const r of queue) {
    const cost = estimateTokens(`- [${r.item.id}] ${r.item.content}`, n.charsPerToken);
    if (cost <= remaining) {
      remaining -= cost;
      taken.push(r);
    }
  }
  omitted += queue.length - taken.length;

  // Re-group the survivors into KIND_ORDER sections (importance-desc within each).
  const selected = KIND_ORDER.flatMap((kind) =>
    taken.filter((r) => r.item.kind === kind).map((r) => r.item),
  );

  return { selected, omitted, truncated: omitted > 0 };
}

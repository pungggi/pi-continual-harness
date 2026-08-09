// The unified harness-state store.
//
// Two persistence layers:
//  1. Session-scoped (the core): the full state is snapshotted via
//     pi.appendEntry("harness-state", ...) after every mutation and
//     reconstructed on session_start from the current branch. Because pi's
//     session tree branches at any entry, navigating /tree to before a
//     refinement and resuming gives rollback for free.
//  2. Durable (the composition seam): exportDurable() writes the active items
//     to a markdown file pi-reflect can read and refine offline, and pi-mem can
//     ingest. Best-effort; the package works without it.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AppliedDelta, ComponentKind, Delta, HarnessItem, HarnessState } from "./types.js";

const STATE_ENTRY = "harness-state";
const REFINE_ENTRY = "harness-refinement";

export const DEFAULT_DURABLE_PATH = join(homedir(), ".pi", "agent", "harness-state.md");

const IMPORTANCE_FLOOR = 0.3;

// Module-scoped state. Rebuilt on every session_start, so it tracks the active
// branch. Mutations are synchronous, so concurrent tool calls cannot interleave
// inside a single mutation.
let state: HarnessState = { items: [] };
let version = 0;

// ---- model binding -------------------------------------------------------
//
// Items are strictly per-model (ownerModel = "provider/id"). The model-facing
// tools (harness_list / harness_mutate) receive NO ctx, so they cannot read
// the active model at execute time. before_agent_start always fires first in a
// turn WITH ctx.model, so it caches the active key here; the tools then read
// the cache to stamp/filter. Undefined cache (no turn started) is treated as
// "model unknown" — tools fall back gracefully (create orphans, list all).
let activeModelKey: string | undefined;

/** Canonical owner key for a model: "provider/id". Accepts the structural
 *  shape of pi-ai's Model (provider + id) without importing the type. */
export function modelKey(m?: { provider: string; id: string }): string | undefined {
  return m ? `${m.provider}/${m.id}` : undefined;
}

/** Cache the active model key (called from before_agent_start). */
export function setActiveModelKey(key: string | undefined): void {
  activeModelKey = key;
}

/** Read the cached active model key (called from the model-facing tools). */
export function getActiveModelKey(): string | undefined {
  return activeModelKey;
}

export function getState(): HarnessState {
  return state;
}

/** A defensive deep-enough copy of current state (items are flat). Use when
 *  handing state to untrusted/external code (e.g. a DeltaProposer) so it cannot
 *  mutate the live store outside applyDeltas. */
export function snapshotState(): HarnessState {
  return { items: state.items.map((i) => ({ ...i })) };
}

export function listItems(kind?: ComponentKind): HarnessItem[] {
  return kind ? state.items.filter((i) => i.kind === kind) : state.items;
}

function genId(): string {
  return `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Apply a single delta against the in-memory state. Does not persist.
 *  `actorModel`, when set, stamps creates and restricts update/delete to that
 *  model's items (per-model isolation at the model-facing tool boundary). */
function applyOne(delta: Delta, actorModel?: string): AppliedDelta {
  if (delta.op === "create") {
    const now = Date.now();
    const item: HarnessItem = {
      id: genId(),
      kind: delta.kind,
      content: delta.content,
      evidence: delta.evidence,
      importance: clamp(delta.importance ?? 0.5),
      active: true,
      // Owner: explicit delta wins; else the actor model; else orphan (""),
      // adopted by the active model on first contact.
      ownerModel: delta.ownerModel ?? actorModel ?? "",
      createdAt: now,
      updatedAt: now,
    };
    state.items.push(item);
    return { op: "create", item };
  }

  if (delta.op === "update") {
    const idx = state.items.findIndex((i) => i.id === delta.id);
    if (idx < 0) throw new Error(`update: no item with id ${delta.id}`);
    const before = state.items[idx]!;
    // Per-model isolation: when an actor model is known, a mutation may only
    // touch that model's items. Cross-model maintenance paths (the dedupe
    // proposer, /harness keep|drop|prune) call applyDeltas with no actor.
    assertOwnsItem("update", delta.id, before, actorModel);
    const after: HarnessItem = {
      ...before,
      content: delta.content ?? before.content,
      evidence: delta.evidence ?? before.evidence,
      importance: clamp(delta.importance ?? before.importance),
      active: delta.active ?? before.active,
      ownerModel: delta.ownerModel ?? before.ownerModel,
      updatedAt: Date.now(),
    };
    state.items[idx] = after;
    return { op: "update", before, after };
  }

  // delete
  const idx = state.items.findIndex((i) => i.id === delta.id);
  if (idx < 0) throw new Error(`delete: no item with id ${delta.id}`);
  assertOwnsItem("delete", delta.id, state.items[idx]!, actorModel);
  state.items.splice(idx, 1);
  return { op: "delete", id: delta.id, reason: delta.reason };
}

/** Enforce that `actorModel` owns `item`; no-op when the actor is unknown
 *  (manual / cross-model paths). Throws an audited, rollback-triggering error
 *  otherwise. */
function assertOwnsItem(
  op: "update" | "delete",
  id: string,
  item: HarnessItem,
  actorModel?: string,
): void {
  if (actorModel === undefined) return;
  if (item.ownerModel !== actorModel) {
    throw new Error(
      `${op}: item ${id} is owned by ${item.ownerModel || "(orphan)"}, not the active model ${actorModel}`,
    );
  }
}

/**
 * Apply a batch of deltas. All-or-nothing: if any delta throws, nothing is
 * applied. Returns the applied deltas and the new version.
 */
export function applyDeltas(
  deltas: Delta[],
  persist: (snapshot: HarnessState, version: number) => void,
  actorModel?: string,
): AppliedDelta[] {
  const snapshotBefore = { items: state.items.map((i) => ({ ...i })) };
  const applied: AppliedDelta[] = [];
  try {
    for (const d of deltas) applied.push(applyOne(d, actorModel));
  } catch (err) {
    // Roll back in-memory state on failure.
    state = snapshotBefore;
    throw err;
  }
  version += 1;
  persist(state, version);
  return applied;
}

/** Reconstruct state from the current branch's last harness-state snapshot. */
export function reconstruct(entries: Iterable<unknown>): void {
  let last: HarnessState | undefined;
  for (const raw of entries) {
    const entry = raw as { type?: string; customType?: string; data?: { state?: HarnessState } };
    if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data?.state) {
      last = entry.data.state;
    }
  }
  // Normalize legacy snapshots that predate ownerModel: missing → orphan (""),
  // adopted by the active model on first contact (see adoptOrphans).
  state = last
    ? { items: last.items.map((i) => ({ ...i, ownerModel: i.ownerModel ?? "" })) }
    : { items: [] };
  version = 0;
}

/**
 * Age importance of stale items, then prune below the floor.
 *  - decayAfterDays: if set, items whose updatedAt is older than this get
 *    importance -= decayStep (default 0.1) before pruning. Time-since-update
 *    is a weak proxy for staleness; pair with /harness keep|drop for signal.
 *  - Items below IMPORTANCE_FLOOR after decay are removed.
 */
export function decayAndPrune(
  options: { decayAfterDays?: number; decayStep?: number } = {},
  persist: (snapshot: HarnessState, version: number) => void,
): { pruned: number; decayed: number } {
  let decayed = 0;
  const step = options.decayStep ?? 0.1;
  const ms = options.decayAfterDays !== undefined ? options.decayAfterDays * 86_400_000 : undefined;
  const now = Date.now();
  if (ms !== undefined) {
    for (const i of state.items) {
      if (now - i.updatedAt > ms) {
        i.importance = clamp(i.importance - step);
        decayed += 1;
      }
    }
  }
  const before = state.items.length;
  state.items = state.items.filter((i) => i.importance >= IMPORTANCE_FLOOR);
  version += 1;
  persist(state, version);
  return { pruned: before - state.items.length, decayed };
}

/** Nudge an item's importance by delta (clamped to [0,1]) and touch updatedAt. */
export function bumpImportance(
  id: string,
  delta: number,
  persist: (snapshot: HarnessState, version: number) => void,
): HarnessItem | undefined {
  const item = state.items.find((i) => i.id === id);
  if (!item) return undefined;
  item.importance = clamp(item.importance + delta);
  item.updatedAt = Date.now();
  version += 1;
  persist(state, version);
  return item;
}

/** Adopt every orphan item (ownerModel === "") to the given model key. This is
 *  the migration policy for legacy snapshots / durable imports / items created
 *  while the active model was unknown: they become owned by the first model to
 *  claim them. Idempotent: a no-op (no persist) when there are no orphans. */
export function adoptOrphans(
  key: string,
  persist: (snapshot: HarnessState, version: number) => void,
): number {
  let adopted = 0;
  for (const i of state.items) {
    if (i.ownerModel === "") {
      i.ownerModel = key;
      adopted += 1;
    }
  }
  if (adopted > 0) {
    version += 1;
    persist(state, version);
  }
  return adopted;
}

export { STATE_ENTRY, REFINE_ENTRY, IMPORTANCE_FLOOR };

// ---- Durable export (composition seam with pi-reflect / pi-mem) -------------

export async function exportDurable(path = DEFAULT_DURABLE_PATH): Promise<string> {
  const lines: string[] = ["# Continual Harness State", ""];
  const kinds: ComponentKind[] = ["prompt", "memory", "skill", "subagent"];
  for (const kind of kinds) {
    const items = state.items.filter((i) => i.kind === kind && i.active);
    if (items.length === 0) continue;
    lines.push(`## ${titleFor(kind)}`, "");
    for (const i of items) {
      lines.push(`- **[${i.id}]** (importance ${i.importance.toFixed(2)}) ${i.content}`);
      lines.push(`  - evidence: ${i.evidence}`);
      if (i.ownerModel) lines.push(`  - model: ${i.ownerModel}`);
    }
    lines.push("");
  }
  if (lines.length <= 2) lines.push("_(no active items)_", "");
  const body = lines.join("\n");
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await writeFile(path, body, "utf8");
  return path;
}

function titleFor(kind: ComponentKind): string {
  switch (kind) {
    case "prompt":
      return "Supplemental prompt notes";
    case "memory":
      return "Memory facts";
    case "skill":
      return "Skill descriptions";
    case "subagent":
      return "Sub-agent specs";
  }
}

// ---- Durable import (round-trip seam with pi-reflect) ---------------------
//
// exportDurable() is write-only by design. reconstructFromDurable() closes the
// loop: it parses the markdown back into items and merges them into the live
// store, so offline edits pi-reflect makes to harness-state.md flow back in.
//
// Merge semantics (predictable, loss-free by default):
//   - parsed item whose id matches an existing item → UPDATE in place
//     (durable wins on content/evidence/importance; reactivated; createdAt kept).
//   - parsed item with a new/foreign id → CREATE.
//   - items in the store but absent from the file → KEPT by default.
//     Pass { prune: true } to also drop active items whose id is not in the
//     file (inactive items are always preserved — the durable export never
//     contains them, so they cannot have been "deleted" by pi-reflect).

export interface DurableImportResult {
  /** Items successfully parsed from the file. */
  imported: number;
  created: number;
  updated: number;
  /** Only non-zero when { prune: true }. */
  pruned: number;
  /** True if the file did not exist (no-op). */
  missingFile: boolean;
}

interface ParsedItem {
  id?: string;
  kind: ComponentKind;
  importance: number;
  content: string;
  evidence: string;
  ownerModel?: string;
}

// Section title → kind. Exact export titles first, then tolerant keyword
// fallbacks so pi-reflect's edits to headings still parse.
const TITLE_TO_KIND: Array<[RegExp, ComponentKind]> = [
  [/supplemental prompt notes/i, "prompt"],
  [/memory facts/i, "memory"],
  [/skill descriptions/i, "skill"],
  [/sub-?agent specs/i, "subagent"],
  [/\bprompt\b/i, "prompt"],
  [/\bmemory\b/i, "memory"],
  [/\bskills?\b/i, "skill"],
  [/\bsub-?agents?\b/i, "subagent"],
];

function titleToKind(title: string): ComponentKind | undefined {
  for (const [re, kind] of TITLE_TO_KIND) if (re.test(title)) return kind;
  return undefined;
}

const RE_H2 = /^##\s+(.*)$/;
const RE_ID_BULLET = /^-\s+\*\*\[([^\]]+)\]\*\*\s*\(importance\s+([\d.]+)\)\s*(.*)$/;
const RE_PLAIN_BULLET = /^-\s+(.+)$/;
const RE_EVIDENCE = /^\s+-\s+evidence:\s*(.*)$/i;
const RE_MODEL = /^\s+-\s+model:\s*(.*)$/i;

/** Parse a durable markdown export into items. Tolerant of pi-reflect's edits. */
export function parseDurable(text: string): ParsedItem[] {
  const out: ParsedItem[] = [];
  let kind: ComponentKind | undefined;
  let pending: ParsedItem | null = null;
  const flush = (): void => {
    if (pending && pending.content) out.push(pending);
    pending = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const h2 = line.match(RE_H2);
    if (h2) {
      flush();
      kind = titleToKind(h2[1]!.trim());
      continue;
    }
    if (/^#/.test(line)) {
      flush(); // any other header (h1, h3, …)
      continue;
    }
    if (!kind) continue; // ignore bullets outside a known section

    const ev = line.match(RE_EVIDENCE);
    if (ev) {
      if (pending) pending.evidence = ev[1]!.trim();
      continue;
    }

    const mdl = line.match(RE_MODEL);
    if (mdl) {
      if (pending) pending.ownerModel = mdl[1]!.trim();
      continue;
    }

    const idm = line.match(RE_ID_BULLET);
    if (idm) {
      flush();
      const imp = Number(idm[2]!);
      pending = {
        id: idm[1]!.trim(),
        kind,
        importance: Number.isNaN(imp) ? 0.5 : imp,
        content: idm[3]!.trim(),
        evidence: "",
      };
      continue;
    }

    const pm = line.match(RE_PLAIN_BULLET);
    if (pm) {
      flush();
      const body = pm[1]!.trim();
      const idInBody = body.match(/^\*\*\[([^\]]+)\]\*\*/);
      pending = {
        kind,
        importance: 0.5,
        content: body.replace(/^\*\*\[([^\]]+)\]\*\*\s*/, "").trim(),
        evidence: "",
      };
      if (idInBody) pending.id = idInBody[1]!.trim();
      continue;
    }
  }
  flush();
  return out.filter((p) => p.content && !/^\(?no active items\)?$/i.test(p.content));
}

/**
 * Parse the durable file and merge it into the live store, then persist a
 * snapshot. See the file-level comment above for merge semantics.
 */
export async function reconstructFromDurable(
  path: string,
  options: { prune?: boolean },
  persist: (snapshot: HarnessState, version: number) => void,
): Promise<DurableImportResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { imported: 0, created: 0, updated: 0, pruned: 0, missingFile: true };
  }

  const parsed = parseDurable(text);
  const fileIds = new Set(parsed.map((p) => p.id).filter((id): id is string => Boolean(id)));
  const existingById = new Map(state.items.map((i) => [i.id, i] as const));
  const preActiveIds = new Set(state.items.filter((i) => i.active).map((i) => i.id));

  let created = 0;
  let updated = 0;
  const now = Date.now();
  for (const p of parsed) {
    const existing = p.id ? existingById.get(p.id) : undefined;
    if (existing) {
      // Durable wins; reactivate; keep createdAt.
      existing.content = p.content;
      existing.evidence = p.evidence;
      existing.importance = clamp(p.importance);
      existing.active = true;
      // Durable wins on owner too: a present tag sets the owner; an absent tag
      // (e.g. pi-reflect stripped it) orphans the item so it's adopted by the
      // active model on first contact — matching the documented round-trip.
      existing.ownerModel = p.ownerModel ?? "";
      existing.updatedAt = now;
      updated += 1;
    } else {
      const id = p.id && /^h_/.test(p.id) ? p.id : genId();
      state.items.push({
        id,
        kind: p.kind,
        content: p.content,
        evidence: p.evidence,
        importance: clamp(p.importance),
        active: true,
        ownerModel: p.ownerModel ?? "",
        createdAt: now,
        updatedAt: now,
      });
      created += 1;
    }
  }

  let pruned = 0;
  if (options.prune) {
    const before = state.items.length;
    state.items = state.items.filter((i) => {
      if (!i.active) return true; // inactive items are never touched by durable I/O
      if (!preActiveIds.has(i.id)) return true; // created during this import
      if (fileIds.has(i.id)) return true; // present in the file
      return false; // was active before, absent from the file → drop
    });
    pruned = before - state.items.length;
  }

  version += 1;
  persist(state, version);
  return { imported: parsed.length, created, updated, pruned, missingFile: false };
}

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

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AppliedDelta, ComponentKind, Delta, HarnessItem, HarnessState } from "./types.js";

/** Resolved durable-layer scope for a parsed item. */
export interface ScopeInfo {
  scope: "global" | "project";
  project?: string;
}

const STATE_ENTRY = "harness-state";
const REFINE_ENTRY = "harness-refinement";

export const DEFAULT_DURABLE_PATH = join(homedir(), ".pi", "agent", "harness-state.md");
/** Directory holding per-project durable files: <slug>.md (see projectSlug). */
export const PROJECT_DURABLE_DIR = join(homedir(), ".pi", "agent", "harness-state");

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

// Same pattern for the session's project slug: the durable-layer stamp for
// scope:"project" deltas that arrive without an explicit slug (the
// model-facing tools have no ctx). Cached once per session_start from ctx.cwd
// so scope stamps are stable no matter where a delta originates.
let sessionProject: string | undefined;

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

/** Cache the session's project slug (called from session_start). */
export function setSessionProject(slug: string | undefined): void {
  sessionProject = slug;
}

/** Current store version — bumped by every persisted mutation, reset by
 *  reconstruct. The auto-export loop compares it to detect "store changed
 *  since the last durable export". */
export function getVersion(): number {
  return version;
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
      // Durable-layer scope: global unless the delta says project (which
      // requires a slug — explicit or the cached session slug).
      scope: "global",
      createdAt: now,
      updatedAt: now,
    };
    applyDeltaScope(item, delta);
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
    applyDeltaScope(after, delta);
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

/** Stamp a delta's scope onto an item. No-op when the delta is silent about
 *  scope. "project" needs a slug: explicit delta.project (set by
 *  /harness move) or the cached session slug (model-driven scope updates);
 *  throws otherwise so the surrounding applyDeltas rolls the batch back. */
function applyDeltaScope(
  item: HarnessItem,
  delta: { scope?: "global" | "project"; project?: string },
): void {
  if (delta.scope === undefined) return;
  if (delta.scope === "global") {
    item.scope = "global";
    delete item.project;
    return;
  }
  const slug = delta.project ?? sessionProject;
  if (!slug) {
    throw new Error('scope: "project" requires a project slug (no session cwd cached)');
  }
  item.scope = "project";
  item.project = slug;
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
  // Normalize legacy snapshots: missing ownerModel → orphan (""), adopted by
  // the active model on first contact (see adoptOrphans); missing/corrupt
  // scope → "global" (a project item without a slug cannot be placed in a
  // layer, so it falls back to the global durable file).
  state = last
    ? {
        items: last.items.map((i): HarnessItem => {
          const item: HarnessItem = { ...i, ownerModel: i.ownerModel ?? "", scope: "global" };
          if (i.scope === "project" && i.project) {
            item.scope = "project";
            item.project = i.project;
          } else {
            delete item.project;
          }
          return item;
        }),
      }
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
//
// Two write modes:
//  - exportDurable(path): a FULL single-file snapshot (every active item,
//    both scopes, project items tagged with a `scope:` sub-line so any copy of
//    the file round-trips). Used for explicit-path /harness export and
//    /refine --commit's legacy single-file output.
//  - exportDurableLayers(paths, currentSlug): the LAYERED mode — partitions
//    active items by their own scope: global-scoped → paths.globalPath,
//    project-scoped → paths.projectDir/<slug>.md (one file per slug).

/** Render the durable markdown for a set of items (empty → placeholder). */
function renderDurable(items: HarnessItem[]): string {
  const lines: string[] = ["# Continual Harness State", ""];
  const kinds: ComponentKind[] = ["prompt", "memory", "skill", "subagent"];
  for (const kind of kinds) {
    const forKind = items.filter((i) => i.kind === kind);
    if (forKind.length === 0) continue;
    lines.push(`## ${titleFor(kind)}`, "");
    for (const i of forKind) {
      lines.push(`- **[${i.id}]** (importance ${i.importance.toFixed(2)}) ${i.content}`);
      lines.push(`  - evidence: ${i.evidence}`);
      if (i.ownerModel) lines.push(`  - model: ${i.ownerModel}`);
      if (i.scope === "project") lines.push(`  - scope: project (${i.project ?? ""})`);
    }
    lines.push("");
  }
  if (lines.length <= 2) lines.push("_(no active items)_", "");
  return lines.join("\n");
}

async function writeFileDur(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await writeFile(path, body, "utf8");
}

export async function exportDurable(path = DEFAULT_DURABLE_PATH): Promise<string> {
  await writeFileDur(path, renderDurable(state.items.filter((i) => i.active)));
  return path;
}

/** Where the layered export writes each project's items. */
export interface LayerPaths {
  globalPath: string;
  projectDir: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Layered export: global file always; one file per project slug that has
 * active items; the CURRENT session's project file is also rewritten when it
 * already exists on disk (so deleting the last project item empties that
 * layer instead of leaving a stale file that auto-import would resurrect).
 * Project files the store has no items for are never created.
 */
export async function exportDurableLayers(paths: LayerPaths, currentSlug?: string): Promise<string[]> {
  const active = state.items.filter((i) => i.active);
  const globalItems = active.filter((i) => !(i.scope === "project" && i.project));
  const bySlug = new Map<string, HarnessItem[]>();
  for (const i of active) {
    if (i.scope === "project" && i.project) {
      const arr = bySlug.get(i.project) ?? [];
      arr.push(i);
      bySlug.set(i.project, arr);
    }
  }
  const written: string[] = [];
  await writeFileDur(paths.globalPath, renderDurable(globalItems));
  written.push(paths.globalPath);
  const slugs = new Set(bySlug.keys());
  if (currentSlug) slugs.add(currentSlug);
  for (const slug of slugs) {
    const file = join(paths.projectDir, `${slug}.md`);
    const items = bySlug.get(slug) ?? [];
    // Don't create empty per-project files as a side effect of visiting.
    if (items.length === 0 && !(await fileExists(file))) continue;
    await writeFileDur(file, renderDurable(items));
    written.push(file);
  }
  return written;
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
//     (durable wins on content/evidence/importance/owner/scope; reactivated;
//     createdAt kept). When nothing actually differs the update is a NO-OP —
//     no version bump, no persist — so repeated imports (and the opt-in
//     session_start auto-import) stay idempotent and don't spam the tree.
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

export interface ParsedItem {
  id?: string;
  kind: ComponentKind;
  importance: number;
  content: string;
  evidence: string;
  ownerModel?: string;
  /** Only set when the file carries an explicit `scope:` sub-line. */
  scope?: "global" | "project";
  project?: string;
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
const RE_SCOPE = /^\s+-\s+scope:\s*(global|project)\b\s*(?:\(([^)]*)\))?/i;

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

    const scp = line.match(RE_SCOPE);
    if (scp) {
      if (pending) {
        if (scp[1]!.toLowerCase() === "project") {
          pending.scope = "project";
          const slug = (scp[2] ?? "").trim();
          if (slug) pending.project = slug;
        } else {
          pending.scope = "global";
        }
      }
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

/** Merge parsed items (with fully-resolved scope) into the live store.
 *  Shared by the single-file and layered import paths. */
function mergeParsed(
  parsed: Array<ParsedItem & ScopeInfo>,
  options: { prune?: boolean },
  persist: (snapshot: HarnessState, version: number) => void,
): DurableImportResult {
  const fileIds = new Set(parsed.map((p) => p.id).filter((id): id is string => Boolean(id)));
  const existingById = new Map(state.items.map((i) => [i.id, i] as const));
  const preActiveIds = new Set(state.items.filter((i) => i.active).map((i) => i.id));

  let created = 0;
  let updated = 0;
  let dirty = false;
  const now = Date.now();
  for (const p of parsed) {
    const existing = p.id ? existingById.get(p.id) : undefined;
    if (existing) {
      const importance = clamp(p.importance);
      const ownerModel = p.ownerModel ?? "";
      // Durable wins; reactivate; keep createdAt. Idempotent imports skip the
      // write (and the persist) when the live item already matches the file.
      const unchanged =
        existing.content === p.content &&
        existing.evidence === p.evidence &&
        existing.importance === importance &&
        existing.active &&
        existing.ownerModel === ownerModel &&
        (existing.scope ?? "global") === p.scope &&
        (existing.scope === "project" ? existing.project : undefined) === p.project;
      if (unchanged) continue;
      existing.content = p.content;
      existing.evidence = p.evidence;
      existing.importance = importance;
      existing.active = true;
      // Durable wins on owner too: a present tag sets the owner; an absent tag
      // (e.g. pi-reflect stripped it) orphans the item so it's adopted by the
      // active model on first contact — matching the documented round-trip.
      existing.ownerModel = ownerModel;
      existing.scope = p.scope;
      if (p.scope === "project" && p.project) existing.project = p.project;
      else delete existing.project;
      existing.updatedAt = now;
      updated += 1;
      dirty = true;
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
        ...(p.scope === "project" && p.project ? { scope: "project" as const, project: p.project } : { scope: "global" as const }),
        createdAt: now,
        updatedAt: now,
      });
      created += 1;
      dirty = true;
      // Keep the lookup current so a later layer's copy of the same id
      // UPDATES the item we just created instead of duplicating it (the same
      // id in both layers is the normal collision case, not an anomaly).
      if (p.id) existingById.set(p.id, state.items[state.items.length - 1]!);
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
    if (pruned > 0) dirty = true;
  }

  if (!dirty) return { imported: parsed.length, created, updated, pruned, missingFile: false };
  version += 1;
  persist(state, version);
  return { imported: parsed.length, created, updated, pruned, missingFile: false };
}

/** Resolve a parsed item's scope against the layer default (for items without
 *  an explicit `scope:` sub-line: the layer they were read from decides).
 *  A `scope: project` tag without any resolvable slug degrades to global —
 *  the invariant is scope==="project" ⟹ project (a slugless project item
 *  could not be placed in any layer file). */
function withDefaultScope(p: ParsedItem, def: ScopeInfo): ParsedItem & ScopeInfo {
  if (p.scope === "project") {
    const project = p.project ?? def.project;
    return project ? { ...p, scope: "project", project } : { ...p, scope: "global" };
  }
  if (p.scope === "global") return { ...p, scope: "global" };
  return { ...p, ...def };
}

/**
 * Parse the durable file and merge it into the live store, then persist a
 * snapshot. Untagged items default to global scope (single-file semantics).
 * See the file-level comment above for merge semantics.
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
  return mergeParsed(parseDurable(text).map((p) => withDefaultScope(p, { scope: "global" })), options, persist);
}

/** One layer of a layered import: items without an explicit `scope:` sub-line
 *  adopt this layer's scope (the global file → global; a project file → that
 *  project's slug). */
export interface LayerFile {
  path: string;
  defaultScope: ScopeInfo;
}

/**
 * Layered import (issue #7): read every layer file that exists, then merge
 * ALL of them in one pass — so { prune: true } drops only items absent from
 * EVERY layer (union semantics), not from each file in turn. Earlier layers
 * lose id collisions to later ones; callers pass the global file first so the
 * project layer wins on conflicts.
 */
export async function importDurableLayers(
  files: LayerFile[],
  options: { prune?: boolean },
  persist: (snapshot: HarnessState, version: number) => void,
): Promise<DurableImportResult> {
  const all: Array<ParsedItem & ScopeInfo> = [];
  let foundAny = false;
  for (const f of files) {
    let text: string;
    try {
      text = await readFile(f.path, "utf8");
    } catch {
      continue;
    }
    foundAny = true;
    for (const p of parseDurable(text)) all.push(withDefaultScope(p, f.defaultScope));
  }
  if (!foundAny) return { imported: 0, created: 0, updated: 0, pruned: 0, missingFile: true };
  return mergeParsed(all, options, persist);
}

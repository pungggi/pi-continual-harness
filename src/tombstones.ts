// Durable delete-tombstones — the recreate detector's memory (0.24.0).
//
// WHY THIS EXISTS: a correction that keeps being deleted and then re-learned
// with near-identical content is the strongest signal that PROSE is the wrong
// medium for it — it wants to graduate into a deterministic `check` command
// (checks.ts). Citations and keeps measure items that LIVE; only tombstones
// measure items that keep COMING BACK. The lessons digest surfaces recreates
// >= 2 as the graduation nudge.
//
// Design:
//  - Every removal path (harness_mutate delete, /harness prune, trial-decay
//    expiry, durable --prune) records a tombstone: kind + content + the
//    recreate count the removed item had already accumulated (history rides
//    along, so a lineage that dies twice counts both deaths).
//  - Every CREATE is matched against tombstones with the same token-overlap
//    seam the dedupe proposer uses (similarity.ts, threshold 0.6) — "same
//    correction" means the same thing everywhere. A match carries
//    support.recreates onto the new item (server-side, like every support
//    signal — the model never writes it).
//  - Persistence: a small sidecar JSON next to the global durable file
//    (harness-state.tombstones.json), so detection works ACROSS sessions —
//    the common case (each new session re-learns the correction) is exactly
//    the cross-session one. Age-pruned (90 days) and count-capped (200) on
//    every flush; writes are best-effort (fire-and-forget, errors swallowed)
//    like the durable export itself — losing a tombstone only ever misses a
//    recreate count, never corrupts state.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEDUPE_THRESHOLD, tokenOverlap } from "./similarity.js";
import type { ComponentKind } from "./types.js";

/** Sidecar location: <durable dir>/harness-state.tombstones.json. */
export const DEFAULT_TOMBSTONE_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "harness-state.tombstones.json",
);

/** Tombstones older than this are pruned on flush. Corrections older than a
 *  quarter are unlikely to be re-learned verbatim, and the file must not grow
 *  forever. */
export const TOMBSTONE_MAX_AGE_DAYS = 90;
/** Hard cap on stored tombstones (newest win) — bounds the sidecar even under
 *  pathological delete-heavy usage. */
export const TOMBSTONE_MAX_ENTRIES = 200;

/** Cap on the content snapshot stored per tombstone. Token overlap at the
 *  0.6 threshold needs far less than a full 8000-char item to recognize a
 *  re-learn; the cap keeps the sidecar tiny. */
const TOMBSTONE_CONTENT_CHARS = 1000;

const MS_PER_DAY = 86_400_000;

/** One recorded removal. */
export interface Tombstone {
  kind: ComponentKind;
  /** Content snapshot (capped) of the removed item. */
  content: string;
  /** Recreates the removed lineage had already accumulated. */
  recreates: number;
  /** Removal time (ms epoch). */
  deletedAt: number;
}

// Module state: the in-memory list, loaded at session_start. Record calls
// push synchronously (the create/delete paths are sync) and schedule a
// best-effort flush.
let tombstones: Tombstone[] = [];
// Where flushes land (overridable so the TEST SUITE can isolate itself from
// the real home dir — every store delete path schedules a flush).
let tombstonePath: string = DEFAULT_TOMBSTONE_PATH;
// Serialized flush chain: records during an in-flight write queue behind it.
let flushChain: Promise<void> = Promise.resolve();

/** Redirect the sidecar path (test isolation). */
export function setTombstonePath(path: string): void {
  tombstonePath = path;
}

/** Snapshot for tests/debug. */
export function listTombstones(): Tombstone[] {
  return tombstones.map((t) => ({ ...t }));
}

/** Reset module state (test hook / fresh session). Does NOT touch the file. */
export function resetTombstones(): void {
  tombstones = [];
}

/** Prune by age, then cap by count (newest win). Pure. */
export function pruneTombstones(list: Tombstone[], now = Date.now()): Tombstone[] {
  const cutoff = now - TOMBSTONE_MAX_AGE_DAYS * MS_PER_DAY;
  return list
    .filter((t) => t.deletedAt > cutoff)
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .slice(0, TOMBSTONE_MAX_ENTRIES);
}

/** Parse raw sidecar content; tolerant of anything (missing, malformed,
 *  wrong shape → empty list — a bad sidecar must never crash a session). */
export function parseTombstones(raw: string): Tombstone[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (parsed as { tombstones?: unknown }).tombstones;
  if (!Array.isArray(list)) return [];
  const KINDS: ComponentKind[] = ["prompt", "memory", "skill", "subagent"];
  const out: Tombstone[] = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const r = t as Partial<Tombstone>;
    if (typeof r.kind !== "string" || !KINDS.includes(r.kind as ComponentKind)) continue;
    if (typeof r.content !== "string" || !r.content) continue;
    if (typeof r.deletedAt !== "number" || !Number.isFinite(r.deletedAt)) continue;
    out.push({
      kind: r.kind as ComponentKind,
      content: r.content,
      recreates: typeof r.recreates === "number" && Number.isFinite(r.recreates) && r.recreates > 0 ? r.recreates : 0,
      deletedAt: r.deletedAt,
    });
  }
  return out;
}

/** Load the sidecar into memory (session_start). Tolerant: any error → keep
 *  whatever is in memory (usually nothing) and let the next flush rewrite a
 *  clean file. Sets `loaded` so refreshTombstones is a no-op until then. */
export async function loadTombstones(path: string = tombstonePath): Promise<void> {
  try {
    const raw = await readFile(path, "utf8");
    tombstones = parseTombstones(raw);
  } catch {
    // ENOENT (fresh install) or a read error: start from empty either way.
    tombstones = [];
  }
}

/** Serialize the current (pruned) list to the sidecar, atomically (same
 *  tmp+rename discipline as harness.json saves). */
export async function flushTombstones(path: string = tombstonePath): Promise<void> {
  const body = `${JSON.stringify({ version: 1, tombstones: pruneTombstones(tombstones) }, null, 2)}\n`;
  // Reflect the prune in memory too, so the next match works on what exists.
  tombstones = pruneTombstones(tombstones);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(tmp, body, { encoding: "utf8", flag: "wx" });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Record removals (every delete/prune/expire path). Synchronous: merges into
 *  the in-memory list immediately (same kind + similar content folds onto the
 *  existing tombstone with max recreates), then schedules a best-effort flush
 *  — a lost flush only ever misses a count, never corrupts anything. */
export function recordRemoval(
  items: Array<{ kind: ComponentKind; content: string; recreates?: number | undefined }>,
  now = Date.now(),
): void {
  for (const item of items) {
    if (!item.content) continue;
    const content = item.content.slice(0, TOMBSTONE_CONTENT_CHARS);
    const existing = bestMatch(tombstones, item.kind, content);
    if (existing) {
      existing.recreates = Math.max(existing.recreates, item.recreates ?? 0);
      existing.deletedAt = now;
    } else {
      tombstones.push({
        kind: item.kind,
        content,
        recreates: item.recreates ?? 0,
        deletedAt: now,
      });
    }
  }
  flushChain = flushChain
    .then(() => flushTombstones())
    .catch(() => {
      // Best-effort by design (see module header): a failed sidecar write
      // must never surface inside a turn.
    });
}

/** Best same-kind tombstone for `content` at the shared threshold. */
function bestMatch(
  list: Tombstone[],
  kind: ComponentKind,
  content: string,
): Tombstone | undefined {
  let best: Tombstone | undefined;
  let bestScore = DEDUPE_THRESHOLD;
  for (const t of list) {
    if (t.kind !== kind) continue;
    const score = tokenOverlap(content, t.content);
    if (score >= bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Match a CREATE against tombstones. When a same-kind tombstone is similar
 * enough (shared dedupe threshold), increment its counter and return the new
 * recreate count for the caller to stamp on the new item (support.recreates,
 * server-side). No match → undefined (a fresh correction, not a re-learn).
 */
export function detectRecreate(
  kind: ComponentKind,
  content: string,
): number | undefined {
  if (!content) return undefined;
  const t = bestMatch(tombstones, kind, content.slice(0, TOMBSTONE_CONTENT_CHARS));
  if (!t) return undefined;
  t.recreates += 1;
  // A matched recreate is a live signal again; persist on the next flush.
  flushChain = flushChain
    .then(() => flushTombstones())
    .catch(() => {});
  return t.recreates;
}

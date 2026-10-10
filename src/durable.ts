// Layered durable sync (issue #7), opt-in via harness.json { "autoImport": true }.
//
// One flag bundles BOTH directions so the durable seam never lags the live
// store and /refine output survives into NEW sessions without manual
// export/import ceremony:
//
//   session_start → syncDurableOnStart(): layered auto-import with the same
//     loss-free merge semantics as /harness import — global file always, the
//     current project's file when its slug matches the session cwd (global
//     first, so the project layer wins id collisions). Idempotent: an import
//     that changes nothing persists nothing and stays quiet.
//
//   turn_end → registerAutoExport(): layered export when the store version
//     changed since the last export (bounded: the layer files are small).
//     Materializes the session-restored store on the first turn of a session,
//     so a missing/stale durable file self-heals. When autoImport was enabled
//     AFTER session_start (wizard or hand-edit), the first turn_end runs the
//     layered import FIRST — a late enable can never overwrite the durable
//     layers with a never-imported store.
//
// Both paths are visible (one notify line) and use the same persisted
// harness-state entries as every other mutation (/tree rollback covers them).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { DEFAULT_DURABLE_PATH, PROJECT_DURABLE_DIR, getState } from "./store.js";
import { exportDurableLayers, getVersion, importDurableLayers } from "./store.js";
import type { LayerFile, LayerPaths } from "./store.js";
import type { HarnessItem } from "./types.js";
import { DEFAULT_IMPORT_REMIND_TURNS, layerFilesFor, loadConfig, projectSlug, type HarnessConfig } from "./config.js";
import { turnEndedBadly } from "./auto-refine.js";

/** Real (homedir-based) layer paths. Tests inject their own. */
function layerPaths(): LayerPaths {
  return { globalPath: DEFAULT_DURABLE_PATH, projectDir: PROJECT_DURABLE_DIR };
}

// Version at the last auto-export. -1 = never exported this session.
let lastExportedVersion = -1;

// True once THIS session's session_start layered import ran (with autoImport
// on). A session that starts with autoImport off leaves it false, so a later
// enable (wizard or hand-edit) can trigger the turn_end catch-up import
// BEFORE any export — never clobbering the durable layers (review #26).
let startSyncRan = false;

// Completed turns observed since the last import reminder (or the seeded
// baseline). -1 = unseen. Aborted/error turns never touch this count — the
// cadence counts completed turns of work (mirrors remind.ts / #18), never raw
// turn indices: pi's `turnIndex` resets to 0 on every agent_start (each user
// prompt), so index deltas would never accumulate across prompts (review #26).
let completedTurns = -1;

/** A durable-imported item the user should stay aware of (id + what it says). */
export interface ImportedRef {
  id: string;
  kind: string;
  content: string;
}

// Items created/updated by THIS session's start auto-import — the "new
// instructions" the awareness reminder re-surfaces. Re-seeded on every
// session_start (resetDurableSync clears, syncDurableOnStart fills).
let importedThisSession: ImportedRef[] = [];
// Reminders fired for the current import batch (bounded — see MAX_IMPORT_REMINDERS).
let remindersFired = 0;

/** A batch never nags forever: after this many reminders the items are
 *  considered acknowledged-by-repetition until the next session/import. */
export const MAX_IMPORT_REMINDERS = 3;

/** Test hook / session reset: next turn_end re-exports once (materialize) and
 *  the import-reminder state starts fresh. */
export function resetDurableSync(): void {
  lastExportedVersion = -1;
  startSyncRan = false;
  importedThisSession = [];
  completedTurns = -1;
  remindersFired = 0;
}

/** Items imported by this session's start auto-import (awareness reminders). */
export function getImportedThisSession(): ImportedRef[] {
  return importedThisSession;
}

/** One listing line per imported item, bounded: `• [id] (kind) content…`. */
export function summarizeImported(items: ImportedRef[], max = 5): string[] {
  const lines = items.slice(0, max).map((i) => {
    const c = i.content.length > 70 ? `${i.content.slice(0, 69)}…` : i.content;
    return `• [${i.id}] (${i.kind}) ${c}`;
  });
  if (items.length > max) lines.push(`(+${items.length - max} more — /harness status)`);
  return lines;
}

/**
 * session_start half of the durable sync: layered import (opt-in). `files`
 * defaults to the real layers for ctx.cwd; tests inject temp paths.
 */
export async function syncDurableOnStart(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  files?: LayerFile[],
): Promise<void> {
  const config = await loadConfig();
  if (!config.autoImport) return;
  const layers = files ?? layerFilesFor(ctx.cwd);
  const res = await importDurableLayers(layers, {}, (snapshot, ver) => {
    pi.appendEntry("harness-state", { state: snapshot, version: ver });
  });
  // The start-sync completed (a throw above leaves it false, so the turn_end
  // catch-up retries before any export; missing layers are a completed no-op).
  startSyncRan = true;
  if (res.missingFile) return; // nothing durable yet — stay quiet
  // Capture WHAT arrived (created or updated) for the awareness reminders.
  // A global/project layer collision UPDATES what the global layer just
  // created — one id, one listing line: a Set de-dupes the union so the
  // "what arrived" listing and the reminder counts stay truthful.
  // Look the ids up in the live store: content/scope there is post-merge truth.
  importedThisSession = [...new Set([...res.createdIds, ...res.updatedIds])]
    .map((id) => getState().items.find((i) => i.id === id))
    .filter((i): i is HarnessItem => Boolean(i))
    .map((i) => ({ id: i.id, kind: i.kind, content: i.content }));
  const changed = res.created + res.updated + res.pruned;
  if (changed === 0) return; // in sync — no noise
  const bits = [`${res.created} created`, `${res.updated} updated`];
  if (res.pruned > 0) bits.push(`${res.pruned} pruned`);
  // WHAT arrived, not just counts: silently-injected instructions must be
  // visible at the moment they enter the session.
  const lines = [`Continual Harness: durable sync imported ${res.imported} item(s) (${bits.join(", ")}).`];
  if (importedThisSession.length > 0) {
    lines.push("New instructions now active:", ...summarizeImported(importedThisSession));
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * Pure decision for the import-awareness reminder (mirrors evaluateReminder's
 * completed-turn counting from #18). Side-effectful: the first observed
 * COMPLETED turn seeds the baseline (the seed turn itself doesn't count);
 * every completed turn after it advances the count, and each fired reminder
 * resets it. `outcome` is pi's BoundaryState.outcome — aborted/error turns
 * are inert (they neither seed nor advance, so an aborted turn cannot
 * shorten the window). `importedCount` is the batch size to remind about.
 * Fires at most MAX_IMPORT_REMINDERS times per batch.
 */
export function evaluateImportReminder(
  config: HarnessConfig,
  outcome?: string,
  importedCount = 0,
): boolean {
  // Only meaningful with autoImport on: no silent imports → nothing to flag.
  if (!config.autoImport) return false;
  if (config.importRemind?.enabled === false) return false;
  if (importedCount <= 0) return false;
  if (turnEndedBadly(outcome)) return false;
  if (remindersFired >= MAX_IMPORT_REMINDERS) return false;
  const every = config.importRemind?.everyTurns ?? DEFAULT_IMPORT_REMIND_TURNS;
  if (completedTurns < 0) {
    completedTurns = 0; // seed: the seed turn itself doesn't count
    return false;
  }
  completedTurns += 1;
  if (completedTurns >= every) {
    completedTurns = 0;
    remindersFired += 1;
    return true;
  }
  return false;
}

/** Subscribe to turn_end and re-surface imported items on the cadence. */
export function registerImportReminder(pi: ExtensionAPI): void {
  pi.on("turn_end", async (event, ctx) => {
    const config = await loadConfig();
    // Completed-turn counting (see `completedTurns`): aborted/error outcomes
    // are inert and pi's per-agent-start turnIndex resets never matter.
    const outcome = (event as { outcome?: string }).outcome;
    if (!evaluateImportReminder(config, outcome, importedThisSession.length)) {
      return;
    }
    const examples = importedThisSession
      .slice(0, 2)
      .map((i) => `[${i.id}] ${i.kind}`)
      .join(", ");
    ctx.ui.notify(
      `Continual Harness: ${importedThisSession.length} imported item(s) are active this session (e.g. ${examples}). ` +
        `Review with /harness status; disable reminders via "importRemind": { "enabled": false } in harness.json.`,
      "info",
    );
  });
}

/** Layer files matching the (possibly injected) export paths — same shape
 *  and order as config.layerFilesFor: global first, the current project's
 *  file second (project wins id collisions). Undefined → real session paths. */
function startFilesFor(cwd: string, injected?: LayerPaths): LayerFile[] | undefined {
  if (!injected) return undefined;
  const slug = projectSlug(cwd);
  return [
    { path: injected.globalPath, defaultScope: { scope: "global" } },
    { path: join(injected.projectDir, `${slug}.md`), defaultScope: { scope: "project", project: slug } },
  ];
}

/**
 * turn_end half of the durable sync: layered export when the live store
 * changed since the last export (opt-in, bundled with autoImport). `paths`
 * defaults to the real layer dirs; tests inject temp dirs.
 */
export function registerAutoExport(pi: ExtensionAPI, paths?: LayerPaths): void {
  pi.on("turn_end", async (_event, ctx) => {
    const config = await loadConfig();
    if (!config.autoImport) return;
    if (!startSyncRan) {
      // autoImport was enabled AFTER session_start (wizard or hand-edit):
      // this session's layered import never ran. Import BEFORE any export —
      // otherwise the first auto-export would overwrite the durable layers
      // with the never-imported live store (data loss, review #26).
      try {
        await syncDurableOnStart(pi, ctx, startFilesFor(ctx.cwd, paths));
      } catch (err) {
        ctx.ui.notify(
          `Durable catch-up import failed (no export this turn; retried next turn): ${(err as Error).message}`,
          "warning",
        );
        return; // export only once the layers are safely in the store
      }
    }
    if (getVersion() === lastExportedVersion) return;
    try {
      const written = await exportDurableLayers(
        paths ?? layerPaths(),
        projectSlug(ctx.cwd),
      );
      lastExportedVersion = getVersion();
      ctx.ui.notify(
        `Continual Harness: durable state exported (${written.length} file(s)).`,
        "info",
      );
    } catch (err) {
      // Soft-fail but leave lastExportedVersion stale → retried next turn.
      ctx.ui.notify(`Durable auto-export failed: ${(err as Error).message}`, "warning");
    }
  });
}

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
//     so a missing/stale durable file self-heals.
//
// Both paths are visible (one notify line) and use the same persisted
// harness-state entries as every other mutation (/tree rollback covers them).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DURABLE_PATH, PROJECT_DURABLE_DIR } from "./store.js";
import { exportDurableLayers, getVersion, importDurableLayers } from "./store.js";
import type { LayerFile, LayerPaths } from "./store.js";
import { layerFilesFor, loadConfig, projectSlug } from "./config.js";

/** Real (homedir-based) layer paths. Tests inject their own. */
function layerPaths(): LayerPaths {
  return { globalPath: DEFAULT_DURABLE_PATH, projectDir: PROJECT_DURABLE_DIR };
}

// Version at the last auto-export. -1 = never exported this session.
let lastExportedVersion = -1;

/** Test hook / session reset: next turn_end re-exports once (materialize). */
export function resetDurableSync(): void {
  lastExportedVersion = -1;
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
  if (res.missingFile) return; // nothing durable yet — stay quiet
  const changed = res.created + res.updated + res.pruned;
  if (changed === 0) return; // in sync — no noise
  const bits = [`${res.created} created`, `${res.updated} updated`];
  if (res.pruned > 0) bits.push(`${res.pruned} pruned`);
  ctx.ui.notify(`Continual Harness: durable sync imported ${res.imported} item(s) (${bits.join(", ")}).`, "info");
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

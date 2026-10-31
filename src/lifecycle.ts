// session_start lifecycle — everything pi's startup event needs from the
// harness, in ONE dynamically-imported module (see entry.ts for why: the entry
// must stay thin because pi awaits every extension factory synchronously
// before startup continues — issue #36). This module's static graph
// (store, config, and the per-feature resets) is paid once, at session_start,
// off the startup critical path.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resetAutoRefine } from "./auto-refine.js";
import { resetReminder } from "./remind.js";
import { resetOutcome } from "./outcome.js";
import { resetDurableSync, syncDurableOnStart } from "./durable.js";
import { resetInjectionStats } from "./inject.js";
import { resetHints } from "./hints.js";
import { setActiveModelKey, setSessionProject, reconstruct, getState } from "./store.js";
import { CONFIG_PATH, configMalformed, loadConfig, projectSlug } from "./config.js";

/** The full session_start handler (rebuild state from the current branch). */
export async function onSessionStart(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  // Rebuild in-memory state from the current branch on every session start /
  // reload / resume / fork. This is what makes refinements branch-local and
  // rollback-able via /tree.
  //
  // A new/resumed/forked session starts from a fresh cadence baseline: reset
  // the turn_end counters so a fork does not inherit the parent's window.
  resetAutoRefine();
  resetReminder();
  resetOutcome();
  resetDurableSync();
  // Session-scoped telemetry for /harness status: fresh session → fresh
  // injection stats and hint rotation.
  resetInjectionStats();
  resetHints();
  // Drop any stale active-model key from the previous session: the next
  // before_agent_start re-caches it before any tool can run.
  setActiveModelKey(undefined);
  // Cache the session's project slug BEFORE any tool delta can arrive: it is
  // the server-side stamp for scope:"project" (harness_mutate has no ctx).
  setSessionProject(projectSlug(ctx.cwd));
  // Surface a malformed harness.json ONCE per session start: loadConfig
  // falls back to defaults for it, so without this warning every configured
  // setting would silently stop applying (review finding #6).
  await loadConfig();
  if (configMalformed()) {
    ctx.ui.notify(
      `Continual Harness: ${CONFIG_PATH} is not valid JSON — every setting is on its DEFAULT until the file parses.`,
      "warning",
    );
  }
  reconstruct(ctx.sessionManager.getBranch() as Iterable<unknown>);
  const n = getState().items.length;
  if (n > 0) {
    ctx.ui.notify(`Continual Harness: ${n} item(s) restored`, "info");
  }
  // Opt-in durable sync (issue #7): layered auto-import on top of the
  // branch-restored state, so refinements made in OTHER sessions reach this
  // one. No-op (and quiet) when autoImport is off or nothing changed.
  // Soft-fail like the equivalent turn_end path (durable.ts): a throw here
  // (unexpected merge error, unreadable-but-present layer file) must not
  // escape the session_start handler — the session still starts with the
  // branch-restored state.
  try {
    await syncDurableOnStart(pi, ctx);
  } catch (err) {
    ctx.ui.notify(
      `Continual Harness: durable auto-import failed: ${(err as Error).message}`,
      "warning",
    );
  }
}

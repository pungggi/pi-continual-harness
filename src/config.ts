// User configuration for continual-harness: ~/.pi/agent/harness.json
//
// This file (optional; missing → defaults) configures:
//  - autoImport: opt-in durable sync (issue #7). `true` bundles BOTH
//    directions: session_start layered auto-import (global file always + the
//    current project's file) and turn_end layered auto-export whenever the
//    live store changed since the last export. Off by default — importing is
//    normally an explicit, reviewable /harness import.
//  - durableScope: DEPRECATED (0.9.0). Items now carry their own scope
//    (`/harness move <id> global|project`); durable I/O is layered on top of
//    per-item scope and this key no longer switches anything. Still parsed so
//    existing configs keep loading; will be removed in a future release.
//  - remindRefine / autoRefine / outcomeImportance / injection / proposer:
//    unchanged (see below).
//
// Robust by design: missing or malformed file → DEFAULT_CONFIG, never throws.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DEFAULT_DURABLE_PATH, PROJECT_DURABLE_DIR, type LayerFile, type ScopeInfo } from "./store.js";
import { DEFAULT_INJECTION, normalizeInjection, type NormalizedInjection } from "./select.js";

export const DEFAULT_EVERY_TURNS = 50;
export const DEFAULT_AUTO_EVERY_TURNS = 100;
/** Default per-reference importance bump for the opt-in outcome loop. */
export const DEFAULT_REF_BUMP = 0.03;

export interface HarnessConfig {
  /** DEPRECATED (0.9.0): items carry their own scope now (see /harness move);
   *  durable I/O is always layered. Parsed for compatibility, ignored. */
  durableScope?: "global" | "project";
  /** Opt-in durable sync (issue #7): session_start layered auto-import +
   *  turn_end layered auto-export when the store changed. Default false. */
  autoImport?: boolean;
  remindRefine?: {
    enabled?: boolean;
    everyTurns?: number;
  };
  autoRefine?: {
    enabled?: boolean;
    everyTurns?: number;
    commit?: boolean;
  };
  /** Delta proposer name (see proposer.ts registry). Defaults to "steering". */
  proposer?: string;
  /** Opt-in turn_end outcome loop: promote importance of items the agent
   *  references by their [h_xxxx] tag. Off by default (autonomous mutation). */
  outcomeImportance?: {
    enabled?: boolean;
    bump?: number;
  };
  /** Injection selection policy (on by default). Resolved by loadConfig, so the
   *  value here is always fully-populated. See src/select.ts. */
  injection?: NormalizedInjection;
}

export const DEFAULT_CONFIG: HarnessConfig = {
  durableScope: "global",
  autoImport: false,
  remindRefine: { enabled: false, everyTurns: DEFAULT_EVERY_TURNS },
  autoRefine: { enabled: false, everyTurns: DEFAULT_AUTO_EVERY_TURNS, commit: false },
  proposer: "steering",
  outcomeImportance: { enabled: false, bump: DEFAULT_REF_BUMP },
  // ON by default: importance-ordered, maxPerKind 10, maxTokens 1500. A no-op
  // for small stores; protective as the harness accumulates. Opt out with
  // `injection.enabled: false`. See src/select.ts.
  injection: DEFAULT_INJECTION,
};

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "harness.json");

let cached: HarnessConfig | undefined;

/** Merge a (possibly partial) parsed file over the defaults. */
function mergeConfig(over: Partial<HarnessConfig>): HarnessConfig {
  return {
    durableScope: over.durableScope === "project" ? "project" : "global",
    autoImport: over.autoImport === true,
    remindRefine: {
      enabled: over.remindRefine?.enabled ?? false,
      everyTurns: over.remindRefine?.everyTurns ?? DEFAULT_EVERY_TURNS,
    },
    autoRefine: {
      enabled: over.autoRefine?.enabled ?? false,
      everyTurns: over.autoRefine?.everyTurns ?? DEFAULT_AUTO_EVERY_TURNS,
      commit: over.autoRefine?.commit ?? false,
    },
    proposer: over.proposer ?? "steering",
    outcomeImportance: {
      enabled: over.outcomeImportance?.enabled ?? false,
      bump: coerceBump(over.outcomeImportance?.bump),
    },
    // normalizeInjection is defensive (bad types → defaults), so a partial or
    // malformed `injection` object degrades to the shipped defaults rather than
    // corrupting the block sizing arithmetic.
    injection: normalizeInjection(over.injection as Partial<{ enabled: boolean; maxTokens: number; maxPerKind: number; charsPerToken: number }> | undefined),
  };
}

/** Coerce a user-provided bump to a finite number, else the default. The bump
 *  is an ARITHMETIC operand (importance + bump), so a non-numeric value must not
 *  leak through: importance + "0.03" === "0.50.03" → NaN, which would then be
 *  pruned as below-floor on the next decay. */
function coerceBump(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_REF_BUMP;
}

/** Load the config, merged over defaults. Tolerant: missing/malformed → defaults.
 *  Cached for the process lifetime (config is read once per session). */
export async function loadConfig(path: string = CONFIG_PATH): Promise<HarnessConfig> {
  if (cached) return cached;
  try {
    const raw = await readFile(path, "utf8");
    cached = mergeConfig(JSON.parse(raw) as Partial<HarnessConfig>);
  } catch {
    cached = { ...DEFAULT_CONFIG };
  }
  return cached;
}

/** Test hook: drop the in-process cache. */
export function resetConfigCache(): void {
  cached = undefined;
}

/**
 * @deprecated Durable I/O is layered on per-item scope (0.9.0); this key no
 * longer switches the durable path. Kept so old configs keep loading.
 */
export function resolveDurablePath(config: HarnessConfig, cwd?: string): string {
  if (config.durableScope !== "project") return DEFAULT_DURABLE_PATH;
  return projectDurablePath(cwd);
}

/** Path of a project's durable layer file: <projectDir>/<slug>.md. */
export function projectDurablePath(cwd?: string): string {
  return join(PROJECT_DURABLE_DIR, `${projectSlug(cwd)}.md`);
}

/** The two layers a layered import reads for a session in `cwd`: global first
 *  (so the project layer wins id collisions), the project layer only when its
 *  slug matches the session cwd. Scope defaults for untagged items ride along
 *  (a layer file's items belong to that layer). */
export function layerFilesFor(cwd?: string): LayerFile[] {
  return [
    { path: DEFAULT_DURABLE_PATH, defaultScope: { scope: "global" } },
    { path: projectDurablePath(cwd), defaultScope: { scope: "project", project: projectSlug(cwd) } },
  ];
}

/** Derive the layer scope a file at `path` represents — used when a user
 *  imports a file by explicit path: the global file → global; anything under
 *  the project dir → project + slug from the filename stem; other paths →
 *  global. Pure path-layout knowledge. */
export function defaultScopeForPath(path: string): ScopeInfo {
  if (path === DEFAULT_DURABLE_PATH) return { scope: "global" };
  if (dirname(path) === PROJECT_DURABLE_DIR) {
    const stem = basename(path, ".md");
    if (stem) return { scope: "project", project: stem };
  }
  return { scope: "global" };
}

/** Stable, filesystem-safe slug from a directory path. Falls back to "default". */
export function projectSlug(cwd?: string): string {
  const base = (cwd ?? "").trim();
  if (!base) return "default";
  const slug = base
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-z0-9-]+/gi, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(-80);
  return slug || "default";
}

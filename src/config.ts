// User configuration for continual-harness: ~/.pi/agent/harness.json
//
// Phase 2 introduces this file (optional; missing → defaults) to configure:
//  - durableScope: where the durable markdown lives. "global" (default,
//    ~/.pi/agent/harness-state.md — backward compatible) or "project"
//    (~/.pi/agent/harness-state/<slug>.md, slug derived from cwd) so different
//    projects keep separate harness state for pi-reflect.
//  - remindRefine: opt-in turn_end nudge to run /refine (Phase 2 = reminder
//    only; Phase 3 adds opt-in auto-refine).
//
// Robust by design: missing or malformed file → DEFAULT_CONFIG, never throws.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DURABLE_PATH } from "./store.js";
import { DEFAULT_INJECTION, normalizeInjection, type NormalizedInjection } from "./select.js";

export const DEFAULT_EVERY_TURNS = 50;
export const DEFAULT_AUTO_EVERY_TURNS = 100;
/** Default per-reference importance bump for the opt-in outcome loop. */
export const DEFAULT_REF_BUMP = 0.03;

export interface HarnessConfig {
  durableScope?: "global" | "project";
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
 * Resolve the durable markdown path for the configured scope.
 *  - global  → ~/.pi/agent/harness-state.md (the default, unchanged)
 *  - project → ~/.pi/agent/harness-state/<slug>.md (slug derived from cwd)
 */
export function resolveDurablePath(config: HarnessConfig, cwd?: string): string {
  if (config.durableScope !== "project") return DEFAULT_DURABLE_PATH;
  return join(homedir(), ".pi", "agent", "harness-state", `${projectSlug(cwd)}.md`);
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

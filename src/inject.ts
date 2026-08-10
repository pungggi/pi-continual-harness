// before_agent_start: inject the active harness state as a structured block
// appended to the base system prompt. Never rewrites or replaces the base —
// only appends, matching Continual Harness's "immutable base + supplemental".
//
// This handler is also the model-binding bridge. The model-facing tools
// (harness_list / harness_mutate) receive NO ctx, so they cannot read the
// active model at execute time. before_agent_start always fires first in a turn
// WITH ctx.model, so it: (1) caches the active model key for the tools,
// (2) adopts any orphan items to the active model (the migration policy), and
// (3) renders ONLY items bound to the active model — strict per-model isolation.
//
// WHAT gets rendered is decided by the selection policy in select.ts (on by
// default): importance-ordered, capped per kind and by a total token budget, so
// the block stays bounded as the harness accumulates. Configurable / opt-out via
// harness.json `injection`; the legacy "all items, in order" mode is a toggle.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { adoptOrphans, getState, modelKey, setActiveModelKey } from "./store.js";
import { KIND_ORDER, selectForInjection, type InjectionConfig } from "./select.js";
import { loadConfig } from "./config.js";
import type { ComponentKind } from "./types.js";

const TITLES: Record<ComponentKind, string> = {
  prompt: "Self-improved prompt notes",
  memory: "Remembered facts",
  skill: "Available skill notes",
  subagent: "Reusable sub-agent specs",
};

/**
 * Render the harness block for a single model. Selection (`cfg`) defaults to the
 * shipped policy when omitted — importance-ordered, capped per kind and by a
 * total token budget (see select.ts). Only active items whose ownerModel ===
 * ownerKey are ever considered. An undefined ownerKey (no active model) renders
 * nothing — isolation is strict: unknown model → inject nothing.
 */
export function renderHarnessBlock(ownerKey?: string, cfg?: InjectionConfig): string {
  if (ownerKey === undefined) return "";
  const items = getState().items;
  if (items.length === 0) return "";

  const { selected, omitted } = selectForInjection(items, ownerKey, cfg);
  if (selected.length === 0) return "";

  const sections: string[] = [];
  for (const kind of KIND_ORDER) {
    const forKind = selected.filter((i) => i.kind === kind);
    if (forKind.length === 0) continue;
    const bullets = forKind.map((i) => `- [${i.id}] ${i.content}`).join("\n");
    sections.push(`### ${TITLES[kind]}\n${bullets}`);
  }
  if (sections.length === 0) return "";

  const lines = [
    "",
    "## Continual Harness state",
    "Self-improved notes accumulated from past trajectories via /refine.",
    "Treat these as durable working context. Update them with the harness_mutate tool when they are wrong or stale.",
    "",
    sections.join("\n\n"),
  ];
  // Transparency: when the selection policy dropped items, say so — the block is
  // bounded on purpose, and the user should know the store has more than shows.
  if (omitted > 0) {
    lines.push(
      "",
      `_(${omitted} item(s) not shown — below the injection budget. Raise \`injection.maxTokens\`/\`maxPerKind\` in harness.json or run \`/harness prune\`.)_`,
    );
  }
  return lines.join("\n");
}

export function registerInjection(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const key = modelKey(ctx.model);
    // Cache for the model-facing tools (they have no ctx of their own).
    setActiveModelKey(key);
    // Adopt any orphans to the active model (legacy/import migration). No-op —
    // and no persist — when there is nothing to adopt.
    if (key) {
      adoptOrphans(key, (snapshot, ver) => {
        pi.appendEntry("harness-state", { state: snapshot, version: ver });
      });
    }
    // Read the injection policy from config (cached; tolerant). The default is
    // ON — importance-ordered + bounded — so a growing harness never balloons
    // the system prompt. Opt out via harness.json `injection.enabled: false`.
    const { injection } = await loadConfig();
    const block = renderHarnessBlock(key, injection);
    if (!block) return;
    return { systemPrompt: event.systemPrompt + "\n" + block };
  });
}

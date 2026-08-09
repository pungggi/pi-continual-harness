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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { adoptOrphans, getState, modelKey, setActiveModelKey } from "./store.js";
import type { ComponentKind } from "./types.js";

const ORDER: ComponentKind[] = ["prompt", "memory", "skill", "subagent"];

const TITLES: Record<ComponentKind, string> = {
  prompt: "Self-improved prompt notes",
  memory: "Remembered facts",
  skill: "Available skill notes",
  subagent: "Reusable sub-agent specs",
};

/**
 * Render the harness block for a single model. Only active items whose
 * ownerModel === ownerKey are included. An undefined ownerKey (no active model)
 * renders nothing — isolation is strict: unknown model → inject nothing.
 */
export function renderHarnessBlock(ownerKey?: string): string {
  if (ownerKey === undefined) return "";
  const state = getState();
  if (state.items.length === 0) return "";

  const sections: string[] = [];
  for (const kind of ORDER) {
    const items = state.items.filter((i) => i.kind === kind && i.active && i.ownerModel === ownerKey);
    if (items.length === 0) continue;
    const bullets = items
      .map((i) => `- [${i.id}] ${i.content}`)
      .join("\n");
    sections.push(`### ${TITLES[kind]}\n${bullets}`);
  }
  if (sections.length === 0) return "";

  return [
    "",
    "## Continual Harness state",
    "Self-improved notes accumulated from past trajectories via /refine.",
    "Treat these as durable working context. Update them with the harness_mutate tool when they are wrong or stale.",
    "",
    sections.join("\n\n"),
  ].join("\n");
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
    const block = renderHarnessBlock(key);
    if (!block) return;
    return { systemPrompt: event.systemPrompt + "\n" + block };
  });
}

// Injection of the active harness state — two cooperating handlers (pi ≥ 0.99):
//
//  before_agent_start: the model-binding bridge. The model-facing tools
//  (harness_list / harness_mutate) receive no usable ctx, so this always-first
//  handler (1) resolves the binding key under the configured virtual-model
//  policy (see vmodel.ts) and caches it for the tools, and (2) adopts any
//  orphan items to that key (the migration policy). It no longer bakes the
//  harness block into the base system prompt.
//
//  context_with_system: the render. Fires before EVERY provider request on the
//  full transcript (system message included), so the block always reflects the
//  LIVE store — a harness_mutate that fixes a stale note mid-run shows up on
//  the very next request instead of the next agent run. The handler owns the
//  returned transcript (pi sends it verbatim), so it returns undefined — never
//  an owned transcript — when there is nothing to inject, and otherwise keeps
//  the system message at index 0 and appends the block to it.
//
// WHAT gets rendered is decided by the selection policy in select.ts (on by
// default): importance-ordered, capped per kind and by a total token budget, so
// the block stays bounded as the harness accumulates. Configurable / opt-out via
// harness.json `injection`; the legacy "all items, in order" mode is a toggle.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { adoptOrphans, getActiveModelKey, getState, setActiveModelKey } from "./store.js";
import { KIND_ORDER, selectForInjection, type InjectionConfig } from "./select.js";
import { loadConfig } from "./config.js";
import { resolveBindingKey, branchEntries } from "./vmodel.js";
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

/** Append text to a system message's content (string or text blocks). */
function appendToSystemContent(content: string | Array<{ type: string; text?: string }>, block: string): string | Array<{ type: string; text?: string }> {
  if (typeof content === "string") return content + "\n" + block;
  return [...content, { type: "text", text: block }];
}

export function registerInjection(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (_event, ctx) => {
    // Resolve the binding key under the configured policy. For a physical
    // selection (or the default "virtual" policy) this is just provider/id;
    // under "physical" with a virtual selection it is the routed model behind
    // the latest successful response, undefined before the first response
    // (creates then become orphans, adopted on the next contact).
    const { virtualBinding } = await loadConfig();
    const key = resolveBindingKey(ctx.model, branchEntries(ctx), virtualBinding);
    // Cache for the model-facing tools (they have no ctx of their own).
    setActiveModelKey(key);
    // Adopt any orphans to the resolved key (legacy/import migration). No-op —
    // and no persist — when there is nothing to adopt.
    if (key) {
      adoptOrphans(key, (snapshot, ver) => {
        pi.appendEntry("harness-state", { state: snapshot, version: ver });
      });
    }
  });

  pi.on("context_with_system", async (event, ctx) => {
    // NOTE: injection.enabled:false inside the config means LEGACY selection
    // (all items, store order) — handled by selectForInjection, not an off
    // switch here. There is no "no injection" render path once state exists.
    const { injection, virtualBinding } = await loadConfig();
    // Prefer the live resolution (mid-run responses can change the physical
    // key under the "physical" policy); fall back to the cached agent-start
    // key when the model is momentarily unknown.
    const key =
      resolveBindingKey(ctx.model, branchEntries(ctx), virtualBinding) ??
      getActiveModelKey();
    const block = renderHarnessBlock(key, injection);
    if (!block) return; // nothing to inject — do not own the transcript
    const messages = [...event.messages];
    const sys = messages[0] as { role?: string; content?: string | Array<{ type: string; text?: string }> } | undefined;
    if (!sys || sys.role !== "system" || sys.content === undefined) return;
    messages[0] = { ...sys, content: appendToSystemContent(sys.content, block) } as (typeof messages)[number];
    return { messages };
  });
}

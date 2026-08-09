// /harness — durable I/O. The two-way round-trip seam with pi-reflect.
//
//   /harness status [path]               counts + durable file presence/mtime
//   /harness export [path]               write active items to a markdown file
//   /harness import [--prune] [path]     parse it back and merge (durable wins)
//
// export writes the active items to ~/.pi/agent/harness-state.md (best-effort);
// import parses that file and merges into the live store. Because pi-reflect
// edits markdown files and git-commits, pointing it at the same file closes the
// loop: offline refinement flows back into the online store.
//
// Manual only (no session_start auto-import): importing is an explicit,
// reviewable action, matching the package's "no autonomous mutation" stance.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import {
  bumpImportance,
  decayAndPrune,
  exportDurable,
  getState,
  modelKey,
  reconstructFromDurable,
} from "./store.js";
import { loadConfig, resolveDurablePath } from "./config.js";
import type { ComponentKind, HarnessItem } from "./types.js";

export function registerHarness(pi: ExtensionAPI): void {
  pi.registerCommand("harness", {
    description:
      "Durable harness-state I/O + importance hygiene. Subcommands: " +
      "import [--prune] [path] · export [path] · status [path] · " +
      "prune [--decay <days>] · keep <id> · drop <id> · " +
      "push-mem [--all|--kind <kind>|--model <provider/id|active>] (persist active items to pi-mem).",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "status").toLowerCase();
      const rest = parts.slice(1);
      switch (sub) {
        case "import":
          await handleImport(pi, ctx, rest);
          return;
        case "export":
          await handleExport(ctx, rest);
          return;
        case "prune":
          await handlePrune(pi, ctx, rest);
          return;
        case "keep":
          await handleBump(pi, ctx, rest, 0.1, "keep");
          return;
        case "drop":
          await handleBump(pi, ctx, rest, -0.1, "drop");
          return;
        case "push-mem":
          await handlePushMem(pi, ctx, rest);
          return;
        case "status":
        default:
          await handleStatus(ctx, rest);
          return;
      }
    },
  });
}

async function resolvePath(rest: string[], ctx: ExtensionCommandContext): Promise<string> {
  const explicit = rest.find((a) => !a.startsWith("-"));
  if (explicit) return explicit;
  const config = await loadConfig();
  return resolveDurablePath(config, ctx.cwd);
}

async function handleImport(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const prune = rest.includes("--prune");
  const path = await resolvePath(rest, ctx);
  ctx.ui.setStatus("harness", `Importing durable state${prune ? " (prune)" : ""}…`);
  try {
    const res = await reconstructFromDurable(path, { prune }, (snapshot, ver) => {
      pi.appendEntry("harness-state", { state: snapshot, version: ver });
    });
    if (res.missingFile) {
      ctx.ui.notify(
        `No durable file at ${path}. Run /refine --commit or /harness export first.`,
        "warning",
      );
      return;
    }
    const bits = [`${res.created} created`, `${res.updated} updated`];
    if (prune) bits.push(`${res.pruned} pruned`);
    ctx.ui.notify(`Imported ${res.imported} item(s) from ${path} (${bits.join(", ")}).`, "info");
  } catch (err) {
    ctx.ui.notify(`Harness import failed: ${(err as Error).message}`, "error");
  }
  ctx.ui.setStatus("harness", undefined);
}

async function handleExport(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  const path = await resolvePath(rest, ctx);
  ctx.ui.setStatus("harness", "Exporting durable state…");
  try {
    const written = await exportDurable(path);
    const n = getState().items.filter((i) => i.active).length;
    ctx.ui.notify(`Exported ${n} active item(s) to ${written}`, "info");
  } catch (err) {
    ctx.ui.notify(`Harness export failed: ${(err as Error).message}`, "error");
  }
  ctx.ui.setStatus("harness", undefined);
}

async function handlePrune(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  let decayAfterDays: number | undefined;
  const idx = rest.indexOf("--decay");
  if (idx >= 0) {
    const n = Number(rest[idx + 1]);
    decayAfterDays = Number.isFinite(n) && n > 0 ? n : undefined;
  }
  ctx.ui.setStatus("harness", "Pruning…");
  try {
    const options: { decayAfterDays?: number; decayStep?: number } = { decayStep: 0.1 };
    if (decayAfterDays !== undefined) options.decayAfterDays = decayAfterDays;
    const res = decayAndPrune(options, (snapshot, ver) => {
      pi.appendEntry("harness-state", { state: snapshot, version: ver });
    });
    const bits = [`${res.pruned} pruned`];
    if (decayAfterDays !== undefined) bits.push(`${res.decayed} decayed (>${decayAfterDays}d)`);
    ctx.ui.notify(`Harness: ${bits.join(", ")}.`, "info");
  } catch (err) {
    ctx.ui.notify(`Harness prune failed: ${(err as Error).message}`, "error");
  }
  ctx.ui.setStatus("harness", undefined);
}

async function handleBump(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
  delta: number,
  label: string,
): Promise<void> {
  const id = rest.find((a) => a && !a.startsWith("-"));
  if (!id) {
    ctx.ui.notify(
      `/harness ${label} requires an item id (see /harness status or harness_list).`,
      "warning",
    );
    return;
  }
  const item = bumpImportance(id, delta, (snapshot, ver) => {
    pi.appendEntry("harness-state", { state: snapshot, version: ver });
  });
  if (!item) {
    ctx.ui.notify(`No harness item with id ${id}.`, "warning");
    return;
  }
  const preview = item.content.length > 60 ? `${item.content.slice(0, 60)}…` : item.content;
  ctx.ui.notify(`${label}: "${preview}" → importance ${item.importance.toFixed(2)}`, "info");
}

/** Compose a steering message that asks the agent to persist the given active
 *  items to long-term memory via a memory tool (pi-mem's save_memory).
 *  Tool-agnostic: if no memory tool is present the agent says so; we never
 *  fabricate one. No dependency on pi-mem — soft-fail composition. */
function buildPushMemPrompt(items: HarnessItem[], scope: string): string {
  const lines = [
    `/harness push-mem — persist ${items.length} Continual Harness ${scope} to long-term memory`,
    "",
    "For EACH item below, call your memory tool (pi-mem exposes `save_memory`) once, mapping it as shown. This copies harness state into the semantic memory store so it is searchable across sessions.",
    "",
    "If you do NOT have a memory tool, do not fabricate one: tell the user to install pi-mem (`pi install npm:pi-mem`) and stop.",
    "",
  ];
  items.forEach((i, n) => {
    const title = `${i.id} ${i.content.slice(0, 48)}`;
    const text = `${i.content} (evidence: ${i.evidence})`;
    lines.push(
      `${n + 1}. [${i.id}] ${i.content}`,
      `   evidence: ${i.evidence}`,
      `   → save_memory({ title: ${JSON.stringify(title)}, text: ${JSON.stringify(text)}, concepts: ["${i.kind}", "continual-harness"] })`,
      "",
    );
  });
  return lines.join("\n");
}

async function handlePushMem(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const all = rest.includes("--all");
  const kindIdx = rest.indexOf("--kind");
  let kind: ComponentKind | undefined;
  if (kindIdx >= 0 && kindIdx + 1 < rest.length) {
    const k = rest[kindIdx + 1]!;
    if (k === "prompt" || k === "memory" || k === "skill" || k === "subagent") kind = k;
  }
  // --model scopes the push to one owner model (default: every model). "active"
  // resolves to the model driving this command, so you don't have to name it.
  const modelIdx = rest.indexOf("--model");
  let modelFilter: string | undefined;
  if (modelIdx >= 0 && modelIdx + 1 < rest.length) {
    const m = rest[modelIdx + 1]!;
    modelFilter = m === "active" ? (modelKey(ctx.model) ?? "") : m;
  }
  // Default: memory kind (the clean 1:1 mapping). --all or --kind override.
  const items = getState().items.filter(
    (i) =>
      i.active &&
      (all || (kind ? i.kind === kind : i.kind === "memory")) &&
      (modelFilter === undefined || i.ownerModel === modelFilter),
  );
  if (items.length === 0) {
    ctx.ui.notify(
      "No active items to push (default: memory kind; use --all, --kind <kind>, or --model <provider/id|active>).",
      "warning",
    );
    return;
  }
  const scope = all ? "item(s)" : `${kind ?? "memory"} item(s)`;
  const modelNote = modelFilter !== undefined ? ` [model ${modelFilter || "(orphan)"}]` : "";
  const msg = buildPushMemPrompt(items, scope);
  pi.sendUserMessage(msg);
  ctx.ui.notify(`Steering agent to persist ${items.length} ${scope}${modelNote} to pi-mem.`, "info");
}

async function handleStatus(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  const path = await resolvePath(rest, ctx);
  const items = getState().items;
  const active = items.filter((i) => i.active);
  const key = modelKey(ctx.model);
  const models = [...new Set(active.map((i) => i.ownerModel).filter(Boolean))];
  const mine = key ? active.filter((i) => i.ownerModel === key).length : active.length;
  // Status is a whole-store view: kind counts span every model. Annotate with
  // the current model's share so the per-model picture is still visible.
  const counts: Record<ComponentKind, number> = { prompt: 0, memory: 0, skill: 0, subagent: 0 };
  for (const i of active) counts[i.kind] += 1;
  let fileState: string;
  try {
    const st = await stat(path);
    fileState = `${path} (modified ${st.mtime.toISOString()})`;
  } catch {
    fileState = `none at ${path}`;
  }
  ctx.ui.setStatus("harness", undefined);
  ctx.ui.notify(
    `Harness: ${active.length} active / ${items.length} total — ` +
      `prompt ${counts.prompt}, memory ${counts.memory}, skill ${counts.skill}, subagent ${counts.subagent}.` +
      (key ? ` ${mine} active for [${key}] across ${models.length} model(s).` : "") +
      ` Durable: ${fileState}.`,
    "info",
  );
}

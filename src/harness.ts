// /harness — durable I/O. The two-way round-trip seam with pi-reflect.
//
//   /harness status [path]               counts + durable file presence/mtime
//   /harness export [path]               write active items to a markdown file
//   /harness import [--prune] [path]     parse it back and merge (durable wins)
//
// The command registers getArgumentCompletions so the TUI offers a filtered
// menu of subcommands (and, one level deeper, flags / item ids / kinds) as
// you type — see completions() below. The handler itself stays parsing-only.
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
import { KIND_LABEL } from "./types.js";
import type { ComponentKind, HarnessItem } from "./types.js";

/** One row of the /harness subcommand menu (label = name, value = name). */
interface CompletionEntry {
  name: string;
  description: string;
}

const SUBCOMMANDS: CompletionEntry[] = [
  { name: "import", description: "Import durable state (--prune to prune stale items)" },
  { name: "export", description: "Export active items to durable file" },
  { name: "status", description: "Show harness status (active/total, per-kind counts, durable file)" },
  { name: "prune", description: "Decay & prune inactive items (--decay <days>)" },
  { name: "keep", description: "Bump item importance (+0.1)" },
  { name: "drop", description: "Lower item importance (−0.1)" },
  { name: "push-mem", description: "Persist active items to pi-mem (--all, --kind, --model)" },
];

const KINDS: ComponentKind[] = ["prompt", "memory", "skill", "subagent"];

/** Flags each subcommand accepts, in menu order. */
const FLAGS: Record<string, CompletionEntry[]> = {
  import: [{ name: "--prune", description: "Drop live items missing from the durable file" }],
  prune: [{ name: "--decay", description: "Decay items not updated for <days> before pruning" }],
  "push-mem": [
    { name: "--all", description: "Push every active item, not just memories" },
    { name: "--kind", description: `Limit to one kind (${KINDS.join("|")})` },
    { name: "--model", description: "Limit to one owner model (provider/id or \"active\")" },
  ],
};

function preview(text: string, max = 60): string {
  // Single line + truncated so the menu row stays readable.
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Argument autocomplete for /harness (pi calls this with the FULL text after
 * the command name; a selected item's `value` REPLACES that whole text, so
 * multi-token rows re-emit the tokens already typed). Two levels:
 *
 *   /harness <partial-subcommand>      → matching subcommands
 *   /harness <sub> …<partial-token>    → flags / ids / kind+model values for sub
 *
 * Returns null where a menu would only get in the way (path arguments,
 * numeric flag values, unknown subcommands) so the editor falls back to its
 * own behavior.
 */
function completions(argumentPrefix: string) {
  // Level 1 — still typing the first token: the subcommand menu.
  if (!/\s/.test(argumentPrefix)) {
    const q = argumentPrefix.toLowerCase();
    return filterSubcommands(q);
  }
  const tokens = argumentPrefix.trim().split(/\s+/).filter(Boolean);
  // Fresh token (trailing whitespace) → the token being completed is "";
  // otherwise it is the last typed token. `before` are the committed ones.
  const fresh = argumentPrefix !== argumentPrefix.trimEnd();
  const last = fresh ? "" : (tokens.at(-1) ?? "");
  const before = fresh ? tokens : tokens.slice(0, -1);

  // A stray leading space ("/harness  imp") still means level 1, matching the
  // handler's tolerant split.
  if (before.length === 0) return filterSubcommands(last.toLowerCase());

  const sub = before[0]!.toLowerCase();
  // Flag-value completion: the token right before the one being typed.
  const prev = before.at(-1)!;
  if (prev === "--kind" && sub === "push-mem") {
    return filterValues(
      KINDS.map((k) => ({ value: k, description: KIND_LABEL[k] })),
      last,
      before,
    );
  }
  if (prev === "--model" && sub === "push-mem") {
    const owners = [...new Set(getState().items.filter((i) => i.active && i.ownerModel).map((i) => i.ownerModel))];
    return filterValues(
      [
        { value: "active", description: "The model driving this command" },
        ...owners.map((m) => ({ value: m, description: "Items owned by this model" })),
      ],
      last,
      before,
    );
  }

  // Flag completion ("--…" prefix, or a fresh token for flag-taking subs).
  // A fresh --kind/--model value was already completed above (early return),
  // so a fresh token here means "offer the remaining flags".
  if (last.startsWith("--") || (fresh && sub in FLAGS)) {
    const used = new Set(before.filter((t) => t.startsWith("--")));
    const rows = (FLAGS[sub] ?? []).filter((f) => !used.has(f.name));
    const items = rows
      .filter((f) => f.name.startsWith(last))
      .map((f) => ({ value: [...before, f.name].join(" "), label: f.name, description: f.description }));
    return items.length > 0 ? items : null;
  }

  // Positional id completion for keep/drop: the one argument they take.
  if (sub === "keep" || sub === "drop") {
    const idCommitted = before.slice(1).some((t) => !t.startsWith("--"));
    if (idCommitted) return null; // id already chosen; nothing left to complete
    const items = getState()
      .items.filter((i) => i.active && i.id.startsWith(last))
      .map((i: HarnessItem) => ({
        value: [...before, i.id].join(" "),
        label: i.id,
        description: `${i.kind} · ${preview(i.content)}`,
      }));
    return items.length > 0 ? items : null;
  }

  // Everything else is a path/number/free-text argument — no menu.
  return null;
}

function filterSubcommands(prefix: string) {
  const items = SUBCOMMANDS.filter((s) => s.name.startsWith(prefix)).map((s) => ({
    value: s.name,
    label: s.name,
    description: s.description,
  }));
  return items.length > 0 ? items : null;
}

/** Flag-value completion: `value` = committed tokens + the chosen value. */
function filterValues(
  rows: Array<{ value: string; description: string }>,
  prefix: string,
  before: string[],
) {
  const items = rows
    .filter((r) => r.value.startsWith(prefix))
    .map((r) => ({ value: [...before, r.value].join(" "), label: r.value, description: r.description }));
  return items.length > 0 ? items : null;
}

export function registerHarness(pi: ExtensionAPI): void {
  pi.registerCommand("harness", {
    description:
      "Durable harness-state I/O + importance hygiene " +
      "(import · export · status · prune · keep · drop · push-mem — " +
      "subcommands autocomplete as you type)",
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
    getArgumentCompletions: (argumentPrefix) => completions(argumentPrefix),
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

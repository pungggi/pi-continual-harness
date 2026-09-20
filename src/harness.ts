// /harness — durable I/O. The two-way round-trip seam with pi-reflect.
//
//   /harness status [path]               counts + durable layer presence/mtime
//   /harness export [path]               layered export (or full snapshot to path)
//   /harness import [--prune] [path]     layered import (or single file from path)
//   /harness move <id> <global|project>  move an item between durable layers
//   /harness split                       steer the agent to classify scopes
//
// The command registers getArgumentCompletions so the TUI offers a filtered
// menu of subcommands (and, one level deeper, flags / item ids / values) as
// you type — see completions() below. The handler itself stays parsing-only.
//
// Durable I/O is LAYERED on per-item scope (issue #7): every item belongs to
// the global layer (~/.pi/agent/harness-state.md) or a project layer
// (~/.pi/agent/harness-state/<slug>.md). Without an explicit path, export
// writes each layer from the items' own scope and import merges global first,
// then the current project's file (project wins id collisions; --prune drops
// only items absent from EVERY layer). An explicit path keeps the classic
// single-file semantics — untagged items default to the layer the path
// represents (see defaultScopeForPath).
//
// Importing stays a manual, reviewable action by default; opt into the
// session_start auto-import + turn_end auto-export bundle with
// harness.json { "autoImport": true } (see durable.ts).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyDeltas,
  bumpImportance,
  decayAndPrune,
  DEFAULT_DURABLE_PATH,
  exportDurable,
  exportDurableLayers,
  getState,
  importDurableLayers,
  modelKey,
  PROJECT_DURABLE_DIR,
  reconstructFromDurable,
} from "./store.js";
import {
  defaultScopeForPath,
  layerFilesFor,
  loadConfig,
  projectDurablePath,
  projectSlug,
} from "./config.js";
import { KIND_LABEL } from "./types.js";
import type { ComponentKind, Delta, HarnessItem } from "./types.js";
import { buildCorpus } from "./corpus.js";

/** One row of the /harness subcommand menu (label = name, value = name). */
interface CompletionEntry {
  name: string;
  description: string;
}

const SUBCOMMANDS: CompletionEntry[] = [
  { name: "import", description: "Import durable state, layered (--prune to prune stale items)" },
  { name: "export", description: "Export active items to durable layers (or one file with a path)" },
  { name: "export-corpus", description: "Export calibration corpus JSONL for pi-reflex (dedupe pairs + lifecycle)" },
  { name: "status", description: "Show harness status (active/total, per-kind counts, durable layers)" },
  { name: "prune", description: "Decay & prune inactive items (--decay <days>)" },
  { name: "keep", description: "Bump item importance (+0.1)" },
  { name: "drop", description: "Lower item importance (−0.1)" },
  { name: "move", description: "Move an item between durable scopes (global | project)" },
  { name: "split", description: "Steer the agent to classify every item global vs project" },
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

  // Positional id completion for keep/drop/move: the first argument they take.
  if (sub === "keep" || sub === "drop" || sub === "move") {
    const positionals = before.slice(1).filter((t) => !t.startsWith("--"));
    // move takes a second positional: the target scope.
    if (sub === "move") {
      if (positionals.length >= 2) return null; // id + scope chosen; done
      if (positionals.length === 1) {
        return filterValues(
          [
            { value: "global", description: "The shared durable file (~/.pi/agent/harness-state.md)" },
            { value: "project", description: "This project's durable file (harness-state/<slug>.md)" },
          ],
          last,
          before,
        );
      }
    } else if (positionals.length > 0) {
      return null; // id already chosen; nothing left to complete
    }
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
        case "export-corpus":
          await handleExportCorpus(ctx, rest);
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
        case "move":
          await handleMove(pi, ctx, rest);
          return;
        case "split":
          await handleSplit(pi, ctx);
          return;
        case "push-mem":
          await handlePushMem(pi, ctx, rest);
          return;
        case "status":
        default:
          await handleStatus(ctx);
          return;
      }
    },
    getArgumentCompletions: (argumentPrefix) => completions(argumentPrefix),
  });
}

/** Explicit path argument, if any (flags like --prune are skipped). */
function explicitPath(rest: string[]): string | undefined {
  return rest.find((a) => !a.startsWith("-"));
}

async function handleImport(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const prune = rest.includes("--prune");
  const explicit = explicitPath(rest);
  ctx.ui.setStatus("harness", `Importing durable state${prune ? " (prune)" : ""}…`);
  try {
    let res;
    if (explicit) {
      // Single-file semantics; untagged items adopt the layer the path
      // represents (global file → global; project dir → that project).
      const defaultScope = defaultScopeForPath(explicit);
      res = await reconstructFromDurable(explicit, { prune }, (snapshot, ver) => {
        pi.appendEntry("harness-state", { state: snapshot, version: ver });
      }).then((r) => ({ ...r, path: explicit }));
      if (res.missingFile) {
        ctx.ui.notify(`No durable file at ${explicit}. Run /refine --commit or /harness export first.`, "warning");
        return;
      }
    } else {
      // Layered: global always + the current project's file, merged in one
      // pass (project wins id collisions; --prune is union-scoped).
      res = await importDurableLayers(layerFilesFor(ctx.cwd), { prune }, (snapshot, ver) => {
        pi.appendEntry("harness-state", { state: snapshot, version: ver });
      });
      if (res.missingFile) {
        ctx.ui.notify(
          `No durable files at ${DEFAULT_DURABLE_PATH} (or ${projectDurablePath(ctx.cwd)}). Run /refine --commit or /harness export first.`,
          "warning",
        );
        return;
      }
    }
    const bits = [`${res.created} created`, `${res.updated} updated`];
    if (prune) bits.push(`${res.pruned} pruned`);
    ctx.ui.notify(`Imported ${res.imported} item(s) (${bits.join(", ")}).`, "info");
  } catch (err) {
    ctx.ui.notify(`Harness import failed: ${(err as Error).message}`, "error");
  }
  ctx.ui.setStatus("harness", undefined);
}

async function handleExport(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  ctx.ui.setStatus("harness", "Exporting durable state…");
  try {
    const explicit = explicitPath(rest);
    if (explicit) {
      // Full single-file snapshot (both scopes; project items tagged with a
      // `scope:` sub-line so the file round-trips from anywhere).
      const written = await exportDurable(explicit);
      const n = getState().items.filter((i) => i.active).length;
      ctx.ui.notify(`Exported ${n} active item(s) to ${written}`, "info");
    } else {
      // Layered: partition by each item's own scope.
      const written = await exportDurableLayers(
        { globalPath: DEFAULT_DURABLE_PATH, projectDir: PROJECT_DURABLE_DIR },
        projectSlug(ctx.cwd),
      );
      const n = getState().items.filter((i) => i.active).length;
      ctx.ui.notify(`Exported ${n} active item(s) to ${written.length} layer file(s): ${written.join(", ")}`, "info");
    }
  } catch (err) {
    ctx.ui.notify(`Harness export failed: ${(err as Error).message}`, "error");
  }
  ctx.ui.setStatus("harness", undefined);
}

function toJsonl(rows: unknown[]): string {
  return rows.length > 0 ? `${rows.map((r) => JSON.stringify(r)).join("\n")}\n` : "";
}

/** `/harness export-corpus [path]` — write the calibration corpora (contract
 *  §4) from THIS session branch's audit trail. Default dir:
 *  ./harness-corpus/<yyyy-mm-dd>/. Local file output only — contract invariant:
 *  nothing leaves the machine. */
async function handleExportCorpus(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  const explicit = explicitPath(rest);
  const dir = explicit ?? join("harness-corpus", new Date().toISOString().slice(0, 10));
  ctx.ui.setStatus("harness", "Exporting calibration corpus…");
  try {
    // Config-aware citation classification: the outcome loop's bump is
    // configurable (default 0.03), so the classifier must not hardcode it.
    const { outcomeImportance } = await loadConfig();
    const corpus = buildCorpus(ctx.sessionManager.getBranch() as Iterable<unknown>, {
      citeBump: outcomeImportance?.bump,
    });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dedupe-pairs.jsonl"), toJsonl(corpus.pairs));
    await writeFile(join(dir, "lifecycle.jsonl"), toJsonl(corpus.lifecycle));
    ctx.ui.notify(
      `Calibration corpus → ${dir}: ${corpus.pairs.length} dedupe pair(s), ${corpus.lifecycle.length} lifecycle event(s). Local files only — nothing leaves the machine.`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(`/harness export-corpus failed: ${(err as Error).message}`, "error");
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

/** /harness move <id> <global|project> — flip an item's durable layer.
 *  Implemented as an audited update delta (no actor model: like keep/drop,
 *  this is cross-model user maintenance). "project" is stamped with the
 *  CURRENT session's slug so the item lands in this project's file. */
async function handleMove(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const positionals = rest.filter((a) => a && !a.startsWith("-"));
  const id = positionals[0];
  const scope = positionals[1];
  if (!id || (scope !== "global" && scope !== "project")) {
    ctx.ui.notify(`/harness move requires: <id> <global|project> (ids via /harness status).`, "warning");
    return;
  }
  const delta: Delta =
    scope === "project"
      ? { op: "update", id, scope, project: projectSlug(ctx.cwd) }
      : { op: "update", id, scope };
  try {
    const [applied] = applyDeltas([delta], (snapshot, ver) => {
      pi.appendEntry("harness-state", { state: snapshot, version: ver });
    });
    if (applied?.op === "update") {
      const target =
        scope === "project"
          ? `project "${applied.after.project ?? ""}"`
          : "global";
      ctx.ui.notify(
        `Moved ${id} → ${target}: "${preview(applied.after.content)}" (run /harness export to update the layer files).`,
        "info",
      );
    }
  } catch (err) {
    ctx.ui.notify(`/harness move failed: ${(err as Error).message}`, "error");
  }
}

/** Compose the /harness split steering message: the agent classifies every
 *  active item global-vs-project and applies the classification as ONE
 *  harness_mutate batch of scope-only update deltas — visible in the
 *  transcript, audited, and /tree-rollback-able, exactly like push-mem. */
function buildSplitPrompt(items: HarnessItem[], slug: string, cwd: string): string {
  const lines = [
    `/harness split — classify ${items.length} Continual Harness item(s) into durable scopes`,
    "",
    `Current project: ${cwd} (slug \"${slug}\").`,
    "",
    "For EACH item below, decide its durable scope:",
    "- `project` — only useful when working in THIS project (deploy procedures, project architecture, local conventions, project-specific quirks).",
    "- `global` — useful in every project (model quirks, owner preferences, general engineering practices).",
    "",
    "Then apply the whole classification in ONE harness_mutate call: one update delta per item, changing ONLY the scope field, e.g.",
    '{ "op": "update", "id": "h_xxx", "scope": "project" }',
    `(the "project" slug is stamped server-side to "${slug}"; content/evidence/importance stay untouched). Give every item an explicit decision — skip nothing. If an item is project-specific only in part, choose "project" and leave generalizing it for a later /refine.`,
    "",
    "Items:",
  ];
  items.forEach((i, n) => {
    lines.push(
      `${n + 1}. [${i.id}] (${i.kind}, importance ${i.importance.toFixed(2)}, ${i.scope === "project" ? `project \"${i.project ?? ""}\"` : "global"}) ${i.content}`,
      `   evidence: ${i.evidence}`,
    );
  });
  return lines.join("\n");
}

async function handleSplit(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const items = getState().items.filter((i) => i.active);
  if (items.length === 0) {
    ctx.ui.notify("No active items to split (run /refine first).", "warning");
    return;
  }
  pi.sendUserMessage(buildSplitPrompt(items, projectSlug(ctx.cwd), ctx.cwd));
  ctx.ui.notify(`Steering agent to classify ${items.length} item(s) global vs project "${projectSlug(ctx.cwd)}".`, "info");
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

async function handleStatus(ctx: ExtensionCommandContext): Promise<void> {
  const items = getState().items;
  const active = items.filter((i) => i.active);
  const key = modelKey(ctx.model);
  const models = [...new Set(active.map((i) => i.ownerModel).filter(Boolean))];
  const mine = key ? active.filter((i) => i.ownerModel === key).length : active.length;
  // Status is a whole-store view: kind counts span every model. Annotate with
  // the current model's share so the per-model picture is still visible.
  const counts: Record<ComponentKind, number> = { prompt: 0, memory: 0, skill: 0, subagent: 0 };
  for (const i of active) counts[i.kind] += 1;
  const nProject = active.filter((i) => i.scope === "project").length;
  async function layerState(path: string): Promise<string> {
    try {
      const st = await stat(path);
      return `${path} (modified ${st.mtime.toISOString()})`;
    } catch {
      return `none at ${path}`;
    }
  }
  const durable =
    ` Durable: global ${await layerState(DEFAULT_DURABLE_PATH)};` +
    ` project ${await layerState(projectDurablePath(ctx.cwd))}.`;
  ctx.ui.setStatus("harness", undefined);
  ctx.ui.notify(
    `Harness: ${active.length} active / ${items.length} total — ` +
      `prompt ${counts.prompt}, memory ${counts.memory}, skill ${counts.skill}, subagent ${counts.subagent}` +
      ` — scope ${active.length - nProject} global / ${nProject} project.` +
      (key ? ` ${mine} active for [${key}] across ${models.length} model(s).` : "") +
      durable,
    "info",
  );
}

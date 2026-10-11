// /harness — durable I/O. The two-way round-trip seam with pi-reflect.
//
//   /harness status [path]               counts + durable layer presence/mtime
//   /harness list [-f] [--kind] [--scope]  read items: compact rows, -f = full text
//   /harness export [path]               layered export (or full snapshot to path)
//   /harness import [--prune] [path]     layered import (or single file from path)
//   /harness move <id> <global|project>  move an item between durable layers
//   /harness split                       steer the agent to classify scopes
//   /harness adopt --from <provider/id> [--all]
//                                         steer the agent to adopt another
//                                         model's items (copy, not move)
//   /harness setup [--preset <name>] [--yes]  guided config wizard (issue #22)
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
  getActiveModelKey,
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
import { branchEntries, resolveBindingKey } from "./vmodel.js";
import { buildCorpus } from "./corpus.js";
import { buildStatusReport, renderStatusReport } from "./status.js";
import { getInjectionStats } from "./inject.js";
import { nextHint } from "./hints.js";
import { preview, renderListReport, type ListScope } from "./list.js";
import { handleSetup, PRESET_COMPLETIONS } from "./setup.js";

/** One row of the /harness subcommand menu (label = name, value = name). */
interface CompletionEntry {
  name: string;
  description: string;
}

const SUBCOMMANDS: CompletionEntry[] = [
  { name: "import", description: "Import durable state, layered (--prune to prune stale items)" },
  { name: "export", description: "Export active items to durable layers (or one file with a path)" },
  { name: "export-corpus", description: "Export calibration corpus JSONL for pi-reflex (dedupe pairs + lifecycle)" },
  { name: "status", description: "Show harness status (counts, audit-trail impact, injection stats, durable layers)" },
  { name: "list", description: "Read items — compact rows, -f for full text (--kind/--scope filter)" },
  { name: "prune", description: "Decay & prune inactive items (--decay <days>)" },
  { name: "keep", description: "Bump item importance (+0.1)" },
  { name: "drop", description: "Lower item importance (−0.1)" },
  { name: "move", description: "Move an item between durable scopes (global | project)" },
  { name: "split", description: "Steer the agent to classify every item global vs project" },
  { name: "adopt", description: "Steer the agent to adopt another model's items (--from <provider/id> [--all])" },
  { name: "push-mem", description: "Persist active items to pi-mem (--all, --kind, --model)" },
  { name: "setup", description: "Guided config wizard — presets: quiet | recommended | power (--yes for scripted)" },
];

const KINDS: ComponentKind[] = ["prompt", "memory", "skill", "subagent"];

/** `--scope` values /harness list offers (semantics in src/list.ts). */
const LIST_SCOPES: Array<{ value: ListScope; description: string }> = [
  { value: "global", description: "Global-scope items only (~/.pi/agent/harness-state.md)" },
  { value: "project", description: "Project-scoped items (any project; rows carry the slug)" },
  { value: "all", description: "Every item, foreign-project included" },
];

/** Flags each subcommand accepts, in menu order. */
const FLAGS: Record<string, CompletionEntry[]> = {
  import: [{ name: "--prune", description: "Drop live items missing from the durable file" }],
  prune: [{ name: "--decay", description: "Decay items not updated for <days> before pruning" }],
  "push-mem": [
    { name: "--all", description: "Push every active item, not just memories" },
    { name: "--kind", description: `Limit to one kind (${KINDS.join("|")})` },
    { name: "--model", description: "Limit to one owner model (provider/id or \"active\")" },
  ],
  adopt: [
    { name: "--from", description: "Source model (provider/id) whose active items are up for adoption" },
    { name: "--all", description: "Adopt everything; skip the generalizes-vs-stays filter" },
  ],
  list: [
    { name: "-f", description: "Full item text + evidence instead of the compact preview rows" },
    { name: "--kind", description: `Limit to one kind (${KINDS.join("|")})` },
    { name: "--scope", description: "global | project | all (default: global + this project)" },
  ],
  setup: [
    { name: "--preset", description: "Apply one preset: quiet | recommended | power" },
    { name: "--yes", description: "Scripted consent — skip every confirm prompt" },
  ],
};

// preview() lives in src/list.ts (shared with /harness list rows).

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
  if (prev === "--kind" && (sub === "push-mem" || sub === "list")) {
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
  if (prev === "--preset" && sub === "setup") {
    return filterValues(PRESET_COMPLETIONS, last, before);
  }
  if (prev === "--scope" && sub === "list") {
    return filterValues(LIST_SCOPES, last, before);
  }
  // --from completes from the model keys actually present in the store (the
  // adoption source pool), with each owner's active-item count as the help
  // line — the same store-backed completion style as --model above.
  if (prev === "--from" && sub === "adopt") {
    return filterValues(
      [...activeOwnerCounts().entries()].map(
        ([m, n]) => ({ value: m, description: `${n} active item(s) owned by this model` }),
      ),
      last,
      before,
    );
  }

  // Flag completion ("-…" prefix, or a fresh token for flag-taking subs —
  // the "-" prefix also matches short flags like list's -f). A fresh
  // --kind/--scope/--model value was already completed above (early
  // return), so a fresh token here means "offer the remaining flags".
  if (last.startsWith("-") || (fresh && sub in FLAGS)) {
    const used = new Set(before.filter((t) => t.startsWith("-")));
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
      "(import · export · status · adopt · prune · keep · drop · push-mem — " +
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
        case "adopt":
          await handleAdopt(pi, ctx, rest);
          return;
        case "push-mem":
          await handlePushMem(pi, ctx, rest);
          return;
        case "setup":
          await handleSetup(ctx, rest);
          return;
        case "list":
          await handleList(ctx, rest);
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

/** `/harness list [-f] [--kind <kind>] [--scope <global|project|all>]`
 *  (issue #31) — the read view: thin glue (flag parsing + one notify); every
 *  selection/rendering rule lives in the pure src/list.ts. Read-only: no
 *  store mutation, no durable writes. Invalid flag values AND unexpected
 *  arguments warn instead of silently falling back — a filter that quietly
 *  ignores its own argument would make the listing lie. */
async function handleList(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  const full = rest.includes("-f");
  let kind: ComponentKind | undefined;
  const kindIdx = rest.indexOf("--kind");
  if (kindIdx >= 0) {
    const k = kindIdx + 1 < rest.length ? rest[kindIdx + 1]! : undefined;
    if (!k || k.startsWith("-") || !KINDS.includes(k as ComponentKind)) {
      ctx.ui.notify(`/harness list: --kind expects one of ${KINDS.join("|")}.`, "warning");
      return;
    }
    kind = k as ComponentKind;
  }
  let scope: ListScope | undefined;
  const scopeIdx = rest.indexOf("--scope");
  if (scopeIdx >= 0) {
    const s = scopeIdx + 1 < rest.length ? rest[scopeIdx + 1]! : undefined;
    if (s !== "global" && s !== "project" && s !== "all") {
      ctx.ui.notify("/harness list: --scope expects global|project|all.", "warning");
      return;
    }
    scope = s;
  }
  // Unexpected arguments (unknown flags like --full, stray positionals,
  // repeated flags) warn too — the same no-silent-fallback rule as invalid
  // values. Anything but -f, --kind <value>, --scope <value> is refused.
  const consumed = new Set<number>();
  if (kindIdx >= 0) { consumed.add(kindIdx); consumed.add(kindIdx + 1); }
  if (scopeIdx >= 0) { consumed.add(scopeIdx); consumed.add(scopeIdx + 1); }
  const unexpected = rest.filter((t, idx) => t !== "-f" && !consumed.has(idx));
  if (unexpected.length > 0) {
    ctx.ui.notify(
      `/harness list: unexpected argument(s): ${unexpected.join(" ")} — expected -f, --kind <kind>, --scope <global|project|all>.`,
      "warning",
    );
    return;
  }
  ctx.ui.notify(
    renderListReport(getState().items, {
      ...(kind ? { kind } : {}),
      ...(scope ? { scope } : {}),
      ...(full ? { full } : {}),
      slug: projectSlug(ctx.cwd),
    }),
    "info",
  );
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

/** Active items grouped by owning model key ("provider/id" → count). The
 *  adoption source pool — powers --from completion and the unknown-model
 *  diagnosis. Orphans (owner "") are excluded: they are adopted automatically
 *  on first contact, not via /harness adopt. */
function activeOwnerCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const i of getState().items) {
    if (i.active && i.ownerModel) counts.set(i.ownerModel, (counts.get(i.ownerModel) ?? 0) + 1);
  }
  return counts;
}

/** Upper bound on one adoption batch. Matches harness_mutate's per-call delta
 *  cap (maxItems: 20 in tools.ts) so the steered agent can land the WHOLE
 *  adoption in ONE audited, rollback-able batch — the property /tree rollback
 *  and the audit story rely on. Keep the two constants in sync. */
export const ADOPT_BATCH_CAP = 20;

/** Select a source model's active items for adoption: importance desc (ties
 *  keep store order — the same stable policy as injection selection), capped
 *  to ADOPT_BATCH_CAP. A huge source harness adopts its best items first; the
 *  notify/prompt surface the truncation so nothing is silently lost. */
export function selectAdoptSource(items: HarnessItem[]): HarnessItem[] {
  return items
    .filter((i) => i.active)
    .map((i, idx) => [i, idx] as const)
    .sort((a, b) => b[0].importance - a[0].importance || a[1] - b[1])
    .map(([i]) => i)
    .slice(0, ADOPT_BATCH_CAP);
}

/** Compose the /harness adopt steering message (issue #21): the agent
 *  classifies each source item generalizes-vs-stays (unless --all) and applies
 *  the adoption as ONE harness_mutate batch of create deltas — copy, not move:
 *  the source model's harness stays untouched, and because ownerModel is not
 *  exposed to the model, the creates stamp to the ACTIVE model via the normal
 *  create-stamping path. Pure: (items, fromKey, opts) → string. */
export function buildAdoptPrompt(
  items: HarnessItem[],
  fromKey: string,
  opts: { all?: boolean } = {},
): string {
  const lines = [
    `/harness adopt${opts.all ? " --all" : ""} — ${items.length} item(s) up for adoption from ${fromKey}`,
    "",
  ];
  if (opts.all) {
    lines.push(
      "`--all` skips the filter: adopt EVERY item below.",
      "",
    );
  } else {
    lines.push(
      "For EACH item below, decide whether it transfers into YOUR harness:",
      "- `generalizes` — model-agnostic knowledge (engineering practices, user preferences, project facts): ADOPT it.",
      `- \`stays\` — specific to ${fromKey} (its quirks, formatting preferences, failure modes): SKIP it.`,
      "",
      "The filter decides WHETHER an item transfers — never rewrite its content (anti-collapse).",
      "",
    );
  }
  lines.push(
    "Apply the adoption in ONE harness_mutate call of create deltas ONLY (a create per adopted item), e.g.",
    `{ "op": "create", "kind": "memory", "content": "<source content, copied verbatim>", "evidence": "<source evidence> (adopted from ${fromKey})", "importance": <exact source importance> }`,
    "Rules:",
    "- This is COPY, not move — never update or delete the source items (they belong to " + fromKey + ").",
    "- Never set ownerModel — creates stamp to the active model automatically.",
    "- Copy content VERBATIM and carry over kind, importance (full precision, exactly as listed per item), and durable scope (a project item keeps { \"scope\": \"project\" }, stamped to THIS session's slug).",
    "- Skip an item whose content you already own; overlaps clean up later with `/refine --proposer dedupe`.",
    opts.all
      ? "- Summarize at the end: adopted N item(s), skipped any you already owned."
      : "- Summarize at the end: adopted N, skipped M (stays) — with one short reason per skip.",
    "",
    "Items:",
  );
  items.forEach((i, n) => {
    // Full precision (no toFixed): the agent copies the listed importance
    // verbatim into the create delta, and a rounded value would change the
    // copy's ranking against existing items in injection selection (review #25).
    lines.push(
      `${n + 1}. [${i.id}] (${i.kind}, importance ${i.importance}, ${i.scope === "project" ? `project \"${i.project ?? ""}\"` : "global"}) ${i.content}`,
      `   evidence: ${i.evidence}`,
    );
  });
  return lines.join("\n");
}

/** `/harness adopt --from <provider/id> [--all]` (issue #21) — the reviewable
 *  path for carrying OWNED items across models (orphan adoption only covers
 *  unowned ones). Manual and explicit only: collect the source model's active
 *  items (importance-ordered, batch-capped), steer the agent to filter + copy
 *  them via harness_mutate creates stamped to the ACTIVE model. The command
 *  itself never mutates — the mutation it steers is audited and /tree-
 *  rollback-able, exactly like split and push-mem. */
async function handleAdopt(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const fromIdx = rest.indexOf("--from");
  const from = fromIdx >= 0 && fromIdx + 1 < rest.length && !rest[fromIdx + 1]!.startsWith("--")
    ? rest[fromIdx + 1]!
    : undefined;
  if (!from) {
    ctx.ui.notify(
      "/harness adopt requires --from <provider/id> (the source model; values complete from the models in the store).",
      "warning",
    );
    return;
  }
  // The adopter is the key creates will be stamped with: the RESOLVED binding
  // key (virtualBinding-aware), not the raw selection. Under "physical" a
  // router selection adopts as the routed model, so both the self-adopt guard
  // and the already-owned filter below must see the same key as
  // create-stamping (review #25).
  const { virtualBinding } = await loadConfig();
  const active = resolveBindingKey(ctx.model, branchEntries(ctx), virtualBinding) ?? getActiveModelKey();
  if (from === active) {
    ctx.ui.notify(
      `${from} is already the active model's harness — adopt copies from ANOTHER model (see /harness status for the models in the store).`,
      "warning",
    );
    return;
  }
  const source = getState().items.filter((i) => i.active && i.ownerModel === from);
  if (source.length === 0) {
    const owners = activeOwnerCounts();
    ctx.ui.notify(
      owners.size === 0
        ? "No active items in the harness — nothing to adopt from."
        : `No active items owned by ${from}. Model(s) in the store: ${[...owners.entries()].map(([m, n]) => `${m} (${n})`).join(", ")}.`,
      "warning",
    );
    return;
  }
  // Foreign-project items are SKIPPED, not re-stamped: adopting an item
  // scoped to project A from a session in project B would stamp the copy with
  // B's slug, silently moving A's project facts into B's durable layer. Adopt
  // them from a session in that project instead (review #25).
  const slug = projectSlug(ctx.cwd);
  const adoptable = source.filter((i) => i.scope !== "project" || i.project === slug);
  const foreign = source.length - adoptable.length;
  // Content the adopter already owns (exact match, any active state) is
  // skipped BEFORE the cap — otherwise a >cap source re-selects the same
  // highest-ranked items forever and the prompt's "skip what you own" never
  // gets past them, stranding the rest of the source (review #25).
  const owned = new Set(
    getState().items.filter((i) => i.ownerModel === active).map((i) => i.content),
  );
  const pool = adoptable.filter((i) => !owned.has(i.content));
  const ownedSkipped = adoptable.length - pool.length;
  if (pool.length === 0) {
    const reasons: string[] = [];
    if (ownedSkipped > 0) reasons.push(`${ownedSkipped} already owned (identical content)`);
    if (foreign > 0) reasons.push(`${foreign} scoped to another project`);
    ctx.ui.notify(
      `Nothing to adopt from ${from}: of ${source.length} active item(s), ${reasons.join(", ")}.`,
      "warning",
    );
    return;
  }
  const items = selectAdoptSource(pool);
  const bits: string[] = [];
  if (items.length < pool.length) bits.push(`capped to the ${items.length} highest-importance of ${pool.length}`);
  if (ownedSkipped > 0) bits.push(`${ownedSkipped} already owned`);
  if (foreign > 0) bits.push(`${foreign} foreign-project skipped`);
  const suffix = bits.length > 0 ? ` (${bits.join("; ")})` : "";
  pi.sendUserMessage(buildAdoptPrompt(items, from, { all: rest.includes("--all") }));
  ctx.ui.notify(
    `Steering agent to ${rest.includes("--all") ? "adopt" : "review for adoption"} ${items.length} item(s) from ${from}${suffix}.`,
    "info",
  );
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
  // Thin glue (issue #20): config + durable-layer stat() I/O here; every
  // derived band lives in the pure buildStatusReport (src/status.ts).
  const config = await loadConfig();
  // Key the per-model bands by the CONFIGURED binding policy (review #27):
  // under "physical" with a virtual selection, items are owned by the routed
  // physical model — modelKey(ctx.model) would look up the router id and
  // report zero for the active owner's events.
  const key = resolveBindingKey(ctx.model, branchEntries(ctx), config.virtualBinding);
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
  const injection = getInjectionStats();
  const report = buildStatusReport(getState(), ctx.sessionManager.getBranch() as Iterable<unknown>, {
    config,
    ...(key ? { modelKey: key } : {}),
    ...(injection ? { injection } : {}),
  });
  const hint = nextHint(report.hints);
  ctx.ui.setStatus("harness", undefined);
  ctx.ui.notify(renderStatusReport(report, { durable, ...(hint ? { hint } : {}) }), "info");
}

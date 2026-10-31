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
  makePersist,
  modelKey,
  reconstructFromDurable,
  type DurableImportResult,
} from "./store.js";
import {
  defaultScopeForPath,
  layerFilesFor,
  loadConfig,
  projectDurablePath,
  projectSlug,
} from "./config.js";
import { KEEP_DROP_BUMP, KIND_LABEL, KIND_ORDER } from "./types.js";
import type { ComponentKind, Delta, HarnessItem } from "./types.js";
import { MAX_DELTAS } from "./schemas.js";
import { branchEntries, resolveBindingKey } from "./vmodel.js";
import { buildCorpus } from "./corpus.js";
import { buildStatusReport, renderStatusReport } from "./status.js";
import { getInjectionStats } from "./inject.js";
import { nextHint } from "./hints.js";
import { preview, renderListReport, type ListScope } from "./list.js";
import { buildLessonsDigest } from "./lessons.js";
import { defaultLayerPaths } from "./durable.js";
import { handleSetup, PRESET_COMPLETIONS } from "./setup.js";

/** One row of the /harness subcommand menu (label = name, value = name). */
interface CompletionEntry {
  name: string;
  description: string;
}

const SUBCOMMANDS: CompletionEntry[] = [
  { name: "import", description: "Import durable state, layered (--prune to prune stale items)" },
  {
    name: "export",
    description: "Export active items to durable layers (or one file with a path)",
  },
  {
    name: "export-corpus",
    description: "Export calibration corpus JSONL for pi-reflex (dedupe pairs + lifecycle)",
  },
  {
    name: "status",
    description:
      "Show harness status (counts, audit-trail impact, injection stats, durable layers)",
  },
  {
    name: "list",
    description: "Read items — compact rows, -f for full text (--kind/--scope filter)",
  },
  { name: "prune", description: "Decay & prune inactive items (--decay <days>)" },
  { name: "keep", description: "Bump item importance (+0.1)" },
  { name: "drop", description: "Lower item importance (−0.1)" },
  { name: "move", description: "Move an item between durable scopes (global | project)" },
  { name: "split", description: "Steer the agent to classify every item global vs project" },
  {
    name: "adopt",
    description: "Steer the agent to adopt another model's items (--from <provider/id> [--all])",
  },
  { name: "push-mem", description: "Persist active items to pi-mem (--all, --kind, --model)" },
  {
    name: "setup",
    description: "Guided config wizard — presets: quiet | recommended | power (--yes for scripted)",
  },
  {
    name: "lessons",
    description: "Evidence-gated lessons from past refines (the digest /refine steers with)",
  },
];

// KIND_ORDER (types.ts) is the one kind list; KIND_LABEL supplies menu labels.

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
    { name: "--kind", description: `Limit to one kind (${KIND_ORDER.join("|")})` },
    { name: "--model", description: 'Limit to one owner model (provider/id or "active")' },
  ],
  adopt: [
    {
      name: "--from",
      description: "Source model (provider/id) whose active items are up for adoption",
    },
    { name: "--all", description: "Adopt everything; skip the generalizes-vs-stays filter" },
  ],
  list: [
    { name: "-f", description: "Full item text + evidence instead of the compact preview rows" },
    { name: "--kind", description: `Limit to one kind (${KIND_ORDER.join("|")})` },
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
/** /harness completions — see the block comment above `completions()`. */
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
  const values = completeFlagValue(sub, before.at(-1)!, last, before, fresh);
  if (values !== null) return values;
  return completePositional(sub, last, before);
}

/** Flag-VALUE completion: the token right before the one being typed names a
 *  value flag (--kind/--model/--preset/--scope/--from). Returns the matching
 *  value menu, or null when the previous token is not a value flag. */
function completeFlagValue(
  sub: string,
  prev: string,
  last: string,
  before: string[],
  fresh: boolean,
): ReturnType<typeof filterValues> {
  if (prev === "--kind" && (sub === "push-mem" || sub === "list")) {
    return filterValues(
      KIND_ORDER.map((k) => ({ value: k, description: KIND_LABEL[k] })),
      last,
      before,
    );
  }
  if (prev === "--model" && sub === "push-mem") {
    const owners = [
      ...new Set(
        getState()
          .items.filter((i) => i.active && i.ownerModel)
          .map((i) => i.ownerModel),
      ),
    ];
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
      [...activeOwnerCounts().entries()].map(([m, n]) => ({
        value: m,
        description: `${n} active item(s) owned by this model`,
      })),
      last,
      before,
    );
  }

  // Flag NAME completion ("-" prefix, or a fresh token for flag-taking subs —
  // the "-" prefix also matches short flags like list's -f). A fresh
  // --kind/--scope/--model value was already completed above (early
  // return), so a fresh token here means "offer the remaining flags".
  // Object.hasOwn guards BOTH the condition and the lookup (review finding
  // #2): a bogus subcommand naming an inherited Object member ("constructor",
  // "toString", …) otherwise resolves FLAGS[sub] to Function — the `?? []`
  // does not catch it (Function is not nullish) and .filter throws. Same
  // class as the expandPreset fix in review #26.
  if (last.startsWith("-") || (fresh && Object.hasOwn(FLAGS, sub))) {
    const used = new Set(before.filter((t) => t.startsWith("-")));
    const rows = (Object.hasOwn(FLAGS, sub) ? FLAGS[sub]! : []).filter((f) => !used.has(f.name));
    const items = rows
      .filter((f) => f.name.startsWith(last))
      .map((f) => ({
        value: [...before, f.name].join(" "),
        label: f.name,
        description: f.description,
      }));
    return items.length > 0 ? items : null;
  }
  return null;
}

/** Positional completion: item ids for keep/drop/move (and the target scope
 *  for move's second positional). Returns null for path/number/free-text
 *  arguments — no menu is better than a wrong one. */
function completePositional(
  sub: string,
  last: string,
  before: string[],
): ReturnType<typeof filterValues> {
  if (sub === "keep" || sub === "drop" || sub === "move") {
    const positionals = before.slice(1).filter((t) => !t.startsWith("--"));
    // move takes a second positional: the target scope.
    if (sub === "move") {
      if (positionals.length >= 2) return null; // id + scope chosen; done
      if (positionals.length === 1) {
        return filterValues(
          [
            {
              value: "global",
              description: "The shared durable file (~/.pi/agent/harness-state.md)",
            },
            {
              value: "project",
              description: "This project's durable file (harness-state/<slug>.md)",
            },
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
    .map((r) => ({
      value: [...before, r.value].join(" "),
      label: r.value,
      description: r.description,
    }));
  return items.length > 0 ? items : null;
}

/** /harness command body — subcommand dispatch. Exported so the thin entry
 *  (entry.ts) can delegate here via dynamic import without paying this
 *  module's static graph at pi startup (issue #36). */
export async function runHarnessCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
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
      await handleBump(pi, ctx, rest, KEEP_DROP_BUMP, "keep");
      return;
    case "drop":
      await handleBump(pi, ctx, rest, -KEEP_DROP_BUMP, "drop");
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
    case "lessons":
      handleLessons(ctx);
      return;
    case "list":
      await handleList(ctx, rest);
      return;
    default:
      await handleStatus(ctx);
      return;
  }
}

/** /harness argument completions — exported for entry.ts's lazy delegation. */
export function harnessCompletions(argumentPrefix: string) {
  return completions(argumentPrefix);
}

/** Explicit path argument, if any (flags like --prune are skipped). */
function explicitPath(rest: string[]): string | undefined {
  return rest.find((a) => !a.startsWith("-"));
}

// ---- strict flag parsing (the no-silent-fallback rule) ----------------------
//
// handleList documents the rule: "invalid flag values AND unexpected arguments
// warn instead of silently falling back — a filter that quietly ignores its
// own argument would make the listing lie." These helpers give every other
// subcommand the same semantics.

/** Read `--flag <value>` where the value must be one of `values`.
 *  Returns the value, undefined when the flag is absent, or "invalid" when it
 *  is present but its value is missing, looks like another flag, or is not
 *  allowed — the caller warns and aborts on "invalid", never guesses. */
function enumFlagValue(
  rest: string[],
  flag: string,
  values: readonly string[],
): string | undefined | "invalid" {
  const i = rest.indexOf(flag);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  return v !== undefined && !v.startsWith("-") && values.includes(v) ? v : "invalid";
}

/** Read `--flag <number>` where the number must be finite and > 0. Same
 *  absent / invalid contract as enumFlagValue. */
function positiveNumberFlagValue(rest: string[], flag: string): number | undefined | "invalid" {
  const i = rest.indexOf(flag);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  const n = Number(v);
  return v !== undefined && !v.startsWith("-") && Number.isFinite(n) && n > 0 ? n : "invalid";
}

/** Read `--flag <freeform-value>` (e.g. --model, whose values are not
 *  enumerable). Same absent / invalid contract; any non-flag token is valid. */
function stringFlagValue(rest: string[], flag: string): string | undefined | "invalid" {
  const i = rest.indexOf(flag);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  return v !== undefined && !v.startsWith("-") ? v : "invalid";
}

/** Non-flag tokens in `rest` (flag VALUES are excluded by name). */
function positionals(rest: string[], valueFlags: string[] = []): string[] {
  const skip = new Set<string>();
  for (const f of valueFlags) {
    const i = rest.indexOf(f);
    if (i >= 0) skip.add(rest[i + 1] ?? "");
  }
  return rest.filter((t) => !t.startsWith("-") && !skip.has(t));
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
    if (!k || k.startsWith("-") || !KIND_ORDER.includes(k as ComponentKind)) {
      ctx.ui.notify(`/harness list: --kind expects one of ${KIND_ORDER.join("|")}.`, "warning");
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
  if (kindIdx >= 0) {
    consumed.add(kindIdx);
    consumed.add(kindIdx + 1);
  }
  if (scopeIdx >= 0) {
    consumed.add(scopeIdx);
    consumed.add(scopeIdx + 1);
  }
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
    let res: DurableImportResult;
    if (explicit) {
      // Single-file semantics; untagged items adopt the layer the path
      // represents (global file → global; project dir → that project). The
      // defaultScope used to be computed here and never threaded through —
      // every explicit-path import silently defaulted to global instead.
      res = await reconstructFromDurable(
        explicit,
        { prune, defaultScope: defaultScopeForPath(explicit) },
        makePersist(pi),
      ).then((r) => ({ ...r, path: explicit }));
      if (res.missingFile) {
        ctx.ui.notify(
          `No durable file at ${explicit}. Run /refine --commit or /harness export first.`,
          "warning",
        );
        return;
      }
    } else {
      // Layered: global always + the current project's file, merged in one
      // pass (project wins id collisions; --prune is union-scoped).
      res = await importDurableLayers(layerFilesFor(ctx.cwd), { prune }, makePersist(pi));
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
      const written = await exportDurableLayers(defaultLayerPaths(), projectSlug(ctx.cwd));
      const n = getState().items.filter((i) => i.active).length;
      ctx.ui.notify(
        `Exported ${n} active item(s) to ${written.length} layer file(s): ${written.join(", ")}`,
        "info",
      );
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
  const decay = positiveNumberFlagValue(rest, "--decay");
  if (decay === "invalid") {
    ctx.ui.notify("/harness prune: --decay expects a positive number of days.", "warning");
    return;
  }
  const decayAfterDays = decay;
  ctx.ui.setStatus("harness", "Pruning…");
  try {
    const options: { decayAfterDays?: number; decayStep?: number } = { decayStep: 0.1 };
    if (decayAfterDays !== undefined) options.decayAfterDays = decayAfterDays;
    const res = decayAndPrune(options, makePersist(pi));
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
  const args = positionals(rest);
  const id = args[0];
  if (!id) {
    ctx.ui.notify(
      `/harness ${label} requires an item id (see /harness status or harness_list).`,
      "warning",
    );
    return;
  }
  if (args.length > 1) {
    ctx.ui.notify(
      `/harness ${label}: unexpected argument(s): ${args.slice(1).join(" ")} — it takes exactly one item id.`,
      "warning",
    );
    return;
  }
  const item = bumpImportance(
    id,
    delta,
    makePersist(pi),
    // Record the human signal in the support counters (keep/drop).
    { support: label === "keep" ? "keep" : "drop" },
  );
  if (!item) {
    ctx.ui.notify(`No harness item with id ${id}.`, "warning");
    return;
  }
  ctx.ui.notify(
    `${label}: "${preview(item.content)}" → importance ${item.importance.toFixed(2)}`,
    "info",
  );
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
  const args = positionals(rest);
  const id = args[0];
  const scope = args[1];
  if (!id || (scope !== "global" && scope !== "project")) {
    ctx.ui.notify(
      `/harness move requires: <id> <global|project> (ids via /harness status).`,
      "warning",
    );
    return;
  }
  if (args.length > 2) {
    ctx.ui.notify(
      `/harness move: unexpected argument(s): ${args.slice(2).join(" ")} — it takes <id> <global|project>.`,
      "warning",
    );
    return;
  }
  const delta: Delta =
    scope === "project"
      ? { op: "update", id, scope, project: projectSlug(ctx.cwd) }
      : { op: "update", id, scope };
  try {
    const [applied] = applyDeltas([delta], makePersist(pi));
    if (applied?.op === "update") {
      const target = scope === "project" ? `project "${applied.after.project ?? ""}"` : "global";
      ctx.ui.notify(
        `Moved ${id} → ${target}: "${preview(applied.after.content)}" (run /harness export to update the layer files).`,
        "info",
      );
    }
  } catch (err) {
    ctx.ui.notify(`/harness move failed: ${(err as Error).message}`, "error");
  }
}

/** Numbered item listing shared by the split/adopt steering prompts. The
 *  format had already drifted once (adopt carries full-precision importance
 *  because the agent copies it verbatim into create deltas — review #25;
 *  split rounds to 2). One renderer keeps the layout in lockstep. */
function formatItemLines(items: HarnessItem[], importance: "raw" | "fixed"): string[] {
  return items.flatMap((i, n) => [
    `${n + 1}. [${i.id}] (${i.kind}, importance ${importance === "fixed" ? i.importance.toFixed(2) : i.importance}, ${i.scope === "project" ? `project "${i.project ?? ""}"` : "global"}) ${i.content}`,
    `   evidence: ${i.evidence}`,
  ]);
}

/** Compose the /harness split steering message: the agent classifies every
 *  active item global-vs-project and applies the classification as ONE
 *  harness_mutate batch of scope-only update deltas — visible in the
 *  transcript, audited, and /tree-rollback-able, exactly like push-mem. */
function buildSplitPrompt(items: HarnessItem[], slug: string, cwd: string): string {
  const lines = [
    `/harness split — classify ${items.length} Continual Harness item(s) into durable scopes`,
    "",
    `Current project: ${cwd} (slug "${slug}").`,
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
    ...formatItemLines(items, "fixed"),
  ];
  return lines.join("\n");
}

async function handleSplit(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const items = getState().items.filter((i) => i.active);
  if (items.length === 0) {
    ctx.ui.notify("No active items to split (run /refine first).", "warning");
    return;
  }
  // deliverAs "followUp": queue behind any in-flight run (pi ≥ 1.2 busy window
  // starts at run start; a bare send would throw) rather than steering mid-task.
  pi.sendUserMessage(buildSplitPrompt(items, projectSlug(ctx.cwd), ctx.cwd), {
    deliverAs: "followUp",
  });
  ctx.ui.notify(
    `Steering agent to classify ${items.length} item(s) global vs project "${projectSlug(ctx.cwd)}".`,
    "info",
  );
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

/** Upper bound on one adoption batch: harness_mutate's per-call delta cap
 *  (MAX_DELTAS in schemas.ts), derived rather than hand-synced, so the steered
 *  agent can land the WHOLE adoption in ONE audited, rollback-able batch —
 *  the property /tree rollback and the audit story rely on. */
export const ADOPT_BATCH_CAP = MAX_DELTAS;

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
    lines.push("`--all` skips the filter: adopt EVERY item below.", "");
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
    "- This is COPY, not move — never update or delete the source items (they belong to " +
      fromKey +
      ").",
    "- Never set ownerModel — creates stamp to the active model automatically.",
    '- Copy content VERBATIM and carry over kind, importance (full precision, exactly as listed per item), and durable scope (a project item keeps { "scope": "project" }, stamped to THIS session\'s slug).',
    "- Skip an item whose content you already own; overlaps clean up later with `/refine --proposer dedupe`.",
    opts.all
      ? "- Summarize at the end: adopted N item(s), skipped any you already owned."
      : "- Summarize at the end: adopted N, skipped M (stays) — with one short reason per skip.",
    "",
    "Items:",
    ...formatItemLines(items, "raw"),
  );
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
  const from = stringFlagValue(rest, "--from");
  if (from === "invalid") {
    ctx.ui.notify(
      "/harness adopt: --from expects a value (the source model, provider/id — values complete from the models in the store).",
      "warning",
    );
    return;
  }
  if (!from) {
    ctx.ui.notify(
      "/harness adopt requires --from <provider/id> (the source model; values complete from the models in the store).",
      "warning",
    );
    return;
  }
  const extra = positionals(rest, ["--from"]);
  if (extra.length > 0) {
    ctx.ui.notify(
      `/harness adopt: unexpected argument(s): ${extra.join(" ")} — it takes no positional arguments.`,
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
  const active =
    resolveBindingKey(ctx.model, branchEntries(ctx), virtualBinding) ?? getActiveModelKey();
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
    getState()
      .items.filter((i) => i.ownerModel === active)
      .map((i) => i.content),
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
  if (items.length < pool.length)
    bits.push(`capped to the ${items.length} highest-importance of ${pool.length}`);
  if (ownedSkipped > 0) bits.push(`${ownedSkipped} already owned`);
  if (foreign > 0) bits.push(`${foreign} foreign-project skipped`);
  const suffix = bits.length > 0 ? ` (${bits.join("; ")})` : "";
  pi.sendUserMessage(buildAdoptPrompt(items, from, { all: rest.includes("--all") }), {
    deliverAs: "followUp",
  });
  ctx.ui.notify(
    `Steering agent to ${rest.includes("--all") ? "adopt" : "review for adoption"} ${items.length} item(s) from ${from}${suffix}.`,
    "info",
  );
}

/** Char cap for a push-mem memory title (pi-mem titles stay one line). */
const PUSH_MEM_TITLE_CHARS = 48;

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
    const title = `${i.id} ${i.content.slice(0, PUSH_MEM_TITLE_CHARS)}`;
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
  // No silent fallbacks (the handleList rule): an invalid --kind/--model value
  // warns and aborts instead of quietly pushing a different scope than asked.
  const kind = enumFlagValue(rest, "--kind", KIND_ORDER);
  if (kind === "invalid") {
    ctx.ui.notify(`/harness push-mem: --kind expects one of ${KIND_ORDER.join("|")}.`, "warning");
    return;
  }
  // --model scopes the push to one owner model (default: every model). "active"
  // resolves to the model driving this command, so you don't have to name it.
  const model = stringFlagValue(rest, "--model");
  if (model === "invalid") {
    ctx.ui.notify(
      '/harness push-mem: --model expects a value (provider/id or "active").',
      "warning",
    );
    return;
  }
  const modelFilter =
    model === undefined ? undefined : model === "active" ? (modelKey(ctx.model) ?? "") : model;
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
  pi.sendUserMessage(msg, { deliverAs: "followUp" });
  ctx.ui.notify(
    `Steering agent to persist ${items.length} ${scope}${modelNote} to pi-mem.`,
    "info",
  );
}

/** `/harness lessons` — print the exact evidence-gated digest the next /refine
 *  steers with (harnessing-level recursion, Harness² arXiv 2610.14224).
 *  Read-only; distinct empty state when nothing supportable exists yet. */
function handleLessons(ctx: ExtensionCommandContext): void {
  const digest = buildLessonsDigest(
    getState(),
    ctx.sessionManager.getBranch() as Iterable<unknown>,
  );
  if (!digest) {
    ctx.ui.notify(
      "No lessons yet — items need citations (outcome loop) or /harness keep|drop feedback, or past refine runs, before anything is evidence-gated.",
      "info",
    );
    return;
  }
  ctx.ui.notify(digest, "info");
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
  const report = buildStatusReport(
    getState(),
    ctx.sessionManager.getBranch() as Iterable<unknown>,
    {
      config,
      ...(key ? { modelKey: key } : {}),
      ...(injection ? { injection } : {}),
    },
  );
  const hint = nextHint(report.hints);
  ctx.ui.setStatus("harness", undefined);
  ctx.ui.notify(renderStatusReport(report, { durable, ...(hint ? { hint } : {}) }), "info");
}

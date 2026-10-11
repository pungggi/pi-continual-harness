// `/harness list` (issue #31) — the read view of the store. One compact row
// per item (id, kind, importance, scope, preview) or, with `-f`, the full
// text + evidence rendering the harness_list tool uses. Read-only: selection
// and rendering are pure; harness.ts's handleList stays thin glue (flag
// parsing + one ctx.ui.notify).
//
// Scope semantics mirror the durable layers (issue #7): the default view is
// the session's own layer set — global + the ACTIVE project — because that is
// what /harness import|export touch for this cwd. Items scoped to a DIFFERENT
// project are hidden (and counted in a note) unless you ask for them:
// `--scope project` lists every project-scoped item (rows carry the slug) and
// `--scope all` lists everything. An item's undefined scope counts as global
// (legacy snapshots / durable files — see types.ts).

import type { ComponentKind, HarnessItem } from "./types.js";

/** `--scope` values for /harness list. `undefined` (no flag) = the session's
 *  layer set: global + the active project. */
export type ListScope = "global" | "project" | "all";

/** Options for selectListItems / renderListReport. */
export interface ListOptions {
  /** Filter by component kind (mirrors harness_list's kind parameter). */
  kind?: ComponentKind;
  /** Durable-scope filter; undefined = global + the active project. */
  scope?: ListScope;
  /** `-f`: full text + evidence per item (default: one compact row). */
  full?: boolean;
  /** The active project's slug (from the session cwd); selects the default
   *  view and labels the header. */
  slug: string;
}

/** Single-line, whitespace-flattened preview truncated to `max` chars — the
 *  shared truncation style for one-line rows (menu entries, notifications). */
export function preview(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** True when an item belongs to the durable layer(s) the options select. */
function inScope(i: HarnessItem, opts: ListOptions): boolean {
  switch (opts.scope) {
    case "global":
      return i.scope !== "project";
    case "project":
      return i.scope === "project";
    case "all":
      return true;
    default:
      // Session layer set: global + the active project (undefined scope is
      // global; a project item only shows when its slug is the active one).
      return i.scope !== "project" || i.project === opts.slug;
  }
}

/** Select the listable items: kind filter, scope filter, then importance
 *  desc with ties keeping store order — the same stable ranking policy as
 *  injection selection and /harness adopt. Pure. */
export function selectListItems(items: HarnessItem[], opts: ListOptions): HarnessItem[] {
  return items
    .filter((i) => (opts.kind ? i.kind === opts.kind : true) && inScope(i, opts))
    .map((i, idx) => [i, idx] as const)
    .sort((a, b) => b[0].importance - a[0].importance || a[1] - b[1])
    .map(([i]) => i);
}

/** Compact row: `[id] kind importance scope preview` (issue #31's table);
 *  inactive items carry an `(inactive)` marker so the row stays one line. */
function row(i: HarnessItem): string {
  const scope = i.scope === "project" ? `project:${i.project ?? "?"}` : "global";
  return `[${i.id}] ${i.kind.padEnd(8)} ${i.importance.toFixed(2)} ${scope} ${
    i.active ? "" : "(inactive) "
  }${preview(i.content)}`;
}

/** Full row (`-f`): the harness_list rendering, scope-aware — the same
 *  parenthetical the split/adopt prompts use, plus the evidence line. */
function fullRow(i: HarnessItem): string {
  const bits = [
    i.kind,
    `importance ${i.importance.toFixed(2)}`,
    i.active ? "active" : "inactive",
    `model ${i.ownerModel || "(orphan)"}`,
    i.scope === "project" ? `project "${i.project ?? ""}"` : "global",
  ];
  return `[${i.id}] (${bits.join(", ")}) ${i.content}\n  evidence: ${i.evidence}`;
}

/** Tally `items` by a string key, rendered as "key (n), key (n)". */
function tally<T>(items: T[], key: (i: T) => string): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(key(i), (counts.get(key(i)) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${k} (${n})`).join(", ");
}

function scopeDescription(opts: ListOptions): string {
  switch (opts.scope) {
    case "global":
      return "scope global";
    case "project":
      return 'scope project (any project\'s items; rows carry the slug)';
    case "all":
      return "scope all";
    default:
      return `scope global + project "${opts.slug}"`;
  }
}

/** Render the whole `/harness list` notify string: header (count + active
 *  filters), rows (compact by default, full text + evidence with `full`),
 *  and distinct empty-state guidance for an empty store vs an empty filter
 *  result (the emptyListMessage lesson: never collapse the two). Pure. */
export function renderListReport(items: HarnessItem[], opts: ListOptions): string {
  const shown = selectListItems(items, opts);
  const filters = [`--scope ${opts.scope ?? "global+project"}`, ...(opts.kind ? [`--kind ${opts.kind}`] : [])];
  const header =
    `Harness list: ${shown.length} item(s) — ${scopeDescription(opts)}` +
    (opts.kind ? `, kind ${opts.kind}` : "") +
    ` (${opts.full ? "full text" : "compact; -f for full text"}).`;
  if (shown.length === 0) {
    if (items.length === 0) {
      return [
        header,
        "No harness items yet. Run `/refine` after a working session (or `/harness import`) — items appear here as they are created.",
      ].join("\n");
    }
    return [
      header,
      `Nothing matches ${filters.join(" ")}. The store holds ${items.length} item(s): ${tally(items, (i) => i.kind)}. Widen --scope or drop --kind.`,
    ].join("\n");
  }
  const lines = [header, ...shown.map(opts.full ? fullRow : row)];
  // The default view hides foreign-project items on purpose (they are not
  // this session's layers) — say so instead of letting them look missing.
  if (opts.scope === undefined) {
    const foreign = items.filter(
      (i) => i.scope === "project" && i.project !== opts.slug && (opts.kind ? i.kind === opts.kind : true),
    ).length;
    if (foreign > 0) {
      lines.push(`+ ${foreign} foreign-project item(s) hidden — re-run with --scope all to see them.`);
    }
  }
  return lines.join("\n");
}

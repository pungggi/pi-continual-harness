// /harness list (issue #31) — the pure read view:
//  - selectListItems: kind filter, scope semantics (default = global + the
//    active project; global / project / all), importance-desc stable order.
//  - renderListReport: compact rows vs -f full text + evidence, empty store
//    vs empty filter guidance, the foreign-project hidden note.

import { describe, it, expect } from "vitest";
import type { HarnessItem } from "../src/types.js";
import { preview, renderListReport, selectListItems, type ListOptions } from "../src/list.js";

function item(over: Partial<HarnessItem> & Pick<HarnessItem, "id" | "kind" | "content">): HarnessItem {
  const now = 10_000;
  return {
    evidence: "e",
    importance: 0.5,
    active: true,
    ownerModel: "",
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** The fixture store: g1/g2 global, p1 this project ("app"), f1 a foreign
 *  project, i1 inactive global — kinds and importances chosen so the
 *  importance-desc order differs from insertion order. */
const SLUG = "app";
function fixture(): HarnessItem[] {
  return [
    item({ id: "h_g1", kind: "memory", content: "global fact", importance: 0.4 }),
    item({ id: "h_p1", kind: "prompt", content: "app note", importance: 0.9, scope: "project", project: SLUG }),
    item({ id: "h_f1", kind: "memory", content: "foreign fact", importance: 0.8, scope: "project", project: "other" }),
    item({ id: "h_g2", kind: "skill", content: "global skill", importance: 0.6 }),
    item({ id: "h_i1", kind: "memory", content: "old fact", importance: 0.1, active: false }),
  ];
}

const opts = (over: Partial<ListOptions> = {}): ListOptions => ({ slug: SLUG, ...over });

describe("selectListItems", () => {
  it("default scope: global + the active project, importance-desc (ties keep store order)", () => {
    const ids = selectListItems(fixture(), opts()).map((i) => i.id);
    // h_p1 (0.9) > h_g2 (0.6) > h_g1 (0.4) > h_i1 (0.1); h_f1 (foreign) hidden.
    expect(ids).toEqual(["h_p1", "h_g2", "h_g1", "h_i1"]);
  });

  it("--scope global: global items only (undefined scope counts as global)", () => {
    const ids = selectListItems(fixture(), opts({ scope: "global" })).map((i) => i.id);
    expect(ids).toEqual(["h_g2", "h_g1", "h_i1"]);
  });

  it("--scope project: every project-scoped item, foreign included", () => {
    const ids = selectListItems(fixture(), opts({ scope: "project" })).map((i) => i.id);
    expect(ids).toEqual(["h_p1", "h_f1"]);
  });

  it("--scope all: everything", () => {
    expect(selectListItems(fixture(), opts({ scope: "all" }))).toHaveLength(5);
  });

  it("kind filter composes with every scope", () => {
    expect(selectListItems(fixture(), opts({ kind: "memory" })).map((i) => i.id)).toEqual(["h_g1", "h_i1"]);
    expect(selectListItems(fixture(), opts({ kind: "memory", scope: "all" })).map((i) => i.id)).toEqual([
      "h_f1",
      "h_g1",
      "h_i1",
    ]);
  });

  it("inactive items stay selectable (rows mark them)", () => {
    const rows = selectListItems(fixture(), opts({ scope: "global" }));
    expect(rows.some((i) => !i.active)).toBe(true);
  });
});

describe("renderListReport", () => {
  it("compact rows: id, kind, importance, scope, ~60-char preview; header names the view", () => {
    const long = "x".repeat(80);
    const items = [
      item({ id: "h_a", kind: "memory", content: long, importance: 0.42 }),
      item({ id: "h_b", kind: "prompt", content: "app note", importance: 0.9, scope: "project", project: SLUG }),
    ];
    const out = renderListReport(items, opts());
    const lines = out.split("\n");
    expect(lines[0]).toContain("2 item(s)");
    expect(lines[0]).toContain(`global + project "${SLUG}"`);
    expect(lines[1]).toBe(`[h_b] prompt   0.90 project:${SLUG} app note`);
    expect(lines[2]).toBe(`[h_a] memory   0.42 global ${"x".repeat(60)}…`);
  });

  it("inactive items carry an (inactive) marker in the row", () => {
    const out = renderListReport([item({ id: "h_a", kind: "memory", content: "old", active: false })], opts());
    expect(out.split("\n")[1]).toBe("[h_a] memory   0.50 global (inactive) old");
  });

  it("-f: full text + evidence + owner + scope, harness_list-style", () => {
    const out = renderListReport(
      [
        item({
          id: "h_a",
          kind: "memory",
          content: "full\ntext",
          evidence: "the evidence",
          ownerModel: "test/main",
          importance: 0.42,
          scope: "project",
          project: SLUG,
        }),
      ],
      opts({ full: true }),
    );
    expect(out.split("\n").slice(1).join("\n")).toBe(
      `[h_a] (memory, importance 0.42, active, model test/main, project "${SLUG}") full\ntext\n  evidence: the evidence`,
    );
  });

  it("empty store: zero-state guidance, not a bare zero", () => {
    const out = renderListReport([], opts());
    expect(out.split("\n")[0]).toContain("0 item(s)");
    expect(out).toContain("`/refine`");
  });

  it("empty filter result: explains what the store holds instead", () => {
    const out = renderListReport(fixture(), opts({ kind: "subagent" }));
    expect(out).toContain("Nothing matches the current filters.");
    // No pseudo-flag echo: `--scope global+project` would not even parse.
    expect(out).not.toContain("--scope global+project");
    expect(out).toContain("5 item(s)");
    expect(out).toContain("memory (3)");
  });

  it("foreign-only results keep the hidden note, empty or not (review #32)", () => {
    const foreignOnly = [item({ id: "h_f1", kind: "memory", content: "foreign fact", importance: 0.8, scope: "project", project: "other" })];
    // Listed result: the note rides along as before.
    expect(renderListReport([...foreignOnly, item({ id: "h_g", kind: "memory", content: "g", importance: 0.5 })], opts()))
      .toContain("1 foreign-project item(s) hidden");
    // Foreign-only store, default scope: the empty result still explains
    // WHERE the items went instead of generic filter guidance alone.
    const out = renderListReport(foreignOnly, opts());
    expect(out).toContain("0 item(s)");
    expect(out).toContain("Nothing matches");
    expect(out).toContain("1 foreign-project item(s) hidden");
    // Same through a kind filter that matches only the foreign item.
    expect(renderListReport(foreignOnly, opts({ kind: "memory" }))).toContain("1 foreign-project item(s) hidden");
    // An explicit --scope suppresses the note (the user chose that scope).
    expect(renderListReport(foreignOnly, opts({ scope: "global" }))).not.toContain("foreign-project item(s) hidden");
  });

  it("default view notes hidden foreign-project items; explicit scopes do not", () => {
    const base = renderListReport(fixture(), opts());
    expect(base).toContain("1 foreign-project item(s) hidden");
    expect(renderListReport(fixture(), opts({ scope: "all" }))).not.toContain("foreign-project item(s) hidden");
    expect(renderListReport(fixture(), opts({ scope: "project" }))).not.toContain("foreign-project item(s) hidden");
  });

  it("foreign note respects the kind filter (only counts what --kind matches)", () => {
    // No foreign prompt exists → no note under --kind prompt.
    expect(renderListReport(fixture(), opts({ kind: "prompt" }))).not.toContain("foreign-project item(s) hidden");
    // A foreign memory exists → the note counts it.
    expect(renderListReport(fixture(), opts({ kind: "memory" }))).toContain("1 foreign-project item(s) hidden");
  });
});

describe("preview", () => {
  it("flattens whitespace and truncates with an ellipsis at 60 by default", () => {
    expect(preview("a\n  b", 60)).toBe("a b");
    expect(preview(`${"x".repeat(61)}`)).toBe(`${"x".repeat(60)}…`);
    expect(preview(`${"x".repeat(60)}`)).toBe("x".repeat(60));
  });
});

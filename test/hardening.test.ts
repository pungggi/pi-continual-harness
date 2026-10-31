// Hardening regressions from the quality pass: corrupt-snapshot field
// coercion at reconstruct, ENOENT-vs-real-error durable reads, the
// no-silent-fallback flag rule on /harness subcommands, and the
// harness_mutate boundary guard.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getState,
  importDurableLayers,
  reconstruct,
  reconstructFromDurable,
} from "../src/store.js";
import { validateDeltas } from "../src/tools.js";
import { runHarnessCommand } from "../src/harness.js";
import { makeFakePi } from "./helpers.js";

describe("reconstruct coerces corrupt snapshot field types", () => {
  it("drops items with an unsalvageable id/kind/content and normalizes the rest", () => {
    const snapshot = {
      items: [
        // importance as a string used to pass through and crash toFixed(2).
        {
          id: "h_a",
          kind: "prompt",
          content: "ok",
          evidence: "e",
          importance: "high",
          active: "yes",
          ownerModel: 42,
          createdAt: "x",
          updatedAt: null,
        },
        // Unknown kind used to survive and crash per-kind tallies.
        { id: "h_b", kind: 42, content: "bad kind", evidence: "e", importance: 0.5 },
        // Non-string content is unsalvageable.
        { id: "h_c", kind: "memory", content: 123, evidence: "e", importance: 0.5 },
        // A perfectly fine item rides along untouched.
        { id: "h_d", kind: "memory", content: "fine", evidence: "e", importance: 0.7 },
      ],
    };
    reconstruct([{ type: "custom", customType: "harness-state", data: { state: snapshot } }]);
    const items = getState().items;
    expect(items.map((i) => i.id)).toEqual(["h_a", "h_d"]);
    const coerced = items[0]!;
    expect(coerced.importance).toBe(0.5); // string → create default, not NaN
    expect(coerced.active).toBe(true); // "yes" → boolean default
    expect(coerced.ownerModel).toBe(""); // 42 → orphan
    expect(Number.isFinite(coerced.createdAt)).toBe(true); // "x" → now
    expect(Number.isFinite(coerced.updatedAt)).toBe(true);
    // Renders over the coerced item no longer throw.
    expect(() => coerced.importance.toFixed(2)).not.toThrow();
  });
});

describe("durable reads distinguish missing files from real errors", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-ch-hard-"));
    reconstruct([]);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a missing file (ENOENT) is missingFile: true", async () => {
    const res = await reconstructFromDurable(join(dir, "nope.md"), {}, () => {});
    expect(res.missingFile).toBe(true);
  });

  it("a real read error (EISDIR) propagates instead of masquerading as missing", async () => {
    await expect(
      importDurableLayers([{ path: dir, defaultScope: { scope: "global" } }], {}, () => {}),
    ).rejects.toThrow(/EISDIR|illegal operation/i);
    await expect(reconstructFromDurable(dir, {}, () => {})).rejects.toThrow(
      /EISDIR|illegal operation/i,
    );
  });

  it("/harness import reports the failure as an error, not 'no durable file'", async () => {
    const { pi, ctx, notifications } = makeFakePi([]);
    await runHarnessCommand(pi, `import ${dir}`, ctx() as never);
    const warned = notifications.filter((n) => n.level === "error" && /import failed/i.test(n.msg));
    expect(warned).toHaveLength(1);
    expect(notifications.some((n) => /No durable file/i.test(n.msg))).toBe(false);
  });
});

describe("/harness subcommands warn on invalid flags (no silent fallback)", () => {
  beforeEach(() => {
    reconstruct([]);
  });

  /** Run one /harness invocation against a fresh fake; return its notify
   *  lines as "level: msg" for assertion. */
  async function run(args: string): Promise<string[]> {
    const { pi, ctx, notifications } = makeFakePi([]);
    await runHarnessCommand(pi, args, ctx() as never);
    return notifications.map((n) => `${n.level}: ${n.msg}`);
  }

  it("push-mem rejects an invalid --kind instead of silently pushing memories", async () => {
    const out = await run("push-mem --kind bogus");
    expect(out.join("\n")).toMatch(/--kind expects one of prompt\|memory\|skill\|subagent/);
    expect(out.some((l) => l.startsWith("info:"))).toBe(false); // no steering happened
  });

  it("push-mem rejects a valueless --model", async () => {
    const out = await run("push-mem --model");
    expect(out.join("\n")).toMatch(/--model expects a value/);
  });

  it("prune rejects a non-numeric --decay instead of pruning without decay", async () => {
    const out = await run("prune --decay soon");
    expect(out.join("\n")).toMatch(/--decay expects a positive number of days/);
  });

  it("prune rejects a valueless --decay", async () => {
    const out = await run("prune --decay");
    expect(out.join("\n")).toMatch(/--decay expects a positive number of days/);
  });

  it("adopt rejects unexpected positional arguments", async () => {
    const out = await run("adopt --from other/model stray");
    expect(out.join("\n")).toMatch(/unexpected argument\(s\): stray/);
  });

  it("keep rejects a second positional argument", async () => {
    const out = await run("keep h_1 h_2");
    expect(out.join("\n")).toMatch(/unexpected argument\(s\): h_2/);
  });

  it("move rejects a third positional argument", async () => {
    const out = await run("move h_1 global extra");
    expect(out.join("\n")).toMatch(/unexpected argument\(s\): extra/);
  });

  it("valid flags still work: prune --decay 30 runs", async () => {
    const out = await run("prune --decay 30");
    expect(out.join("\n")).toMatch(/Harness: 0 pruned, 0 decayed \(>30d\)/);
  });
});

describe("harness_mutate boundary guard (validateDeltas)", () => {
  it("accepts a sound batch", () => {
    expect(
      validateDeltas([
        { op: "create", kind: "memory", content: "c", evidence: "e" },
        { op: "delete", id: "h_x", reason: "r" },
      ]),
    ).toBeUndefined();
  });

  it("rejects non-arrays, wrong sizes, and unknown ops", () => {
    expect(validateDeltas("nope")).toMatch(/must be an array/);
    expect(validateDeltas([])).toMatch(/between 1 and 20/);
    expect(validateDeltas([{ op: "upsert", id: "h_x" }])).toMatch(/unknown op/);
  });

  it("rejects creates with a bad kind, missing text, or oversized fields", () => {
    expect(validateDeltas([{ op: "create", kind: "bogus", content: "c", evidence: "e" }])).toMatch(
      /unknown kind/,
    );
    expect(validateDeltas([{ op: "create", kind: "memory", content: "", evidence: "e" }])).toMatch(
      /content must not be empty/,
    );
    expect(
      validateDeltas([{ op: "create", kind: "memory", content: "c", evidence: "x".repeat(4001) }]),
    ).toMatch(/evidence exceeds maxLength/);
  });

  it("rejects updates with out-of-range importance or bad scope", () => {
    expect(validateDeltas([{ op: "update", id: "h_x", importance: 2 }])).toMatch(
      /importance must be a number in \[0,1\]/,
    );
    expect(validateDeltas([{ op: "update", id: "h_x", scope: "both" }])).toMatch(
      /scope must be global\|project/,
    );
  });
});

describe("session-scoped writes go through makePersist", () => {
  beforeEach(() => {
    reconstruct([]);
  });

  it("a /harness keep persists a harness-state entry with the canonical type", async () => {
    const { applyDeltas } = await import("../src/store.js");
    applyDeltas(
      [{ op: "create", kind: "memory", content: "note", evidence: "e", ownerModel: "test/main" }],
      () => {},
    );
    const id = getState().items[0]!.id;
    const { pi, ctx, entries } = makeFakePi([]);
    await runHarnessCommand(pi, `keep ${id}`, ctx() as never);
    const state = entries.filter((e) => e.customType === "harness-state");
    expect(state).toHaveLength(1);
    expect((state[0]!.data as { version?: number }).version).toBe(2); // create + keep
  });
});

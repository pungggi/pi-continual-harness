// Durable sync (issue #7): the opt-in autoImport bundle — session_start layered
// import + turn_end layered export. Paths are INJECTED here (temp dirs) so the
// tests never touch the real ~/.pi; the real-path composition (including the
// /harness export|import handlers) is covered by layers.test.ts under a fake
// HOME.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  applyDeltas,
  exportDurableLayers,
  getState,
  reconstruct,
} from "../src/store.js";
import { loadConfig, resetConfigCache, type HarnessConfig } from "../src/config.js";
import { registerAutoExport, registerImportReminder, resetDurableSync, syncDurableOnStart, evaluateImportReminder, getImportedThisSession, MAX_IMPORT_REMINDERS } from "../src/durable.js";
import { makeFakePi } from "./helpers.js";

let dir: string;
let paths: { globalPath: string; projectDir: string };

async function reset(): Promise<void> {
  reconstruct([]);
  resetDurableSync();
  resetConfigCache();
  await loadConfig(join(tmpdir(), `pi-ch-durable-no-config-${Date.now()}.json`));
}

function primeConfig(cfg: object): Promise<void> {
  const file = join(dir, "harness.json");
  writeFileSync(file, JSON.stringify(cfg), "utf8");
  resetConfigCache();
  return loadConfig(file).then(() => undefined);
}

function writeLayer(path: string, bullets: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    ["# Continual Harness State", "", "## Memory facts", "", ...bullets, ""].join("\n"),
    "utf8",
  );
}

beforeEach(async () => {
  await reset();
  dir = mkdtempSync(join(tmpdir(), "pi-ch-durable-"));
  paths = { globalPath: join(dir, "harness-state.md"), projectDir: join(dir, "harness-state") };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("syncDurableOnStart (session_start layered import)", () => {
  it("is a no-op when autoImport is off (default)", async () => {
    writeLayer(paths.globalPath, ["- **[h_x]** (importance 0.50) fact", "  - evidence: e"]);
    const { pi, ctx, notifications, entries } = makeFakePi([]);
    await syncDurableOnStart(pi, ctx() as unknown as ExtensionContext, [
      { path: paths.globalPath, defaultScope: { scope: "global" } },
    ]);
    expect(getState().items).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it("imports both layers (injected files) and persists a snapshot", async () => {
    await primeConfig({ autoImport: true });
    writeLayer(paths.globalPath, ["- **[h_g]** (importance 0.50) global fact", "  - evidence: e"]);
    writeLayer(join(paths.projectDir, "proj.md"), [
      "- **[h_p]** (importance 0.50) project fact",
      "  - evidence: e",
    ]);
    const { pi, ctx, notifications, entries } = makeFakePi([]);
    await syncDurableOnStart(pi, ctx() as unknown as ExtensionContext, [
      { path: paths.globalPath, defaultScope: { scope: "global" } },
      { path: join(paths.projectDir, "proj.md"), defaultScope: { scope: "project", project: "proj" } },
    ]);
    expect(getState().items).toHaveLength(2);
    const byId = new Map(getState().items.map((i) => [i.id, i]));
    expect(byId.get("h_g")!.scope).toBe("global");
    expect(byId.get("h_p")!.project).toBe("proj");
    expect(notifications.some((n) => /durable sync imported 2 item\(s\)/.test(n.msg))).toBe(true);
    expect(entries.some((e) => e.customType === "harness-state")).toBe(true);
  });

  it("stays quiet when the layers are already in sync (idempotent)", async () => {
    await primeConfig({ autoImport: true });
    writeLayer(paths.globalPath, ["- **[h_g]** (importance 0.50) global fact", "  - evidence: e"]);
    const { pi, ctx, notifications, entries } = makeFakePi([]);
    const files = [{ path: paths.globalPath, defaultScope: { scope: "global" as const } }];
    await syncDurableOnStart(pi, ctx() as unknown as ExtensionContext, files);
    const n = notifications.length;
    const e = entries.length;
    await syncDurableOnStart(pi, ctx() as unknown as ExtensionContext, files); // second run: nothing changed
    expect(notifications).toHaveLength(n);
    expect(entries).toHaveLength(e);
  });

  it("missing layers → quiet no-op", async () => {
    await primeConfig({ autoImport: true });
    const { pi, ctx, notifications } = makeFakePi([]);
    await syncDurableOnStart(pi, ctx() as unknown as ExtensionContext, [
      { path: join(dir, "absent.md"), defaultScope: { scope: "global" } },
    ]);
    expect(notifications).toHaveLength(0);
    expect(getState().items).toHaveLength(0);
  });
});

describe("registerAutoExport (turn_end layered export)", () => {
  it("exports when the store changed, then skips until it changes again", async () => {
    await primeConfig({ autoImport: true });
    // registerAutoExport directly with injected paths (continualHarness would
    // register a REAL-path copy — that composition is covered in layers.test.ts
    // under a fake HOME).
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    registerAutoExport(pi, paths);

    applyDeltas([{ op: "create", kind: "memory", content: "fact", evidence: "e" }], vi.fn());
    await fire("turn_end", { type: "turn_end", turnIndex: 0 }, ctx());
    expect(existsSync(paths.globalPath)).toBe(true);
    expect(readFileSync(paths.globalPath, "utf8")).toContain("fact");
    expect(notifications.some((n) => /durable state exported/.test(n.msg))).toBe(true);

    // no further mutation → no further export notification
    const before = notifications.length;
    await fire("turn_end", { type: "turn_end", turnIndex: 1 }, ctx());
    expect(notifications).toHaveLength(before);

    // another mutation → export again
    applyDeltas([{ op: "create", kind: "memory", content: "fact 2", evidence: "e" }], vi.fn());
    await fire("turn_end", { type: "turn_end", turnIndex: 2 }, ctx());
    expect(readFileSync(paths.globalPath, "utf8")).toContain("fact 2");
  });

  it("is inert when autoImport is off", async () => {
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    registerAutoExport(pi, paths);
    applyDeltas([{ op: "create", kind: "memory", content: "fact", evidence: "e" }], vi.fn());
    await fire("turn_end", { type: "turn_end", turnIndex: 0 }, ctx());
    expect(existsSync(paths.globalPath)).toBe(false);
    expect(notifications).toHaveLength(0);
  });

  it("a mutation after session resetDurableSync re-materializes on the next turn_end", async () => {
    await primeConfig({ autoImport: true });
    const { pi, ctx, fire } = makeFakePi([]);
    registerAutoExport(pi, paths);
    // session_start resets the baseline → the restored store is exported once
    resetDurableSync();
    await fire("turn_end", { type: "turn_end", turnIndex: 0 }, ctx());
    expect(existsSync(paths.globalPath)).toBe(true);
  });

  it("late enable: the first turn_end imports the layers BEFORE exporting (no clobber, review #26)", async () => {
    // The session started with autoImport OFF, so session_start skipped the
    // import — the durable layer holds a refinement this session never saw.
    writeLayer(paths.globalPath, ["- **[h_saved]** (importance 0.50) saved refinement", "  - evidence: e"]);
    await primeConfig({ autoImport: false });
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    registerAutoExport(pi, paths);
    // ...the user enables autoImport mid-session (wizard or hand-edit):
    await primeConfig({ autoImport: true });
    // a store mutation makes the auto-export trigger on the next turn_end
    applyDeltas([{ op: "create", kind: "memory", content: "session fact", evidence: "e" }], vi.fn());
    await fire("turn_end", { type: "turn_end", turnIndex: 0 }, ctx());
    // The durable layer was MERGED, not overwritten: both items survive.
    const layer = readFileSync(paths.globalPath, "utf8");
    expect(layer).toContain("saved refinement");
    expect(layer).toContain("session fact");
    // ...and the never-imported item IS in the live store now
    expect(getState().items.some((i) => i.id === "h_saved")).toBe(true);
    // the catch-up import announced itself (awareness, like session_start)
    expect(notifications.some((n) => /durable sync imported/.test(n.msg))).toBe(true);
  });

  it("late enable with a FAILING catch-up import: no export this turn (review #26)", async () => {
    await primeConfig({ autoImport: true });
    writeLayer(paths.globalPath, ["- **[h_g]** (importance 0.50) fact", "  - evidence: e"]);
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    // make the layered import itself fail: its persist callback (appendEntry)
    // throws — readFile errors are handled gracefully, so this is the
    // realistic failure surface (e.g. a session-mutation error mid-import).
    const raw = pi as unknown as { appendEntry: (t: string, d: unknown) => void };
    raw.appendEntry = () => {
      throw new Error("boom");
    };
    registerAutoExport(pi, paths);
    resetDurableSync(); // session never ran its start-sync (autoImport was off)
    applyDeltas([{ op: "create", kind: "memory", content: "session fact", evidence: "e" }], vi.fn());
    await fire("turn_end", { type: "turn_end", turnIndex: 0 }, ctx());
    expect(notifications.some((n) => /catch-up import failed/.test(n.msg))).toBe(true);
    // the layer was NOT exported over: original content intact, no additions
    const layer = readFileSync(paths.globalPath, "utf8");
    expect(layer).toContain("fact");
    expect(layer).not.toContain("session fact");
  });
  it("session-start notify lists WHAT was imported, not just counts", async () => {
    await primeConfig({ autoImport: true });
    writeLayer(paths.globalPath, [
      "- **[h_g]** (importance 0.50) global fact about deployments",
      "  - evidence: e",
    ]);
    const { pi, ctx, notifications } = makeFakePi([]);
    await syncDurableOnStart(pi, ctx() as unknown as ExtensionContext, [
      { path: paths.globalPath, defaultScope: { scope: "global" } },
    ]);
    const msg = notifications.map((n) => n.msg).join("\n");
    expect(msg).toContain("durable sync imported 1 item(s) (1 created");
    expect(msg).toContain("New instructions now active:");
    expect(msg).toContain("[h_g] (memory) global fact about deployments");
  });

  it("the imported batch is captured for reminders; reset clears it", async () => {
    await primeConfig({ autoImport: true });
    writeLayer(paths.globalPath, ["- **[h_g]** (importance 0.50) fact", "  - evidence: e"]);
    const { pi, ctx } = makeFakePi([]);
    await syncDurableOnStart(pi, ctx() as unknown as ExtensionContext, [
      { path: paths.globalPath, defaultScope: { scope: "global" } },
    ]);
    expect(getImportedThisSession().map((i) => i.id)).toEqual(["h_g"]);
    resetDurableSync();
    expect(getImportedThisSession()).toHaveLength(0);
  });

  it("evaluateImportReminder: gates, cadence, bounded repeats, bad turns inert", async () => {
    await reset();
    const on = { autoImport: true } as HarnessConfig;
    const step = (outcome?: string) => evaluateImportReminder(on, outcome, 2);
    // gates
    expect(evaluateImportReminder({ ...on, autoImport: false }, undefined, 3)).toBe(false);
    expect(evaluateImportReminder({ ...on, importRemind: { enabled: false } }, undefined, 3)).toBe(false);
    expect(evaluateImportReminder(on, undefined, 0)).toBe(false);
    expect(evaluateImportReminder(on, "aborted", 2)).toBe(false); // bad turn: no seed
    // cadence: seed (doesn't count), then fire every 25 completed turns
    expect(step()).toBe(false); // seed
    for (let i = 0; i < 24; i++) expect(step()).toBe(false);
    expect(step()).toBe(true); // reminder 1
    expect(step("error")).toBe(false); // skipped — window unchanged
    expect(step()).toBe(false); // 1st completed after
    for (let i = 0; i < 23; i++) expect(step()).toBe(false);
    expect(step()).toBe(true); // reminder 2
    for (let i = 0; i < 24; i++) expect(step()).toBe(false);
    expect(step()).toBe(true); // reminder 3
    // bounded: never more than MAX_IMPORT_REMINDERS per batch
    expect(step()).toBe(false);
    expect(step("aborted")).toBe(false); // inert either way now
    expect(MAX_IMPORT_REMINDERS).toBe(3);
  });

  it("counts completed turn_end events, not pi's per-run turnIndex (reset to 0 each agent_start, review #26)", async () => {
    await primeConfig({ autoImport: true });
    writeLayer(paths.globalPath, ["- **[h_g]** (importance 0.50) fact", "  - evidence: e"]);
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    await syncDurableOnStart(pi, ctx() as unknown as ExtensionContext, [
      { path: paths.globalPath, defaultScope: { scope: "global" } },
    ]);
    registerImportReminder(pi);
    // 26 separate prompts, each a fresh agent run → turnIndex resets to 0
    // every time. Absolute-index math would NEVER reach a 25-turn cadence;
    // completed-turn counting does (seed on the first, fire 25 later).
    for (let t = 0; t < 26; t++) {
      await fire("turn_end", { type: "turn_end", turnIndex: 0 }, ctx());
    }
    const reminders = notifications.filter((n) => /imported item\(s\) are active/.test(n.msg));
    expect(reminders).toHaveLength(1);
  });

  it("aborted/error turn_ends never advance the import-reminder cadence (#18 semantics)", async () => {
    await primeConfig({ autoImport: true });
    writeLayer(paths.globalPath, ["- **[h_g]** (importance 0.50) fact", "  - evidence: e"]);
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    await syncDurableOnStart(pi, ctx() as unknown as ExtensionContext, [
      { path: paths.globalPath, defaultScope: { scope: "global" } },
    ]);
    registerImportReminder(pi);
    // 30 bad turns (mixed aborted/error): had they counted, the window would
    // have fired twice over by now — they neither seed nor advance.
    for (let t = 0; t < 30; t++) {
      await fire("turn_end", { type: "turn_end", turnIndex: t, outcome: t % 2 ? "aborted" : "error" }, ctx());
    }
    // 25 completed turns: seed + 24 counted → still under 25
    for (let t = 0; t < 25; t++) {
      await fire("turn_end", { type: "turn_end", turnIndex: t }, ctx());
    }
    let reminders = notifications.filter((n) => /imported item\(s\) are active/.test(n.msg));
    expect(reminders).toHaveLength(0);
    // the 26th completed turn (25 counted) fires — exactly the cadence, nothing borrowed
    await fire("turn_end", { type: "turn_end", turnIndex: 0 }, ctx());
    reminders = notifications.filter((n) => /imported item\(s\) are active/.test(n.msg));
    expect(reminders).toHaveLength(1);
  });

  it("no import → no reminders, whatever the cadence", async () => {
    await primeConfig({ autoImport: true });
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    registerImportReminder(pi);
    for (let t = 0; t <= 30; t++) {
      await fire("turn_end", { type: "turn_end", turnIndex: t }, ctx());
    }
    expect(notifications.filter((n) => /imported item\(s\) are active/.test(n.msg))).toHaveLength(0);
  });

  it("reminders respect importRemind.enabled: false", async () => {
    await primeConfig({ autoImport: true, importRemind: { enabled: false } });
    writeLayer(paths.globalPath, ["- **[h_g]** (importance 0.50) fact", "  - evidence: e"]);
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    await syncDurableOnStart(pi, ctx() as unknown as ExtensionContext, [
      { path: paths.globalPath, defaultScope: { scope: "global" } },
    ]);
    registerImportReminder(pi);
    for (let t = 0; t <= 30; t++) {
      await fire("turn_end", { type: "turn_end", turnIndex: t }, ctx());
    }
    expect(notifications.filter((n) => /imported item\(s\) are active/.test(n.msg))).toHaveLength(0);
    // the session-start WHAT-listing still fires (awareness at import time)
    expect(notifications.some((n) => /New instructions now active/.test(n.msg))).toBe(true);
  });
});

describe("import awareness (what arrived + cadence reminder)", () => {
  it("an id present in both layers is listed once (review #28)", async () => {
    await primeConfig({ autoImport: true });
    writeLayer(paths.globalPath, ["- **[h_x]** (importance 0.50) fact", "  - evidence: e"]);
    writeLayer(join(paths.projectDir, "proj.md"), [
      "- **[h_x]** (importance 0.70) fact (updated by project)",
      "  - evidence: e2",
      "  - scope: project (proj)",
    ]);
    const { pi, ctx, notifications } = makeFakePi([]);
    await syncDurableOnStart(pi, ctx() as unknown as ExtensionContext, [
      { path: paths.globalPath, defaultScope: { scope: "global" } },
      { path: join(paths.projectDir, "proj.md"), defaultScope: { scope: "project", project: "proj" } },
    ]);
    const imported = getImportedThisSession();
    expect(imported).toHaveLength(1); // created by global + updated by project → ONE entry
    expect(imported[0]!.id).toBe("h_x");
    expect(imported[0]!.content).toContain("updated by project"); // post-merge content wins
    const listing = notifications.find((n) => /New instructions now active/.test(n.msg));
    expect(listing!.msg).toContain("durable sync imported 1 item(s)"); // distinct ids, not bullets
  });

  it("turn_end reminder fires on the cadence after an import, then stops at the cap", async () => {
    await primeConfig({ autoImport: true });
    writeLayer(paths.globalPath, ["- **[h_g]** (importance 0.50) fact", "  - evidence: e"]);
    const { pi, ctx, fire, notifications } = makeFakePi([]);
    await syncDurableOnStart(pi, ctx() as unknown as ExtensionContext, [
      { path: paths.globalPath, defaultScope: { scope: "global" } },
    ]);
    registerImportReminder(pi);
    for (let t = 0; t <= 100; t++) {
      // Synthetic events carry no outcome → treated as completed (0.14.0).
      await fire("turn_end", { type: "turn_end" }, ctx());
    }
    const reminders = notifications.filter((n) => /imported item\(s\) are active/.test(n.msg));
    expect(reminders).toHaveLength(3); // after 25, 50, 75 completed turns — capped after
    expect(reminders[0]!.msg).toContain("[h_g]");
    expect(reminders[0]!.msg).toContain("harness_list"); // truthful overflow pointer (review #28)
    // The advertised kill-switch must be paste-able JSON (review #28): the
    // object fragment parses, and the keys are double-quoted.
    expect(reminders[0]!.msg).toContain('"importRemind": { "enabled": false }');
    const snippet = reminders[0]!.msg.match(/\{[^{}]*"enabled"[^{}]*\}/)![0];
    expect(() => JSON.parse(snippet)).not.toThrow();
    expect(JSON.parse(snippet)).toEqual({ enabled: false });
  });

});

describe("exportDurableLayers slug handling", () => {
  it("writes the current project file under the injected dir", async () => {
    applyDeltas(
      [{ op: "create", kind: "memory", content: "p-fact", evidence: "e", scope: "project", project: "here" }],
      vi.fn(),
    );
    const written = await exportDurableLayers(paths, "here");
    expect(written).toContain(join(paths.projectDir, "here.md"));
    expect(readFileSync(join(paths.projectDir, "here.md"), "utf8")).toContain("p-fact");
  });
});

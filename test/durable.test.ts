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
import { loadConfig, resetConfigCache } from "../src/config.js";
import { registerAutoExport, resetDurableSync, syncDurableOnStart } from "../src/durable.js";
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

// /harness setup (issue #22) — presets as pure data, the reviewed write path
// (saveConfig), and the wizard handler. The preset tests deliberately assert
// against DEFAULT_CONFIG (not literals) so a default change — e.g. #19's
// importRemind — cannot silently drift from the wizard.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  loadConfig,
  readConfigRaw,
  resetConfigCache,
  saveConfig,
} from "../src/config.js";
import {
  expandPreset,
  formatConfig,
  getPath,
  handleSetup,
  planWrite,
  PRESETS,
  setPath,
} from "../src/setup.js";
import { makeFakePi } from "./helpers.js";

let dir: string;
let file: string;

beforeEach(async () => {
  resetConfigCache();
  dir = join(tmpdir(), `harness-setup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  file = join(dir, "harness.json");
});

async function cleanup(): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

describe("presets (pure data)", () => {
  it("expands known names and degrades unknown ones to undefined", () => {
    for (const name of ["quiet", "recommended", "power"] as const) {
      expect(expandPreset(name)?.name).toBe(name);
    }
    expect(expandPreset("nope")).toBeUndefined();
  });

  it("quiet pins every opt-in feature key to the shipped default", () => {
    const quiet = expandPreset("quiet")!;
    const paths = quiet.deltas.map((d) => d.path);
    expect(paths).toEqual(["autoImport", "importRemind", "remindRefine", "autoRefine", "outcomeImportance"]);
    for (const d of quiet.deltas) {
      expect(d.value).toEqual(getPath(DEFAULT_CONFIG, d.path));
    }
    // Nothing in quiet enables an autonomous switch.
    expect(getPath(planWrite(undefined, quiet.deltas), "autoImport")).toBe(false);
    expect(getPath(planWrite(undefined, quiet.deltas), "autoRefine.enabled")).toBe(false);
    expect(getPath(planWrite(undefined, quiet.deltas), "outcomeImportance.enabled")).toBe(false);
  });

  it("recommended = autoImport on (autonomous flag) + importRemind at the config-module default", () => {
    const rec = expandPreset("recommended")!;
    const auto = rec.deltas.find((d) => d.path === "autoImport")!;
    expect(auto.value).toBe(true);
    expect(auto.autonomous).toBe(true); // gets its own explicit confirm
    expect(auto.safety).toMatch(/autonomous/i);
    const remind = rec.deltas.find((d) => d.path === "importRemind")!;
    // Coordinated with #19: the value IS the loader's default, whatever it is.
    expect(remind.value).toEqual(DEFAULT_CONFIG.importRemind);
    expect(remind.autonomous).toBeFalsy();
  });

  it("power = recommended + autoRefine enabled (autonomous flag, default cadence)", () => {
    const power = expandPreset("power")!;
    const rec = expandPreset("recommended")!;
    for (const d of rec.deltas) {
      expect(power.deltas.some((p) => p.path === d.path && jsonEq(p.value, d.value))).toBe(true);
    }
    const refine = power.deltas.find((d) => d.path === "autoRefine")!;
    expect(refine.value).toEqual({ ...DEFAULT_CONFIG.autoRefine, enabled: true });
    expect(refine.autonomous).toBe(true);
    expect(refine.safety).toMatch(/mutate harness state on a cadence/i);
  });

  it("preset values never alias DEFAULT_CONFIG (inert snapshots)", () => {
    // structuredClone → different objects: mutating a preset value can never
    // reach the loader's defaults (and vice versa).
    const quiet = expandPreset("quiet")!;
    for (const d of quiet.deltas) {
      if (d.value !== null && typeof d.value === "object") {
        expect(d.value).not.toBe(getPath(DEFAULT_CONFIG, d.path));
      }
    }
    const power = expandPreset("power")!;
    expect(power.deltas.find((d) => d.path === "autoRefine")!.value).not.toBe(DEFAULT_CONFIG.autoRefine);
  });
});

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

describe("setPath / getPath", () => {
  it("sets top-level and dotted paths, creating intermediates", () => {
    const out = setPath({}, "importRemind.enabled", false);
    expect(out).toEqual({ importRemind: { enabled: false } });
    const out2 = setPath({ autoRefine: { commit: true } }, "autoRefine.enabled", true);
    expect(out2).toEqual({ autoRefine: { commit: true, enabled: true } });
  });

  it("never mutates the input object", () => {
    const input = { autoRefine: { commit: true } };
    setPath(input, "autoRefine.enabled", true);
    expect(input).toEqual({ autoRefine: { commit: true } });
  });

  it("getPath reads dotted paths and returns undefined for absent ones", () => {
    expect(getPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(getPath({ a: { b: 1 } }, "a.c")).toBeUndefined();
    expect(getPath(undefined, "a")).toBeUndefined();
    expect(getPath({ a: 1 }, "a.b")).toBeUndefined();
  });
});

describe("planWrite", () => {
  it("applies accepted deltas over the raw file and preserves unknown keys", () => {
    const rec = expandPreset("recommended")!;
    const planned = planWrite({ futureKey: 42, autoImport: false }, rec.deltas);
    expect(planned.futureKey).toBe(42);
    expect(planned.autoImport).toBe(true);
    expect(planned.importRemind).toEqual(DEFAULT_CONFIG.importRemind);
  });

  it("skips declined deltas", () => {
    const power = expandPreset("power")!;
    const planned = planWrite(undefined, power.deltas, new Set(["autoImport"]));
    expect(planned.autoImport).toBeUndefined();
    expect(getPath(planned, "autoRefine.enabled")).toBe(true);
  });
});

describe("saveConfig (backup + atomic write + reload)", () => {
  it("creates a new file when none exists (no backup) and round-trips through the loader", async () => {
    try {
      const res = await saveConfig({ autoImport: true }, file);
      expect(res.backup).toBeUndefined();
      const onDisk = JSON.parse(await readFile(file, "utf8"));
      expect(onDisk.autoImport).toBe(true);
      // effective is what pi will read: reloaded through coercion, not echoed.
      resetConfigCache();
      expect(await loadConfig(file)).toEqual(res.effective);
      expect(res.effective.autoImport).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("backs up the previous file (original bytes) before replacing it", async () => {
    try {
      await writeFile(file, JSON.stringify({ remindRefine: { enabled: true } }), "utf8");
      const res = await saveConfig({ autoImport: true }, file);
      expect(res.backup).toBeDefined();
      expect(res.backup).toMatch(/harness\.json\.bak-\d{4}-\d{2}-\d{2}T/);
      expect(await readFile(res.backup!, "utf8")).toBe(JSON.stringify({ remindRefine: { enabled: true } }));
      // merged keeps the previous setting + adds the new one
      expect(res.merged).toEqual({ remindRefine: { enabled: true }, autoImport: true });
      expect(res.effective.remindRefine?.enabled).toBe(true);
      expect(res.effective.autoImport).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("deep-merges nested blocks so sibling keys survive a preset write", async () => {
    try {
      await writeFile(file, JSON.stringify({ autoRefine: { commit: true } }), "utf8");
      const res = await saveConfig({ autoRefine: { enabled: true } }, file);
      expect(res.merged.autoRefine).toEqual({ commit: true, enabled: true });
    } finally {
      await cleanup();
    }
  });

  it("preserves unknown keys for future versions (loader ignores them, writer must not drop them)", async () => {
    try {
      await writeFile(file, JSON.stringify({ fromTheFuture: { deep: [1, 2] } }), "utf8");
      const res = await saveConfig({ autoImport: true }, file);
      expect(res.merged.fromTheFuture).toEqual({ deep: [1, 2] });
    } finally {
      await cleanup();
    }
  });

  it("backs up even a malformed previous file, then writes a clean replacement", async () => {
    try {
      await writeFile(file, "{not valid json", "utf8");
      const res = await saveConfig({ autoImport: true }, file);
      expect(res.backup).toBeDefined();
      expect(await readFile(res.backup!, "utf8")).toBe("{not valid json");
      resetConfigCache();
      expect(await loadConfig(file)).toEqual(res.effective);
      expect(res.effective.autoImport).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("leaves no .tmp litter behind", async () => {
    try {
      await saveConfig({ autoImport: true }, file);
      const litter = (await readdir(dir)).filter((f) => f.includes(".tmp"));
      expect(litter).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe("handleSetup (wizard flow)", () => {
  function wizard() {
    const fake = makeFakePi([]);
    return { fake, ctx: fake.ctx() as unknown as ExtensionCommandContext };
  }

  it("rejects an unknown preset with a warning and no write", async () => {
    try {
      const { fake, ctx } = wizard();
      await handleSetup(ctx, ["--preset", "bogus"], file);
      expect(fake.notifications.some((n) => n.level === "warning" && /Unknown preset/.test(n.msg))).toBe(true);
      await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanup();
    }
  });

  it("rejects --preset without a value", async () => {
    try {
      const { fake, ctx } = wizard();
      await handleSetup(ctx, ["--preset"], file);
      expect(fake.notifications.some((n) => n.level === "warning" && /needs a value/.test(n.msg))).toBe(true);
      await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanup();
    }
  });

  it("--preset X --yes writes without prompts (scripted consent)", async () => {
    try {
      const { fake, ctx } = wizard();
      await handleSetup(ctx, ["--preset", "recommended", "--yes"], file);
      expect(fake.selects).toEqual([]); // never prompted
      const raw = await readConfigRaw(file);
      expect(raw?.autoImport).toBe(true);
      expect(raw?.importRemind).toEqual(DEFAULT_CONFIG.importRemind);
      const done = fake.notifications.at(-1)!;
      expect(done.level).toBe("info");
      expect(done.msg).toMatch(/Wrote .+harness\.json/);
      expect(done.msg).toMatch(/autoImport: true/); // effective config echoed
    } finally {
      await cleanup();
    }
  });

  it("interactive: declining the autonomous autoImport still writes the rest", async () => {
    try {
      const { fake, ctx } = wizard();
      fake.confirms.push(false, true, true); // autoImport declined, importRemind accepted, write accepted
      await handleSetup(ctx, ["--preset", "recommended"], file);
      const raw = await readConfigRaw(file);
      expect(raw?.autoImport).toBeUndefined(); // declined → not written
      expect(raw?.importRemind).toEqual(DEFAULT_CONFIG.importRemind);
      expect(fake.notifications.some((n) => /skipped — declined/.test(n.msg))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("interactive: declining the final write leaves the file untouched", async () => {
    try {
      const { fake, ctx } = wizard();
      await writeFile(file, JSON.stringify({ autoImport: false }), "utf8");
      fake.confirms.push(true, false); // autoImport accepted, final write declined (importRemind already default → no prompt)
      await handleSetup(ctx, ["--preset", "recommended"], file);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ autoImport: false });
      expect(fake.notifications.some((n) => /Declined — nothing written/.test(n.msg))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("interactive: cancelling the preset menu writes nothing", async () => {
    try {
      const { fake, ctx } = wizard();
      fake.selects.push(undefined); // dismissed
      await handleSetup(ctx, [], file);
      await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await cleanup();
    }
  });

  it("interactive: menu choice drives the wizard (power enables autoRefine)", async () => {
    try {
      const { fake, ctx } = wizard();
      fake.selects.push("power");
      fake.confirms.push(true, true, true, true); // autoImport, importRemind, autoRefine (autonomous), write
      await handleSetup(ctx, [], file);
      const raw = await readConfigRaw(file);
      expect(getPath(raw, "autoRefine.enabled")).toBe(true);
      expect(raw?.autoImport).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("a delta already effective is not re-confirmed", async () => {
    try {
      const { fake, ctx } = wizard();
      await writeFile(file, JSON.stringify({ autoImport: true }), "utf8");
      resetConfigCache();
      await loadConfig(file); // cache the current state the wizard will see
      fake.confirms.push(true); // only the write confirm — both deltas are already effective
      await handleSetup(ctx, ["--preset", "recommended"], file);
      expect(fake.confirms).toEqual([]); // consumed exactly, none left over
      const raw = await readConfigRaw(file);
      expect(raw?.importRemind).toEqual(DEFAULT_CONFIG.importRemind);
    } finally {
      await cleanup();
    }
  });

  it("shows the effective config and the durable-layer paths up front", async () => {
    try {
      const { fake, ctx } = wizard();
      await handleSetup(ctx, ["--preset", "quiet", "--yes"], file);
      const first = fake.notifications[0]!;
      expect(first.msg).toContain(file);
      expect(first.msg).toContain("harness-state.md"); // global layer path
      expect(first.msg).toContain("Current effective config");
      expect(first.msg).toContain(`autoImport: false`);
    } finally {
      await cleanup();
    }
  });
});

describe("formatConfig", () => {
  it("renders one line per top-level key from the loader's own values", () => {
    const lines = formatConfig(DEFAULT_CONFIG);
    expect(lines.some((l) => l.startsWith("autoImport: false"))).toBe(true);
    expect(lines).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
  });
});

// Keep the preset objects exercised via PRESETS too (name-keyed registry).
describe("PRESETS registry", () => {
  it("is keyed by name and covers exactly the three shipped presets", () => {
    expect(Object.keys(PRESETS)).toEqual(["quiet", "recommended", "power"]);
    for (const p of Object.values(PRESETS)) {
      expect(p.title).toMatch(/\S/);
      expect(p.description).toMatch(/\S/);
      expect(p.deltas.length).toBeGreaterThan(0);
      for (const d of p.deltas) expect(d.rationale).toMatch(/\S/);
    }
  });
});

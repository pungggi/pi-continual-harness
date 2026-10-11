import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_REF_BUMP,
  defaultScopeForPath,
  layerFilesFor,
  loadConfig,
  projectDurablePath,
  projectSlug,
  resetConfigCache,
} from "../src/config.js";
import { DEFAULT_INJECTION } from "../src/select.js";
import { DEFAULT_DURABLE_PATH, PROJECT_DURABLE_DIR } from "../src/store.js";

function tempFile(): string {
  return join(tmpdir(), `harness-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

async function withTempDir<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = join(tmpdir(), `harness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "harness.json");
  try {
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("config", () => {
  beforeEach(resetConfigCache);

  describe("loadConfig", () => {
    it("returns defaults when the file is missing", async () => {
      const cfg = await loadConfig(tempFile());
      expect(cfg).toEqual(DEFAULT_CONFIG);
    });

    it("merges a partial file over defaults (auto-import on, reminder on)", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ autoImport: true, remindRefine: { enabled: true } }), "utf8");
        const cfg = await loadConfig(file);
        expect(cfg.autoImport).toBe(true);
        expect(cfg.remindRefine?.enabled).toBe(true);
        expect(cfg.remindRefine?.everyTurns).toBe(25); // default retained (issue #19)
      });
    });

    it("falls back to defaults on malformed JSON", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, "{not valid json", "utf8");
        const cfg = await loadConfig(file);
        expect(cfg).toEqual(DEFAULT_CONFIG);
      });
    });

    it("ignores unknown keys — including the removed pre-0.9.0 durableScope", async () => {
      await withTempDir(async (file) => {
        await writeFile(
          file,
          JSON.stringify({ durableScope: "bogus", unknownKey: 1, remindRefine: { everyTurns: 10 } }),
          "utf8",
        );
        const cfg = await loadConfig(file);
        // The key is gone from the config type entirely (removed, not defaulted).
        expect((cfg as Record<string, unknown>).durableScope).toBeUndefined();
        expect(cfg.remindRefine?.everyTurns).toBe(10);
        expect(cfg.remindRefine?.enabled).toBe(true); // on by default (issue #19)
      });
    });

    it("rejects a non-numeric outcomeImportance.bump → default (prevents NaN corruption)", async () => {
      // A non-numeric bump must not leak through: it is an arithmetic operand
      // (importance + bump) and a string would corrupt importance to NaN.
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ outcomeImportance: { enabled: true, bump: "0.1" } }), "utf8");
        const cfg = await loadConfig(file);
        expect(cfg.outcomeImportance?.enabled).toBe(true);
        expect(cfg.outcomeImportance?.bump).toBe(DEFAULT_REF_BUMP); // string rejected → default
      });
    });

    it("passes a valid numeric outcomeImportance.bump through", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ outcomeImportance: { bump: 0.2 } }), "utf8");
        const cfg = await loadConfig(file);
        expect(cfg.outcomeImportance?.bump).toBe(0.2);
      });
    });

    it("rejects NaN outcomeImportance.bump → default", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ outcomeImportance: { bump: NaN } }), "utf8");
        const cfg = await loadConfig(file);
        expect(cfg.outcomeImportance?.bump).toBe(DEFAULT_REF_BUMP);
      });
    });
  });

  describe("injection (selection policy, on by default)", () => {
    it("DEFAULT_CONFIG ships injection ON with conservative defaults", () => {
      expect(DEFAULT_CONFIG.injection).toEqual(DEFAULT_INJECTION);
      expect(DEFAULT_CONFIG.injection?.enabled).toBe(true);
    });

    it("a missing file yields the resolved injection defaults", async () => {
      const cfg = await loadConfig(tempFile());
      expect(cfg.injection).toEqual(DEFAULT_INJECTION);
    });

    it("merges a partial injection over the defaults", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ injection: { maxTokens: 500 } }), "utf8");
        const cfg = await loadConfig(file);
        expect(cfg.injection).toEqual({
          enabled: true, // default retained
          maxTokens: 500, // overridden
          maxPerKind: 10, // default retained
          charsPerToken: 4, // default retained
        });
      });
    });

    it("honors the opt-out (enabled: false)", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ injection: { enabled: false } }), "utf8");
        const cfg = await loadConfig(file);
        expect(cfg.injection?.enabled).toBe(false);
      });
    });

    it("coerces bad injection numbers back to defaults (no NaN sizing)", async () => {
      await withTempDir(async (file) => {
        await writeFile(
          file,
          JSON.stringify({ injection: { maxTokens: "huge", maxPerKind: 0, charsPerToken: -1 } }),
          "utf8",
        );
        const cfg = await loadConfig(file);
        expect(cfg.injection).toEqual(DEFAULT_INJECTION);
      });
    });
  });

  describe("dedupe (merge policy, 0.10.0)", () => {
    it("DEFAULT_CONFIG ships merge ON at the historical 0.6 threshold", () => {
      expect(DEFAULT_CONFIG.dedupe).toEqual({ threshold: 0.6, merge: true });
    });

    it("a missing file yields the resolved dedupe defaults", async () => {
      const cfg = await loadConfig(tempFile());
      expect(cfg.dedupe).toEqual({ threshold: 0.6, merge: true });
    });

    it("merges a partial dedupe over the defaults (threshold only)", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ dedupe: { threshold: 0.75 } }), "utf8");
        const cfg = await loadConfig(file);
        expect(cfg.dedupe).toEqual({ threshold: 0.75, merge: true }); // merge default retained
      });
    });

    it("honors the delete-only opt-out (merge: false)", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ dedupe: { merge: false } }), "utf8");
        const cfg = await loadConfig(file);
        expect(cfg.dedupe).toEqual({ threshold: 0.6, merge: false });
      });
    });

    it("coerces bad thresholds back to 0.6 (comparison operand — no silent match-all/none)", async () => {
      // 0 would match everything, >1 nothing, strings/NaN corrupt the compare.
      for (const bad of [0, -0.5, 1.5, "0.7", NaN]) {
        await withTempDir(async (file) => {
          await writeFile(file, JSON.stringify({ dedupe: { threshold: bad } }), "utf8");
          const cfg = await loadConfig(file);
          expect(cfg.dedupe?.threshold).toBe(0.6);
        });
      }
    });

    it("accepts thresholds in (0,1] including 1 (identical token sets only)", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ dedupe: { threshold: 1 } }), "utf8");
        expect((await loadConfig(file)).dedupe?.threshold).toBe(1);
        resetConfigCache();
        await writeFile(file, JSON.stringify({ dedupe: { threshold: 0.05 } }), "utf8");
        expect((await loadConfig(file)).dedupe?.threshold).toBe(0.05);
      });
    });
  });

  describe("projectSlug", () => {
    it("sanitizes a Windows absolute path", () => {
      const s = projectSlug("C:\\Users\\Alessandro\\source\\pi\\packages\\pi-continual-harness");
      expect(s).toMatch(/^[a-z0-9-]+$/);
      expect(s).toContain("pi-continual-harness");
      expect(s).not.toContain(":");
    });

    it("sanitizes a POSIX path", () => {
      expect(projectSlug("/home/me/proj")).toBe("home-me-proj");
    });

    it("falls back to 'default' for empty / whitespace / undefined", () => {
      expect(projectSlug("")).toBe("default");
      expect(projectSlug("   ")).toBe("default");
      expect(projectSlug(undefined)).toBe("default");
      expect(projectSlug("/")).toBe("default");
    });
  });

  describe("importRemind (awareness reminders)", () => {
    it("defaults: enabled, every 25 turns", async () => {
      expect(DEFAULT_CONFIG.importRemind).toEqual({ enabled: true, everyTurns: 25 });
      expect((await loadConfig(tempFile())).importRemind).toEqual({ enabled: true, everyTurns: 25 });
    });

    it("honors explicit disable and custom cadence", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ autoImport: true, importRemind: { enabled: false, everyTurns: 10 } }), "utf8");
        const cfg = await loadConfig(file);
        expect(cfg.importRemind).toEqual({ enabled: false, everyTurns: 10 });
      });
    });

    it("coerces non-integer / sub-1 cadences to the default (spam guard)", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ importRemind: { everyTurns: 0 } }), "utf8");
        expect((await loadConfig(file)).importRemind?.everyTurns).toBe(25);
        resetConfigCache();
        await writeFile(file, JSON.stringify({ importRemind: { everyTurns: 2.5 } }), "utf8");
        expect((await loadConfig(file)).importRemind?.everyTurns).toBe(25);
      });
    });
  });

  describe("remindRefine (activation nudge, issue #19)", () => {
    it("defaults: on, every 25 turns, detail every 4th reminder", async () => {
      expect(DEFAULT_CONFIG.remindRefine).toEqual({ enabled: true, everyTurns: 25, detailEvery: 4 });
      expect((await loadConfig(tempFile())).remindRefine).toEqual({
        enabled: true,
        everyTurns: 25,
        detailEvery: 4,
      });
    });

    it("overridable in both directions: explicit disable keeps custom cadences", async () => {
      await withTempDir(async (file) => {
        await writeFile(
          file,
          JSON.stringify({ remindRefine: { enabled: false, everyTurns: 10, detailEvery: 2 } }),
          "utf8",
        );
        const cfg = await loadConfig(file);
        expect(cfg.remindRefine).toEqual({ enabled: false, everyTurns: 10, detailEvery: 2 });
      });
    });

    it("coerces non-integer / sub-1 cadences to the defaults (spam guard)", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ remindRefine: { everyTurns: 0, detailEvery: 0 } }), "utf8");
        const cfg = await loadConfig(file);
        expect(cfg.remindRefine?.everyTurns).toBe(25);
        expect(cfg.remindRefine?.detailEvery).toBe(4);
        resetConfigCache();
        await writeFile(file, JSON.stringify({ remindRefine: { everyTurns: 2.5, detailEvery: 1.5 } }), "utf8");
        const cfg2 = await loadConfig(file);
        expect(cfg2.remindRefine?.everyTurns).toBe(25);
        expect(cfg2.remindRefine?.detailEvery).toBe(4);
      });
    });

    it("detailEvery: 1 is valid (every reminder detailed)", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ remindRefine: { detailEvery: 1 } }), "utf8");
        expect((await loadConfig(file)).remindRefine?.detailEvery).toBe(1);
      });
    });
  });

  describe("autoImport (durable sync, issue #7)", () => {
    it("defaults to false", async () => {
      expect(DEFAULT_CONFIG.autoImport).toBe(false);
      expect((await loadConfig(tempFile())).autoImport).toBe(false);
    });

    it("merges an explicit opt-in; garbage stays off", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ autoImport: true }), "utf8");
        expect((await loadConfig(file)).autoImport).toBe(true);
        resetConfigCache();
        await writeFile(file, JSON.stringify({ autoImport: "yes" }), "utf8");
        expect((await loadConfig(file)).autoImport).toBe(false);
      });
    });
  });

  describe("layer paths", () => {
    it("projectDurablePath derives the slug file under PROJECT_DURABLE_DIR", () => {
      expect(projectDurablePath("/home/me/proj")).toBe(
        join(PROJECT_DURABLE_DIR, "home-me-proj.md"),
      );
    });

    it("layerFilesFor orders global first, project second (project wins collisions)", () => {
      const files = layerFilesFor("/home/me/proj");
      expect(files).toHaveLength(2);
      expect(files[0]).toEqual({ path: DEFAULT_DURABLE_PATH, defaultScope: { scope: "global" } });
      expect(files[1]).toEqual({
        path: join(PROJECT_DURABLE_DIR, "home-me-proj.md"),
        defaultScope: { scope: "project", project: "home-me-proj" },
      });
    });

    it("defaultScopeForPath maps the global file, project files, and other paths", () => {
      expect(defaultScopeForPath(DEFAULT_DURABLE_PATH)).toEqual({ scope: "global" });
      expect(defaultScopeForPath(join(PROJECT_DURABLE_DIR, "my-proj.md"))).toEqual({
        scope: "project",
        project: "my-proj",
      });
      expect(defaultScopeForPath(join(tmpdir(), "unrelated.md"))).toEqual({ scope: "global" });
    });
  });
});

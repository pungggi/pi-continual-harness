import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_REF_BUMP,
  loadConfig,
  projectSlug,
  resetConfigCache,
  resolveDurablePath,
} from "../src/config.js";
import { DEFAULT_INJECTION } from "../src/select.js";
import { DEFAULT_DURABLE_PATH } from "../src/store.js";

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

    it("merges a partial file over defaults (project scope, reminder on)", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ durableScope: "project", remindRefine: { enabled: true } }), "utf8");
        const cfg = await loadConfig(file);
        expect(cfg.durableScope).toBe("project");
        expect(cfg.remindRefine?.enabled).toBe(true);
        expect(cfg.remindRefine?.everyTurns).toBe(50); // default retained
      });
    });

    it("falls back to defaults on malformed JSON", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, "{not valid json", "utf8");
        const cfg = await loadConfig(file);
        expect(cfg).toEqual(DEFAULT_CONFIG);
      });
    });

    it("ignores unknown keys and bad durableScope values", async () => {
      await withTempDir(async (file) => {
        await writeFile(
          file,
          JSON.stringify({ durableScope: "bogus", unknownKey: 1, remindRefine: { everyTurns: 10 } }),
          "utf8",
        );
        const cfg = await loadConfig(file);
        expect(cfg.durableScope).toBe("global"); // unknown durableScope → default
        expect(cfg.remindRefine?.everyTurns).toBe(10);
        expect(cfg.remindRefine?.enabled).toBe(false);
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

  describe("resolveDurablePath", () => {
    it("global scope returns the shared DEFAULT_DURABLE_PATH", () => {
      expect(resolveDurablePath({ durableScope: "global" }, "/anywhere")).toBe(DEFAULT_DURABLE_PATH);
    });

    it("undefined scope defaults to global", () => {
      expect(resolveDurablePath({}, "/anywhere")).toBe(DEFAULT_DURABLE_PATH);
    });

    it("project scope returns a per-project file under .pi/agent/harness-state/", () => {
      const p = resolveDurablePath({ durableScope: "project" }, "/home/me/proj");
      expect(p).toBe(join(homedir(), ".pi", "agent", "harness-state", "home-me-proj.md"));
    });
  });
});

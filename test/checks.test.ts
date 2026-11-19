// Deterministic checks — plan/runner/support integration (checks.ts) plus the
// store-side recordCheckResults and the trial-decay exemption a pass earns.
// runOneCheck exercises REAL subprocesses (node -e) so the timeout and exit
// code paths are behaviorally true, not mocked.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoRunnable,
  planCheckRun,
  runOneCheck,
  runChecks,
  summarizeChecks,
  handleRefineChecks,
} from "../src/checks.js";
import { applyDeltas, getState, recordCheckResults, reconstruct } from "../src/store.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { hasPositiveSupport, isOnTrial } from "../src/decay.js";
import type { HarnessItem } from "../src/types.js";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runHarnessCheck } from "../src/checks.js";

const cwd = mkdtempSync(join(tmpdir(), "pi-ch-checks-"));

function item(over: Partial<HarnessItem> & Pick<HarnessItem, "id" | "content">): HarnessItem {
  return {
    kind: "memory",
    evidence: "e",
    importance: 0.5,
    active: true,
    ownerModel: "test/model",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...over,
  };
}

function reset(): void {
  reconstruct([]);
}

describe("autoRunnable (trust gate)", () => {
  it("runs only active, check-carrying, TRUSTED items", () => {
    expect(autoRunnable(item({ id: "h_a", content: "a", check: "npm test" }))).toBe(true);
    expect(
      autoRunnable(item({ id: "h_b", content: "b", check: "npm test", provenance: "agent" })),
    ).toBe(false);
    expect(autoRunnable(item({ id: "h_c", content: "c" }))).toBe(false);
    expect(autoRunnable(item({ id: "h_d", content: "d", check: "npm test", active: false }))).toBe(
      false,
    );
  });
});

describe("planCheckRun", () => {
  const a = item({ id: "h_a", content: "a", check: "true" });
  const b = item({ id: "h_b", content: "b", check: "true", support: { lastCheckAt: 500 } });
  const c = item({ id: "h_c", content: "c", check: "true", support: { lastCheckAt: 100 } });
  const agent = item({ id: "h_x", content: "x", check: "true", provenance: "agent" });

  it("never-checked first, then oldest lastCheckAt; agent items excluded", () => {
    expect(planCheckRun([b, agent, c, a], 10).map((i) => i.id)).toEqual(["h_a", "h_c", "h_b"]);
  });

  it("caps at maxPerRun", () => {
    expect(planCheckRun([a, b, c], 2)).toHaveLength(2);
    expect(planCheckRun([a, b, c], 0)).toEqual([]);
  });
});

describe("runOneCheck (real subprocesses)", () => {
  it("exit 0 → ok", async () => {
    const r = await runOneCheck('node -e "process.exit(0)"', cwd, 5000);
    expect(r.ok).toBe(true);
  });

  it("non-zero exit → not ok, with a detail tail", async () => {
    const r = await runOneCheck('node -e "process.stderr.write(\'boom\'); process.exit(3)"', cwd, 5000);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("boom");
  });

  it("a hung command is killed by the timeout → not ok", async () => {
    const r = await runOneCheck('node -e "setTimeout(() => {}, 30000)"', cwd, 1000);
    expect(r.ok).toBe(false);
    expect(r.durationMs).toBeLessThan(5000);
  }, 15000);
});

describe("runChecks + recordCheckResults (store integration)", () => {
  beforeEach(reset);

  it("records pass/fail as support counters in one persist", async () => {
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "ok note", evidence: "e", check: 'node -e "process.exit(0)"' },
        { op: "create", kind: "memory", content: "bad note", evidence: "e", check: 'node -e "process.exit(1)"' },
      ],
      vi.fn(),
    );
    const [okItem, badItem] = getState().items;
    const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const results = await runChecks(pi, cwd, [okItem!, badItem!], 5000);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(getState().items[0]!.support).toMatchObject({ passes: 1, lastCheckOk: true });
    expect(getState().items[1]!.support).toMatchObject({ fails: 1, lastCheckOk: false });
    // One persist for the whole batch.
    expect(pi.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("recordCheckResults skips vanished ids and persists nothing on no-op", () => {
    const persist = vi.fn();
    expect(recordCheckResults([{ id: "h_gone", ok: true }], persist)).toBe(0);
    expect(persist).not.toHaveBeenCalled();
  });

  it("a passing check is EARNED support: the item leaves the trial queue", () => {
    const i = item({ id: "h_t", content: "t", provenance: "agent", support: { passes: 1 } });
    expect(hasPositiveSupport(i)).toBe(true);
    expect(isOnTrial(i)).toBe(false);
  });
});

describe("summarizeChecks", () => {
  it("is undefined for an empty run, and names failures otherwise", () => {
    expect(summarizeChecks([])).toBeUndefined();
    const s = summarizeChecks([
      { id: "h_a", ok: true, durationMs: 5 },
      { id: "h_b", ok: false, detail: "exit 1", durationMs: 5 },
    ])!;
    expect(s).toContain("1 passed");
    expect(s).toContain("1 failed");
    expect(s).toContain("[h_b]");
    expect(s).toContain("exit 1");
  });
});

describe("handleRefineChecks (config gate)", () => {
  beforeEach(() => {
    reset();
    resetConfigCache();
  });

  function makeCtx(notify = vi.fn()): ExtensionContext {
    return { ui: { notify }, cwd } as unknown as ExtensionContext;
  }

  it("is a no-op while checks.enabled is false (default)", async () => {
    const cfgFile = join(cwd, "off-harness.json");
    writeFileSync(cfgFile, JSON.stringify({}), "utf8");
    await loadConfig(cfgFile);
    applyDeltas(
      [{ op: "create", kind: "memory", content: "note", evidence: "e", check: "node -e 0" }],
      vi.fn(),
    );
    const notify = vi.fn();
    const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const results = await handleRefineChecks(pi, makeCtx(notify));
    expect(results).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(getState().items[0]!.support).toBeUndefined();
  });

  it("runs due trusted checks when enabled and records support", async () => {
    const cfgFile = join(cwd, "on-harness.json");
    writeFileSync(cfgFile, JSON.stringify({ checks: { enabled: true } }), "utf8");
    await loadConfig(cfgFile); // populate the in-process cache (deterministic)
    applyDeltas(
      [
        {
          op: "create",
          kind: "memory",
          content: "note",
          evidence: "e",
          check: 'node -e "process.exit(0)"',
        },
      ],
      vi.fn(),
    );
    const notify = vi.fn();
    const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    const results = await handleRefineChecks(pi, makeCtx(notify));
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(getState().items[0]!.support?.passes).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    resetConfigCache();
  });
});

describe("runHarnessCheck (/harness check — the explicit runner)", () => {
  beforeEach(() => {
    reset();
    resetConfigCache();
  });

  function makeCmdCtx(notify = vi.fn()): ExtensionCommandContext {
    return { ui: { notify }, cwd } as unknown as ExtensionCommandContext;
  }

  it("guides when nothing carries a check", async () => {
    const notify = vi.fn();
    const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    await runHarnessCheck(pi, makeCmdCtx(notify), []);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]![0])).toContain("No items carry a check");
  });

  it("runs the named item regardless of provenance (explicit human action)", async () => {
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "agent note", evidence: "e", check: 'node -e "process.exit(0)"' },
      ],
      vi.fn(),
      undefined,
      { authoredBy: "agent" },
    );
    const item = getState().items[0]!;
    expect(item.provenance).toBe("agent");
    const notify = vi.fn();
    const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    await runHarnessCheck(pi, makeCmdCtx(notify), [item.id]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]![0])).toContain(`[${item.id}] ok`);
    expect(item.support?.passes).toBe(1);
  });

  it("warns on an unknown id and on an item without a check", async () => {
    applyDeltas([{ op: "create", kind: "memory", content: "plain", evidence: "e" }], vi.fn());
    const notify = vi.fn();
    const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    await runHarnessCheck(pi, makeCmdCtx(notify), ["h_missing"]);
    expect(String(notify.mock.calls[0]![0])).toContain("no item with id h_missing");
    const real = getState().items[0]!;
    notify.mockClear();
    await runHarnessCheck(pi, makeCmdCtx(notify), [real.id]);
    expect(String(notify.mock.calls[0]![0])).toContain("carries no check");
  });

  it("runs every check-carrying item when no id is given", async () => {
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "a", evidence: "e", check: 'node -e "process.exit(0)"' },
        { op: "create", kind: "memory", content: "b", evidence: "e", check: 'node -e "process.exit(2)"' },
      ],
      vi.fn(),
    );
    const notify = vi.fn();
    const pi = { appendEntry: vi.fn() } as unknown as ExtensionAPI;
    await runHarnessCheck(pi, makeCmdCtx(notify), []);
    expect(String(notify.mock.calls[0]![0])).toContain("2 command(s)");
    expect(String(notify.mock.calls[0]![0])).toContain("FAILED");
    expect(getState().items[1]!.support?.fails).toBe(1);
  });
});

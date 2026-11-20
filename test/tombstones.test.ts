// Tombstones — the recreate detector's memory (durable sidecar). Pure logic
// (record/merge/match/prune/parse) plus the sidecar round-trip against a
// tmp path. The global setup (test/setup.ts) already redirects the default
// path away from the real home dir; these tests pass explicit paths anyway.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectRecreate,
  flushTombstones,
  listTombstones,
  loadTombstones,
  parseTombstones,
  pruneTombstones,
  recordRemoval,
  resetTombstones,
  TOMBSTONE_MAX_AGE_DAYS,
  TOMBSTONE_MAX_ENTRIES,
  type Tombstone,
} from "../src/tombstones.js";

const DAY = 86_400_000;

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-ch-tomb-")), "tombstones.json");
}

describe("pruneTombstones", () => {
  it("drops entries older than the age window and keeps the rest", () => {
    const now = Date.now();
    const list: Tombstone[] = [
      {
        kind: "memory",
        content: "old",
        recreates: 1,
        deletedAt: now - (TOMBSTONE_MAX_AGE_DAYS + 1) * DAY,
      },
      { kind: "memory", content: "fresh", recreates: 0, deletedAt: now - DAY },
    ];
    const out = pruneTombstones(list, now);
    expect(out.map((t) => t.content)).toEqual(["fresh"]);
  });

  it("caps the count, keeping the NEWEST entries", () => {
    const now = Date.now();
    const list: Tombstone[] = Array.from({ length: TOMBSTONE_MAX_ENTRIES + 5 }, (_, i) => ({
      kind: "memory" as const,
      content: `c${i}`,
      recreates: 0,
      deletedAt: now - i * 1000,
    }));
    const out = pruneTombstones(list, now);
    expect(out).toHaveLength(TOMBSTONE_MAX_ENTRIES);
    expect(out[0]!.content).toBe("c0"); // newest first
  });
});

describe("parseTombstones", () => {
  it("parses a valid sidecar", () => {
    const raw = JSON.stringify({
      version: 1,
      tombstones: [{ kind: "memory", content: "run pnpm check", recreates: 2, deletedAt: 123 }],
    });
    expect(parseTombstones(raw)).toEqual([
      { kind: "memory", content: "run pnpm check", recreates: 2, deletedAt: 123 },
    ]);
  });

  it("is tolerant: malformed JSON, non-array, bad entries → empty/partial", () => {
    expect(parseTombstones("not json")).toEqual([]);
    expect(parseTombstones('{"tombstones": "nope"}')).toEqual([]);
    expect(
      parseTombstones(
        JSON.stringify({
          tombstones: [
            { kind: "bogus", content: "x", deletedAt: 1 },
            { kind: "memory", content: "", deletedAt: 1 },
            { kind: "memory", content: "ok", deletedAt: "nope" },
            { kind: "prompt", content: "good", recreates: -3, deletedAt: 5 },
          ],
        }),
      ),
    ).toEqual([{ kind: "prompt", content: "good", recreates: 0, deletedAt: 5 }]);
  });
});

describe("recordRemoval + detectRecreate", () => {
  beforeEach(() => resetTombstones());

  it("records a removal and matches a near-identical recreate", () => {
    recordRemoval([{ kind: "memory", content: "Always run pnpm check before committing" }]);
    const n = detectRecreate("memory", "always run pnpm check before committing!");
    expect(n).toBe(1);
  });

  it("increments across repeated recreates of the same lineage", () => {
    recordRemoval([{ kind: "memory", content: "use tabs in src" }]);
    expect(detectRecreate("memory", "use tabs in src")).toBe(1);
    expect(detectRecreate("memory", "Use tabs in src/")).toBe(2);
  });

  it("does not match across kinds or clearly different content", () => {
    recordRemoval([{ kind: "memory", content: "use tabs in src" }]);
    expect(detectRecreate("prompt", "use tabs in src")).toBeUndefined();
    expect(detectRecreate("memory", "completely unrelated words here")).toBeUndefined();
  });

  it("carries the lineage count: deleting a recreated item preserves recreates", () => {
    recordRemoval([{ kind: "memory", content: "use tabs in src" }]);
    detectRecreate("memory", "use tabs in src"); // recreate #1
    // The recreated item is deleted again, now carrying recreates: 1.
    recordRemoval([{ kind: "memory", content: "use tabs in src", recreates: 1 }]);
    const list = listTombstones();
    expect(list).toHaveLength(1);
    expect(list[0]!.recreates).toBe(1);
    expect(detectRecreate("memory", "use tabs in src")).toBe(2);
  });

  it("folds a similar re-removal onto the existing tombstone with max recreates", () => {
    const now = Date.now();
    recordRemoval([{ kind: "skill", content: "prefer pnpm over npm", recreates: 2 }], now);
    recordRemoval([{ kind: "skill", content: "prefer pnpm over npm!" }], now + 1000);
    const list = listTombstones();
    expect(list).toHaveLength(1);
    expect(list[0]!.recreates).toBe(2);
    expect(list[0]!.deletedAt).toBe(now + 1000);
  });
});

describe("sidecar round-trip", () => {
  beforeEach(() => resetTombstones());

  it("flushes the pruned list and loads it back", async () => {
    const path = tmpFile();
    recordRemoval([{ kind: "memory", content: "run pnpm check", recreates: 1 }]);
    // Drain the scheduled flush chain, then flush explicitly.
    await flushTombstones(path);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.tombstones).toHaveLength(1);
    resetTombstones();
    expect(listTombstones()).toEqual([]);
    await loadTombstones(path);
    expect(listTombstones()).toEqual([
      { kind: "memory", content: "run pnpm check", recreates: 1, deletedAt: expect.any(Number) },
    ]);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  it("loadTombstones tolerates a missing file (fresh install)", async () => {
    const path = tmpFile();
    await loadTombstones(path);
    expect(listTombstones()).toEqual([]);
  });

  it("flush prunes stale entries from the file", async () => {
    const path = tmpFile();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        tombstones: [
          { kind: "memory", content: "stale", recreates: 0, deletedAt: Date.now() - 400 * DAY },
          { kind: "memory", content: "live", recreates: 0, deletedAt: Date.now() },
        ],
      }),
      "utf8",
    );
    await loadTombstones(path);
    await flushTombstones(path);
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.tombstones.map((t: Tombstone) => t.content)).toEqual(["live"]);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });
});

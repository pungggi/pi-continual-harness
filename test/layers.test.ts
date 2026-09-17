// Real-path composition under a FAKE HOME (issue #7).
//
// The homedir()-derived constants (DEFAULT_DURABLE_PATH, PROJECT_DURABLE_DIR,
// CONFIG_PATH) are computed at module load, so this file overrides
// USERPROFILE/HOME BEFORE dynamically importing the src modules — every test
// file runs in its own isolated fork, so other suites are unaffected. This is
// the only place that exercises the /harness export|import layered handlers and
// the full continualHarness auto-import/auto-export wiring with the REAL path
// layout (pointing at the temp home instead of the developer's ~/.pi).

import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const fakeHome = mkdtempSync(join(tmpdir(), "pi-ch-home-"));
process.env.USERPROFILE = fakeHome; // win32 os.homedir()
process.env.HOME = fakeHome; // posix os.homedir()

// Import AFTER the env override — top-level await keeps ordering deterministic.
const { default: continualHarness } = await import("../src/index.js");
const store = await import("../src/store.js");
const config = await import("../src/config.js");
const { makeFakePi } = await import("./helpers.js");

const CWD = join(fakeHome, "work", "my-proj");
const SLUG = config.projectSlug(CWD);
const GLOBAL_FILE = store.DEFAULT_DURABLE_PATH;
const PROJECT_FILE = config.projectDurablePath(CWD);

function writeLayer(path: string, bullets: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    ["# Continual Harness State", "", "## Memory facts", "", ...bullets, ""].join("\n"),
    "utf8",
  );
}

async function reset(): Promise<void> {
  store.reconstruct([]);
  store.setSessionProject(undefined);
  config.resetConfigCache();
  await config.loadConfig(join(fakeHome, "no-config-here.json")); // defaults
}

beforeEach(async () => {
  await reset();
  rmSync(join(fakeHome, ".pi"), { recursive: true, force: true });
});

describe("/harness layered I/O (real path layout, fake HOME)", () => {
  it("export without a path writes the global layer and the project layer by item scope", async () => {
    const { pi, commands, ctx, notifications } = makeFakePi([], CWD);
    continualHarness(pi);
    // one global item, one project item (moved via the command)
    store.applyDeltas(
      [
        { op: "create", kind: "memory", content: "global fact", evidence: "e" },
        { op: "create", kind: "memory", content: "project fact", evidence: "e" },
      ],
      () => {},
    );
    const id = store.getState().items.find((i) => i.content === "project fact")!.id;
    await commands.get("harness")!.handler(`move ${id} project`, ctx());

    await commands.get("harness")!.handler("export", ctx());

    expect(existsSync(GLOBAL_FILE)).toBe(true);
    expect(readFileSync(GLOBAL_FILE, "utf8")).toContain("global fact");
    expect(readFileSync(GLOBAL_FILE, "utf8")).not.toContain("project fact");
    expect(existsSync(PROJECT_FILE)).toBe(true);
    expect(readFileSync(PROJECT_FILE, "utf8")).toContain("project fact");
    expect(readFileSync(PROJECT_FILE, "utf8")).toContain(`- scope: project (${SLUG})`);
    expect(
      notifications.some((n) => /Exported 2 active item\(s\) to 2 layer file/.test(n.msg)),
    ).toBe(true);
  });

  it("import without a path merges both layers (project layer wins collisions)", async () => {
    writeLayer(GLOBAL_FILE, [
      "- **[h_g]** (importance 0.50) global fact",
      "  - evidence: e",
      "- **[h_dup]** (importance 0.50) stale copy",
      "  - evidence: e",
    ]);
    writeLayer(PROJECT_FILE, [
      "- **[h_p]** (importance 0.50) project fact",
      "  - evidence: e",
      "- **[h_dup]** (importance 0.90) fresh project copy",
      "  - evidence: e",
    ]);

    const { pi, commands, ctx, notifications } = makeFakePi([], CWD);
    continualHarness(pi);
    await commands.get("harness")!.handler("import", ctx());

    const byId = new Map(store.getState().items.map((i) => [i.id, i]));
    expect(byId.get("h_g")!.scope).toBe("global");
    expect(byId.get("h_p")!.project).toBe(SLUG);
    expect(byId.get("h_dup")!.content).toBe("fresh project copy"); // later layer wins
    expect(byId.get("h_dup")!.scope).toBe("project");
    expect(store.getState().items.filter((i) => i.id === "h_dup")).toHaveLength(1); // no dup
    expect(notifications.some((n) => /Imported 4 item\(s\)/.test(n.msg))).toBe(true);
  });

  it("import warns when neither layer exists", async () => {
    const { pi, commands, ctx, notifications } = makeFakePi([], CWD);
    continualHarness(pi);
    await commands.get("harness")!.handler("import", ctx());
    expect(notifications.some((n) => /No durable files at/.test(n.msg))).toBe(true);
  });
});

describe("continualHarness autoImport wiring (fake HOME)", () => {
  it("session_start imports both layers and turn_end exports after a mutation", async () => {
    // opt in via the (fake-HOME) config file
    mkdirSync(dirname(config.CONFIG_PATH), { recursive: true });
    writeFileSync(
      config.CONFIG_PATH,
      JSON.stringify({ autoImport: true }),
      "utf8",
    );
    config.resetConfigCache(); // force a re-read of the fake config

    writeLayer(GLOBAL_FILE, [
      "- **[h_g]** (importance 0.50) durable global fact",
      "  - evidence: e",
    ]);

    const { pi, fire, ctx, notifications } = makeFakePi([], CWD);
    continualHarness(pi);
    await fire("session_start", { reason: "startup" }, ctx());
    expect(store.getState().items.map((i) => i.id)).toEqual(["h_g"]);
    expect(notifications.some((n) => /durable sync imported 1 item\(s\)/.test(n.msg))).toBe(true);

    // a mutation → the durable layers are refreshed on turn_end
    store.applyDeltas([{ op: "create", kind: "memory", content: "live fact", evidence: "e" }], () => {});
    await fire("turn_end", { type: "turn_end", turnIndex: 0 }, ctx());
    expect(readFileSync(GLOBAL_FILE, "utf8")).toContain("live fact");
    expect(notifications.some((n) => /durable state exported/.test(n.msg))).toBe(true);
  });

  it("session_start stays quiet with autoImport off and no durable files", async () => {
    const { pi, fire, ctx, notifications } = makeFakePi([], CWD);
    continualHarness(pi);
    await fire("session_start", { reason: "startup" }, ctx());
    expect(notifications).toHaveLength(0);
    expect(store.getState().items).toHaveLength(0);
  });
});

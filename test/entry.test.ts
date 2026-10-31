// The thin entry's registration behavior (issue #36) and, most importantly,
// the turn_end ORDERING INVARIANT: durable sync's export must run BEFORE
// outcome/auto-refine, so a refine's deltas are visible to that same turn's
// export check. The order used to live only in a comment; TURN_END_CHAIN is
// the executable form of it (pinned here so a future insertion cannot
// silently reorder the chain).

import { describe, it, expect } from "vitest";
import continualHarness, { TURN_END_CHAIN } from "../src/entry.js";
import { makeFakePi } from "./helpers.js";

describe("TURN_END_CHAIN ordering invariant", () => {
  it("registers the five turn_end subscribers in the load-bearing order", () => {
    expect(TURN_END_CHAIN.map((h) => h.name)).toEqual([
      "remind",
      "auto-export", // durable sync's export BEFORE outcome/auto-refine
      "import-reminder",
      "outcome",
      "auto-refine",
    ]);
  });

  it("auto-export precedes outcome and auto-refine", () => {
    const names = TURN_END_CHAIN.map((h) => h.name);
    expect(names.indexOf("auto-export")).toBeLessThan(names.indexOf("outcome"));
    expect(names.indexOf("auto-export")).toBeLessThan(names.indexOf("auto-refine"));
  });

  it("handler names are unique", () => {
    const names = TURN_END_CHAIN.map((h) => h.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("extension factory registration", () => {
  it("registers every event, tool, and command exactly once", () => {
    const { pi, handlers, tools, commands } = makeFakePi([]);
    continualHarness(pi);
    expect(handlers.get("session_start")).toHaveLength(1);
    expect(handlers.get("before_agent_start")).toHaveLength(1);
    expect(handlers.get("context_with_system")).toHaveLength(1);
    // Exactly the TURN_END_CHAIN, in order.
    expect(handlers.get("turn_end")).toHaveLength(TURN_END_CHAIN.length);
    expect([...tools.keys()].sort()).toEqual(["harness_list", "harness_mutate"]);
    expect([...commands.keys()].sort()).toEqual(["harness", "refine"]);
  });
});

// pi-continual-harness — THIN extension entry (issue #36).
//
// Pi loads extension entries sequentially and awaits every factory before
// startup continues, and jiti transpiles a raw TypeScript entry on every
// launch. The old all-static entry (src/index.ts) therefore paid for its
// entire import graph (~10 feature modules, ~230KB TS) on EVERY pi startup:
// ~0.8s marginal in the 2026-10-11 measurement. Two fixes, both applied:
//
//   1. Ship precompiled dist/ (package.json pi.extensions points at
//      ./dist/entry.js) — no per-startup jiti transpile.
//   2. Keep this factory synchronous and THIN: it only registers commands,
//      tool schemas, and event hooks. Every feature implementation is
//      dynamic-imported inside its handler, so nothing heavy evaluates until
//      the relevant event actually fires (after the TUI paints).
//
// Registration happens in the SAME order as the historical index.ts factory:
// session_start → inject (before_agent_start, context_with_system) → tools →
// /refine → /harness → the turn_end chain below.
//
// The feature modules' own register* functions remain the test-facing path
// (they delegate to the same extracted handlers this entry calls), and
// src/index.ts re-exports this factory as the package default plus the full
// public API for companion packages — which load it on demand, not at pi
// startup.

import type {
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
  TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { HARNESS_COMMAND_DESCRIPTION, REFINE_COMMAND_DESCRIPTION } from "./command-meta.js";
import {
  harnessListTool,
  harnessMutateTool,
  type HarnessListParams,
  type HarnessMutateParams,
} from "./schemas.js";

/** One lazily-loaded turn_end subscriber. `run` dynamic-imports its feature
 *  module on first fire, so the entry stays thin. */
interface TurnEndHandler {
  /** Stable identity for the ordering invariant (test/entry.test.ts). */
  name: string;
  run: (
    pi: ExtensionAPI,
    event: TurnEndEvent,
    ctx: ExtensionContext,
  ) => Promise<TurnEndEventResult | void> | void;
}

/** The turn_end chain in REGISTRATION ORDER. The order is load-bearing:
 *  durable sync's export must run BEFORE outcome/auto-refine — a refine's
 *  deltas must be visible to that same turn's export check, not the next
 *  one's. This array is the single definition; test/entry.test.ts pins the
 *  order so a future insertion cannot silently reorder it. */
export const TURN_END_CHAIN: TurnEndHandler[] = [
  {
    name: "remind",
    run: (_pi, event, ctx) => import("./remind.js").then((m) => m.handleRemindTurnEnd(event, ctx)),
  },
  {
    name: "auto-export",
    run: (pi, _event, ctx) =>
      import("./durable.js").then((m) => m.handleAutoExportTurnEnd(pi, ctx)),
  },
  {
    name: "import-reminder",
    run: (_pi, event, ctx) =>
      import("./durable.js").then((m) => m.handleImportReminderTurnEnd(event, ctx)),
  },
  {
    name: "outcome",
    run: (pi, event, ctx) =>
      import("./outcome.js").then((m) => m.handleOutcomeTurnEnd(pi, event, ctx)),
  },
  {
    name: "auto-refine",
    run: (pi, event, ctx) =>
      import("./auto-refine.js").then((m) => m.handleAutoRefineTurnEnd(pi, event, ctx)),
  },
];

export default function continualHarness(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    await (await import("./lifecycle.js")).onSessionStart(pi, ctx);
  });

  // Injection: the model-binding bridge + the render (see inject.ts).
  pi.on("before_agent_start", async (event, ctx) =>
    (await import("./inject.js")).handleBeforeAgentStart(pi, event, ctx),
  );
  pi.on("context_with_system", async (event, ctx) =>
    (await import("./inject.js")).handleContextWithSystem(event, ctx),
  );

  // Tools: schemas are static (cheap data, shared with tools.ts); executes
  // lazy-load the store-backed implementation on first call.
  pi.registerTool(
    harnessListTool(async (_toolCallId, params) =>
      (await import("./tools.js")).executeHarnessList(params as HarnessListParams),
    ),
  );
  pi.registerTool(
    harnessMutateTool(async (_toolCallId, params) =>
      (await import("./tools.js")).executeHarnessMutate(pi, params as HarnessMutateParams),
    ),
  );

  // /refine (manual optimizer) and /harness (durable I/O + hygiene).
  pi.registerCommand("refine", {
    description: REFINE_COMMAND_DESCRIPTION,
    handler: async (args, ctx) => (await import("./refine.js")).runRefineCommand(pi, args, ctx),
  });
  pi.registerCommand("harness", {
    description: HARNESS_COMMAND_DESCRIPTION,
    handler: async (args, ctx) => (await import("./harness.js")).runHarnessCommand(pi, args, ctx),
    // Async completions are supported by pi's command API; the store-backed
    // menus (item ids, model keys, presets) lazy-load with the module.
    getArgumentCompletions: async (argumentPrefix) =>
      (await import("./harness.js")).harnessCompletions(argumentPrefix),
  });

  // turn_end chain (order preserved from the historical factory — see
  // TURN_END_CHAIN): remind → auto-export → import-reminder → outcome →
  // auto-refine. In production pi every turn_end handler runs.
  for (const h of TURN_END_CHAIN) {
    pi.on("turn_end", (event, ctx) => h.run(pi, event, ctx));
  }
}

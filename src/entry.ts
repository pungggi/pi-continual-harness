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
// /refine → /harness → remind → auto-export → import-reminder → outcome →
// auto-refine. The turn_end order matters: durable sync's export must run
// before outcome/auto-refine.
//
// The feature modules' own register* functions remain the test-facing path
// (they delegate to the same extracted handlers this entry calls), and
// src/index.ts re-exports this factory as the package default plus the full
// public API for companion packages — which load it on demand, not at pi
// startup.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HARNESS_COMMAND_DESCRIPTION, REFINE_COMMAND_DESCRIPTION } from "./command-meta.js";
import {
  harnessListTool,
  harnessMutateTool,
  type HarnessListParams,
  type HarnessMutateParams,
} from "./schemas.js";

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
    harnessListTool(
      async (_toolCallId, params) =>
        (await import("./tools.js")).executeHarnessList(params as HarnessListParams),
    ),
  );
  pi.registerTool(
    harnessMutateTool(
      async (_toolCallId, params) =>
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

  // turn_end chain (order preserved from the historical factory):
  pi.on("turn_end", async (event, ctx) =>
    (await import("./remind.js")).handleRemindTurnEnd(event, ctx),
  );
  // Durable sync's turn_end export (opt-in via autoImport) registers before
  // outcome/auto-refine; in production pi every turn_end handler runs.
  pi.on("turn_end", async (_event, ctx) =>
    (await import("./durable.js")).handleAutoExportTurnEnd(pi, ctx),
  );
  // Import-awareness reminders (autoImport bundles them; bounded cadence).
  pi.on("turn_end", async (event, ctx) =>
    (await import("./durable.js")).handleImportReminderTurnEnd(event, ctx),
  );
  pi.on("turn_end", async (event, ctx) =>
    (await import("./outcome.js")).handleOutcomeTurnEnd(pi, event, ctx),
  );
  pi.on("turn_end", async (event, ctx) =>
    (await import("./auto-refine.js")).handleAutoRefineTurnEnd(pi, event, ctx),
  );
}

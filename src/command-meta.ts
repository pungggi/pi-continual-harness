// Command registration metadata shared by the thin entry (entry.ts) and the
// feature modules' own register functions (refine.ts, harness.ts). Registration
// must be synchronous at factory time, so the description strings cannot live
// behind a dynamic import — but they CAN live in this tiny data module both
// paths share, which keeps them from drifting apart (issue #36).

export const REFINE_COMMAND_DESCRIPTION =
  "Online self-improvement: review recent trajectory and propose evidence-backed CRUD deltas to the harness state. Usage: /refine [lookback-turns] [--commit] [--proposer steering|dedupe] [--threshold 0.75]";

export const HARNESS_COMMAND_DESCRIPTION =
  "Durable harness-state I/O + importance hygiene " +
  "(import · export · status · adopt · prune · keep · drop · push-mem — " +
  "subcommands autocomplete as you type)";

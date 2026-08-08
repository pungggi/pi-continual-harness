# pi-continual-harness

Online self-improvement layer for the [pi](https://pi.dev) coding agent.

This package owns **only the online optimizer layer**: a unified, in-trajectory
harness-state store (prompt notes, memory, skill descriptions, sub-agent specs)
plus a manual `/refine` that proposes **evidence-backed structured CRUD deltas**.

It deliberately does **not** reinvent storage or offline refinement. It composes
with:

- **[pi-reflect](https://github.com/jo-inc/pi-reflect)** — offline transcript
  → behavioral-file refinement (the "deep" path).
- **pi-mem / pi-memory** — durable memory storage.

The durable markdown file (`~/.pi/agent/harness-state.md`) is the composition seam,
and it is **two-way**: `/refine --commit` and `/harness export` write it;
`/harness import` parses it back and merges into the live store (offline edits
win on conflict), so refinements pi-reflect makes flow back online. `/harness push-mem`
pushes active items into pi-mem's semantic store (see
[Composing with pi-mem](#composing-with-pi-mem)).

## Why

Grounded in two lines of research:

- **Continual Harness** (arXiv [2605.09998](https://arxiv.org/abs/2605.09998)) —
  reset-free online CRUD over prompt / sub-agents / skills / memory drawn from
  the trajectory. Distinct from prompt-optimization methods that need episode
  resets.
- **ACE — Agentic Context Engineering** (arXiv
  [2510.04618](https://arxiv.org/abs/2510.04618)) — context as an evolving
  playbook. Key design lesson applied here: the optimizer emits **structured,
  itemized deltas**, never prose prompt rewrites, to prevent context collapse
  and brevity bias.

Prime Intellect's Prime Agent ships a Continual Harness built on pi; this
package is a minimal, package-shaped take on the same idea — **online only**,
leaving offline and storage to the packages that already do them well.

## Install

```
pi install npm:pi-continual-harness
```

Or drop `src/index.ts` into `~/.pi/agent/extensions/`.

## Usage

```
/refine              # review last 25 turns, propose deltas
/refine 50           # review last 50 turns
/refine 25 --commit  # also export durable state to ~/.pi/agent/harness-state.md
/refine --proposer dedupe  # run the rule-based dedupe proposer instead of steering
```

Durable I/O (round-trip with pi-reflect):

```
/harness status                  # counts + durable file presence/mtime
/harness export [path]           # write active items to a markdown file
/harness import [--prune] [path] # parse it back and merge (offline edits win)
/harness prune [--decay <days>]  # drop items below the importance floor
/harness keep <id>               # nudge importance up (+0.1)
/harness drop <id>               # nudge importance down (−0.1)
/harness push-mem [--all|--kind <kind>]  # persist active items to pi-mem (save_memory)
```

`import` reconciles the file into the live store: items whose id matches an
existing entry are updated (offline edits win on content/evidence/importance),
new entries are created. By default nothing is deleted — `--prune` also drops
active items whose id is no longer in the file (inactive items are always
preserved). Point pi-reflect at the same file to refine it offline:

```
/reflect ~/.pi/agent/harness-state.md
```

The model-facing tools:

- `harness_list [kind]` — read current state (optionally filtered by kind).
- `harness_mutate { deltas: [...] }` — apply a batch of `create` / `update` /
  `delete` deltas. Every `create` requires `evidence`.

Active items are injected into the system prompt each turn as a structured
block, appended to (never replacing) the base prompt.

## Composing with pi-mem

`/harness push-mem` copies active harness items into
[pi-mem](https://github.com/georgebashi/pi-mem)'s semantic memory store, so they
become searchable across sessions. It works by **steering** the agent to call
pi-mem's `save_memory` tool — there is **no dependency** on pi-mem: it is a
soft-fail composition. If pi-mem (or any memory tool) is not installed, the
agent tells you so rather than fabricating one.

```
pi install npm:pi-mem        # optional companion
```

By default only **memory**-kind items are pushed (the clean 1:1 mapping); use
`--all` for every active item or `--kind prompt|skill|subagent` for a specific
kind. The harness store itself is unchanged by a push — pi-mem gets a separate
copy.

## Configuration

Optional config at `~/.pi/agent/harness.json` (missing or malformed → defaults):

```json
{
  "durableScope": "global",
  "proposer": "steering",
  "remindRefine": { "enabled": false, "everyTurns": 50 },
  "autoRefine": { "enabled": false, "everyTurns": 100, "commit": false },
  "outcomeImportance": { "enabled": false, "bump": 0.03 }
}
```

- **`durableScope`** — `"global"` (default) writes the durable markdown to
  `~/.pi/agent/harness-state.md`; `"project"` writes to
  `~/.pi/agent/harness-state/<slug>.md` (slug derived from `cwd`) so each
  project keeps separate state for pi-reflect.
- **`proposer`** — which delta proposer `/refine` and auto-refine use. Defaults
  to `steering` (the agent reasons via a steering message). `dedupe` applies a
  rule-based dedupe directly. See [Proposers](#proposers).
- **`remindRefine`** — opt-in `turn_end` nudge. `{ "enabled": true,
  "everyTurns": 50 }` notifies you to run `/refine` on a cadence. It is
  informational only — it never mutates state.
- **`autoRefine`** — opt-in autonomous self-improvement (**off by default**).
  When `enabled`, the agent runs `/refine` itself every `everyTurns` turns
  (default 100). It is one of the package's opt-in autonomous paths: it reuses
  the exact `/refine` routine (audited `REFINE_ENTRY` tagged `source: "auto"`,
  branch-local, `/tree` rollback) and notifies before firing. `commit: true`
  also flushes durable state on each run.
- **`outcomeImportance`** — opt-in autonomous **promotion** loop (**off by
  default**). When `enabled`, a `turn_end` hook bumps (+`bump`, default 0.03)
  the importance of any active item the agent cited by its `[h_xxxx]` tag in the
  turn's output. Referenced items gain importance and get their `updatedAt`
  touched (so they survive time-based decay); ignored items keep decaying. This
  is the package's second opt-in autonomous path — promotion only, never
  deletes, persisted/branchable like `harness_mutate`. Autonomous demotion from
  outcomes is intentionally NOT done (high false-positive); use `/harness drop`,
  `prune --decay`, or the `dedupe` proposer for that.

## How it works

1. `/refine` gathers recent trajectory evidence from the current session branch.
2. A **proposer** decides what to do. The default (`steering`) sends a steering
   user message asking the agent to propose evidence-backed CRUD deltas via
   `harness_mutate`; rule-based proposers (e.g. `dedupe`) return deltas the
   harness applies directly. See [Proposers](#proposers).
3. The agent calls the tools (steering path); each accepted delta updates the
   in-memory state, which is snapshotted to the session via
   `appendEntry("harness-state", ...)`. Direct-apply proposers snapshot the
   same way.
4. Because pi's session tree branches at any entry, `/tree` navigation gives
   rollback to any pre-refinement point for free — no bespoke snapshot system.

This reuses the existing agent loop (no nested/hidden model calls), is
model-agnostic, and keeps every delta visible and reviewable in the transcript.

## Proposers

`/refine` is split into two stages: **propose** (given evidence + state, decide
what deltas to pursue) and **apply** (send a steering message, or apply returned
deltas directly). The propose stage is pluggable via a registry
(`src/proposer.ts`).

| Name | What it does |
|---|---|
| `steering` (default) | Delegates reasoning to the agent via a steering message — reuses the agent loop, model-agnostic, fully visible. |
| `dedupe` | Rule-based: drops near-duplicate active items (token-overlap ≥ 0.6), keeping the higher-importance one. No model call. |

Select a proposer per run with `/refine --proposer <name>`, or set the default
for auto-refine via `proposer` in the [config](#configuration). Both paths are
audited: the `harness-refinement` entry records which proposer ran and how many
deltas it applied directly.

A dedicated-model proposer — one that makes its own (hidden) LLM call to
produce deltas directly — is the obvious next alternate. This package still
does **not** ship one (hidden model spend is a tradeoff kept as a separate
decision; see `docs/ROADMAP.md`), but it now **enables** one: when a model is
available, `/refine` injects a one-shot `complete(prompt, opts?)` into
`ProposeInput` and records any `modelCall` telemetry a proposer returns
(model, tokens, latency, ok/error) in the `harness-refinement` audit entry —
so a companion package can ship a dedicated-model proposer whose spend stays
**audited, not hidden**. One ships as a companion: **[pi-harness-model-proposer](https://github.com/pungggi/pi-harness-model-proposer)**
(`pi install npm:pi-harness-model-proposer`). Both `complete` and `modelCall` are optional;
`steering` and `dedupe` ignore them, so the default behavior is unchanged.

Register your own proposer from another extension (the registry is re-exported
from the package entry):

```ts
import { registerProposer } from "pi-continual-harness";

registerProposer({
  name: "my-proposer",
  async propose({ evidence, state, complete }) {
    // `complete` is injected when a model is available (undefined otherwise);
    // a dedicated-model proposer calls it and returns deltas + modelCall telemetry.
    /* inspect evidence + state, return deltas (and/or a steering message) */
    return { deltas: [/* { delta, rationale } */] };
  },
});
```

Then `"my-proposer"` is selectable via `/refine --proposer my-proposer` or
`"proposer": "my-proposer"` in the config.

## Scope and non-goals

- **In scope:** unified state store, online `/refine`, structured deltas,
  prompt injection, branching rollback, durable markdown export.
- **Out of scope (compose instead):** durable storage engines (pi-mem), offline
  deep refinement of behavioral files (pi-reflect), live sub-agent
  orchestration (pi-boss / pi-room). Sub-agent *specs* are stored as data only.

## Status

0.5.x. Implemented:

- Unified harness-state store with branch-local snapshots (`/tree` rollback).
- Online `/refine` + `harness_mutate` / `harness_list` tools.
- Two-way durable round-trip with pi-reflect (`/harness import|export|status`).
- Importance hygiene: `/harness prune [--decay <days>]` and `/harness keep|drop
  <id>`.
- **pi-mem composition**: `/harness push-mem [--all|--kind]` steers the agent
  to persist active items into pi-mem (soft-fail; no dependency).
- Optional config (`~/.pi/agent/harness.json`): project-local durable scope, an
  opt-in `turn_end` reminder, opt-in `turn_end` auto-refine, and an opt-in
  `turn_end` outcome-importance loop — the package's two opt-in autonomous
  paths (both off by default).
- **Pluggable delta proposers** with a registry: `steering` (default) and
  `dedupe` (rule-based) shipped; `registerProposer()` for custom ones.

Open extension points (see `docs/ROADMAP.md`):

- A dedicated-model proposer (the enabler landed: `complete` injection +
  `modelCall` telemetry; the proposer logic itself is left to a companion
  package — the hidden-model-spend tradeoff is resolved by making the spend
  audited rather than shipping it invisible).
- Correction-side outcome signals (promotion is shipped; autonomous demotion
  is high-false-positive, so it is served by `/harness drop`, `prune --decay`,
  and the `dedupe` proposer — a fuzzy `corrections` proposer is the natural
  future extension).

## License

MIT

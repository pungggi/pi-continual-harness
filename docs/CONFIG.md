# Configuration reference — `~/.pi/agent/harness.json`

Every key is optional: a missing file loads the shipped defaults, a malformed
file loads defaults **plus a once-per-session warning** (a typo can't silently
reset your settings), and unknown keys are ignored (so `$schema` and keys from
newer/older versions ride along harmlessly). Run `/harness setup` for a guided
wizard instead of hand-editing — see the
[README](../README.md#configuration) for the wizard's flow.

```json
{
  "$schema": "https://raw.githubusercontent.com/pungggi/pi-continual-harness/main/harness.schema.json",
  "autoImport": false,
  "importRemind": { "enabled": true, "everyTurns": 25 },
  "proposer": "steering",
  "dedupe": { "threshold": 0.6, "merge": true },
  "injection": { "enabled": true, "maxTokens": 1500, "maxPerKind": 10, "charsPerToken": 4 },
  "remindRefine": { "enabled": true, "everyTurns": 25, "detailEvery": 4 },
  "autoRefine": { "enabled": false, "everyTurns": 100, "commit": false, "gate": false, "refineNoOpSkip": 3 },
  "outcomeImportance": { "enabled": false, "bump": 0.03 },
  "classifier": { "model": "typesafe/jev-latest" },
  "virtualBinding": "virtual"
}
```

**Editor validation**: add the `"$schema"` line above for completion and
validation in editors that support JSON schemas (the same pattern pi ≥ 1.2
ships for its own `settings.json` / `models.json`). The loader ignores unknown
keys — `$schema` included — and a `/harness setup` rewrite preserves it.

## Keys

- **`autoImport`** — opt-in **durable sync** (off by default). `true` bundles
  both directions: on `session_start` the durable layers are imported
  automatically (global file always + the current project's file, with the same
  loss-free merge as `/harness import` — an import that changes nothing stays
  silent), and on `turn_end` the layers are re-exported whenever the live store
  changed since the last export. This is what makes `/refine` output survive
  into **new** sessions without manual export/import ceremony. Both halves are
  visible (one notify line) and use the same persisted `harness-state` entries
  as every other mutation (`/tree` rollback covers them). Enabling it
  mid-session (e.g. via `/harness setup`) is safe: the first `turn_end`
  imports the layers *before* any export, so a late enable can never
  overwrite the durable files with a never-imported store.
- **`importRemind`** — **awareness reminders** for that sync (effective only
  when `autoImport` is on; default `{ "enabled": true, "everyTurns": 25 }`).
  The session-start import doesn't just count — it **lists what arrived**
  (item id, kind, first words of content), and every `everyTurns` turns a
  one-line reminder re-surfaces the imported items so silently-injected
  instructions never go unnoticed (full list via the agent's `harness_list`
  tool — `/harness status` shows only counts). Bounded: at most 3 reminders
  per imported batch, then quiet until the next session; aborted/error turns
  are inert (completed-turn cadence). Kill-switch:
  `{ "importRemind": { "enabled": false } }` (the start-of-session listing
  still fires).
- **`injection`** — the selection policy for WHAT gets surfaced in the system
  prompt each turn (see the README's
  [Injection selection](../README.md#injection-selection-on-by-default)
  section). ON by default: items are importance-ordered, capped at `maxPerKind`
  (default 10) per kind and `maxTokens` (default 1500) total. Set
  `enabled: false` to restore the legacy "inject all items, in store order"
  behaviour.
- **`proposer`** — which delta proposer `/refine` and auto-refine use. Defaults
  to `steering` (the agent reasons via a steering message). `dedupe` applies a
  rule-based merge directly. See the README's
  [Proposers](../README.md#proposers) section.
- **`dedupe`** — the rule-based dedupe proposer's policy. `threshold` (default
  `0.6`, valid `(0,1]`) is the token-overlap level at which two items sharing
  the key fields (kind, owner model, durable layer) count as duplicates;
  `merge` (default `true`) **merges** each duplicate into its keeper — the
  keeper keeps its content verbatim, its `evidence` becomes the line-wise union
  of both, applied as one audited `update` + `delete` pair — while `false`
  restores the pre-0.10 delete-only behavior. `/refine --proposer dedupe
  --threshold 0.75` overrides the threshold for one run. A fourth key,
  `similarity`, is API-only (functions cannot come from `harness.json`):
  companion packages inject a richer comparator whose return may **abstain**
  per pair (`{ score, abstain }`); an abstaining pair is always kept, never
  merged or deleted.
- **`remindRefine`** — the `turn_end` **activation nudge**, ON by default
  (informational only; it never mutates state). Every `everyTurns` completed
  turns (default 25) a one-line reminder suggests `/refine`, garnished with
  live data from the store (e.g. "12 active item(s), 4 never cited since
  creation"; an empty store gets first-run guidance instead). Every
  `detailEvery`-th reminder (default 4: at the default cadence, roughly
  every 100 turns) escalates to a rotating educational guide: how the loop
  works (with alternate descriptions so it never reads as boilerplate), the
  `/refine` workflow, `keep`/`drop`/`prune --decay` hygiene, `push-mem`,
  `split`, `export-corpus`, and a recommended starter config. Fresh installs
  used to be silent; that was the bug, not the feature. Aborted/error turns
  are skipped, so `everyTurns` counts completed turns of work. Silence it
  with `{ "remindRefine": { "enabled": false } }`; `detailEvery: 1` makes
  every reminder detailed.
- **`autoRefine`** — opt-in autonomous self-improvement (**off by default**).
  When `enabled`, the agent runs `/refine` itself every `everyTurns` turns
  (default 100). It is one of the package's opt-in autonomous paths: it reuses
  the exact `/refine` routine (audited `REFINE_ENTRY` tagged `source: "auto"`,
  branch-local, `/tree` rollback) and notifies before firing. `commit: true`
  also flushes durable state on each run. `gate: true` (needs `classifier.model`)
  asks the classifier first whether the recent trajectory contains a durable,
  reusable correction and skips the refine when it does not — cadence becomes
  signal, not just time (errors fall back to the plain cadence).
  `refineNoOpSkip` (default 3, `0` disables) is a free **history gate** that
  runs first: when the last N refine runs (any source) all produced nothing
  durable, the cadenced refine is skipped as a likely repeat no-op. It is
  **bounded**: at most one consecutive cadence is skipped on history grounds,
  so the gate can never latch shut — later trajectory evidence always gets a
  refine within one cadence (and manual `/refine` never consults the gate).
  The steering
  prompt is delivered via the pi ≥ 0.87 actionable `turn_end` boundary (a
  structural `harness.auto-refine-request` entry + `continue: true`), not a
  synthetic user message. Aborted/error turns (pi `turn_end`
  `BoundaryState.outcome`) are inert: they neither seed nor advance the
  cadence window — a refine never fires over partial evidence.
- **`classifier`** — opt-in classifier model (pi ≥ 0.99) for the cheap gated
  paths: `"provider/id"` or a bare id of a **classifier** catalog entry, e.g.
  `"typesafe/jev-latest"` or a local `llama-cpp` classifier (every chat model
  listed for llama.cpp also appears as one). With pi ≥ 1.1.0 the catalog also
  offers OpenAI's GPT-6 Luna through the Decisions API (e.g.
  `"openai/gpt-6-luna"`, needs `OPENAI_API_KEY`) and the native llama.cpp
  decision models (Julia-1, Laya, Kev, lev, OpenJev through `/v1/systemone`,
  llama.cpp ≥ 0.6.0 — listed *only* as classifiers, which is exactly our use:
  a free local gate). When set and resolvable it enables the
  classifier-confirmed dedupe (see `dedupe` above) and the auto-refine `gate`.
  When unset or unresolvable, every classifier feature degrades to its
  no-classifier behavior.
- **`virtualBinding`** — how the per-model isolation key treats pi **virtual
  models** (router extensions, pi ≥ 0.99). Default `"virtual"`: the key is
  the selected model's own `provider/id` — a router starts a blank harness.
  `"physical"`: when the selection is virtual, the key is the *physical*
  model behind the latest successful response on the branch — notes
  accumulated under that physical model keep injecting through the router, and
  switching routed models re-scopes exactly like a manual model switch. Before
  the first response the key is unknown: creates stay orphans and are adopted
  on first contact.
- **`outcomeImportance`** — opt-in autonomous **promotion** loop (**off by
  default**). When `enabled`, a `turn_end` hook bumps (+`bump`, default 0.03)
  the importance of any active item the agent cited by its `[h_xxxx]` tag in
  the turn's output. Citations are read from completed turns only — an aborted
  turn's partial text is scanned by the next completed turn (the initial seed
  turn itself is never scanned, as before). Referenced items
  gain importance and get their `updatedAt`
  touched (so they survive time-based decay); ignored items keep decaying. This
  is the package's second opt-in autonomous path — promotion only, never
  deletes, persisted/branchable like `harness_mutate`. Autonomous demotion from
  outcomes is intentionally NOT done (high false-positive); use `/harness drop`,
  `prune --decay`, or the `dedupe` proposer for that.

> **Removed:** the store-wide `durableScope` config key (deprecated 0.9.0,
> removed now). Items carry their own scope (`/harness move`), and durable I/O
> is always layered. Config files that still set the key load fine — unknown
> keys are ignored. Migration from a `durableScope: "project"` setup: run
> `/harness import` once in the project (its file's items adopt project
> scope), then move any strays with `/harness move` (or classify the whole
> store with `/harness split`).

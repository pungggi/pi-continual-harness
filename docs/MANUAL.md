# pi-continual-harness — Manual

**Version 0.8.x · the online self-improvement layer for the [pi](https://pi.dev) coding agent**

This is the complete reference manual for `pi-continual-harness`. It documents
every command, tool, config key, file format, and extension point, plus the
mental model, the safety properties, and day-to-day workflows.

> The [README](../README.md) is the short-form overview. This manual is the
> authoritative, exhaustive reference. The [ROADMAP](ROADMAP.md) records how the
> package got here.

---

## Table of contents

1. [Mental model](#1-mental-model)
2. [Installation](#2-installation)
3. [Quick start](#3-quick-start)
4. [The harness-state store](#4-the-harness-state-store)
5. [Commands](#5-commands)
   - [`/refine`](#refine)
   - [`/harness`](#harness)
6. [Model-facing tools](#6-model-facing-tools)
7. [The durable file format](#7-the-durable-file-format)
8. [Configuration](#8-configuration)
9. [Delta proposers](#9-delta-proposers)
10. [Autonomous features](#10-autonomous-features)
11. [Compositions](#11-compositions)
12. [Safety, audit & rollback](#12-safety-audit--rollback)
13. [Workflows & recipes](#13-workflows--recipes)
14. [Extension API](#14-extension-api)
15. [File & path layout](#15-file--path-layout)
16. [Defaults reference](#16-defaults-reference)
17. [Troubleshooting & FAQ](#17-troubleshooting--faq)

---

## 1. Mental model

`pi-continual-harness` (the "harness" for short) gives the pi agent a
**reset-free, online** optimizer: as you work, the agent can record durable,
reusable corrections — prompt notes, facts, skill descriptions, sub-agent specs —
and have them re-injected into context on later turns.

The design rests on three ideas:

1. **A unified, in-trajectory store.** One store holds four kinds of item. The
   store lives *in the session tree*, not in a database — every mutation is a
   session entry, so navigating the branch tree gives rollback for free.

2. **Structured CRUD deltas, never prose rewrites.** The unit of
   self-improvement is a small, evidence-backed `create` / `update` / `delete`
   delta. This prevents the "brevity bias" and "context collapse" failure modes
   of whole-prompt rewrites. Every `create` requires `evidence` grounding it in
   what actually happened.

3. **Compose, don't reinvent.** The harness owns *online optimization only*. It
   deliberately leaves deep *offline* refinement to **pi-reflect** and durable
   *storage* to **pi-mem**, and talks to each through a **durable markdown
   file**.

### The four components

Each item in the store has one of four kinds (the Continual Harness components):

| Kind | What it holds |
|---|---|
| `prompt` | Supplemental prompt notes — behavioral guidance for the agent. |
| `memory` | Memory facts — specific, durable facts about the project/world. |
| `skill` | Skill descriptions — reusable patterns, not one-task notes. |
| `subagent` | Sub-agent specs — descriptions of reusable sub-agent roles (stored as *data*, no live orchestration). |

### The importance fitness signal

Every item carries an `importance` in `[0, 1]`. Items below the floor
(**0.3**) can be pruned. Importance moves via explicit signals:

- **Up** — `/harness keep <id>` (+0.1), or the opt-in outcome loop (+0.03 by default when the agent cites the item).
- **Down** — `/harness drop <id>` (−0.1), or time-decay via `prune --decay <days>`.
- **Set** — a `harness_mutate` `update`/`create` delta (clamped to `[0,1]`).

### The two persistence layers

| Layer | Where | Lifetime | Purpose |
|---|---|---|---|
| **Session-scoped** (core) | session tree entries of type `harness-state` | the session branch | the authoritative live state; `/tree` rollback works here |
| **Durable** (seam) | `~/.pi/agent/harness-state.md` (or project-scoped) | across sessions | the composition hand-off with pi-reflect / pi-mem |

The session layer is the source of truth at runtime. The durable file is a
**best-effort export/import** that closes the loop with offline tools.

### Model binding (per-model isolation)

Every item carries an `ownerModel` (`"provider/id"`, or `""` for an orphan).
**An item is injected only for the exact model it belongs to**, so a brand-new
model id starts from a blank harness and one model's notes never leak into
another's context. Binding is at the exact id on purpose — a new version is a
clean slate.

- **Stamping.** New items are stamped with the model driving the turn. The
  model-facing tools cannot see the active model, so `before_agent_start`
  caches it (it always fires first in a turn, with the model); `harness_mutate`
  stamps creates from that cache, and direct-apply proposers stamp from
  `ctx.model`.
- **Injection.** `before_agent_start` renders a **selected subset** of the
  items whose `ownerModel` matches the active model — importance-ordered and
  capped per kind + by a token budget, on by default (see
  [§8 → Injection selection](#injection-selection-on-by-default)). An unknown
  model injects nothing.
- **`harness_list`** defaults to the active model's items (`model: "*"` for all,
  or an explicit `"provider/id"`).
- **Orphan adoption.** Items with no owner (legacy snapshots, old durable
  files, or created while the model was unknown) are adopted by the active
  model on first contact — the next `before_agent_start` — and that adoption is
  persisted as a normal `harness-state` entry (branchable via `/tree`). This is
  the migration path: existing harnesses move to per-model isolation with no
  manual steps.
- **Durable round-trip** preserves the owner (a `model:` line per item);
  untagged items import as orphans and are adopted on first contact.

Manual commands (`export`/`import`/`keep`/`drop`/`prune`/`push-mem`/`status`)
operate on the whole store by design; isolation is enforced only where
pollution would leak automatically (injection, listing, create-stamping,
outcome).

---

## 2. Installation

```
pi install npm:pi-continual-harness
```

Or, to run from source, drop `src/index.ts` into `~/.pi/agent/extensions/` (pi
loads raw `.ts` at runtime — there is no build step).

The package ships raw TypeScript; no compilation is needed.

### Verify

```
/harness status        # should report 0 active / 0 total, durable: none
```

---

## 3. Quick start

Three steps to your first self-improvement:

```bash
# 1. install
pi install npm:pi-continual-harness

# 2. work normally for a while, then ask the agent to self-improve
/refine

# 3. (optional) snapshot to the durable file so pi-reflect can edit it offline
/refine --commit
```

After `/refine`, the agent reviews the last 25 turns and proposes
evidence-backed deltas via the `harness_mutate` tool. Accepted items are
injected into the system prompt on the next turn as a structured block, and the
session tree records a rollback point.

---

## 4. The harness-state store

The store (`src/store.ts`) is the heart of the package. It is:

- **Module-scoped and synchronous** — mutations cannot interleave inside a single
  operation.
- **Rebuilt on every `session_start`** from the last `harness-state` snapshot in
  the current branch, so it always tracks the active branch.
- **All-or-nothing per batch** — `applyDeltas` rolls back on any failure.

### The item shape

```ts
interface HarnessItem {
  id: string;          // "h_<base36 time>_<random>", e.g. h_lz3k9p2_a1b2c
  kind: ComponentKind; // "prompt" | "memory" | "skill" | "subagent"
  content: string;     // the note / fact / description / spec text
  evidence: string;    // why this item exists, grounded in the trajectory
  importance: number;  // [0,1] fitness; < 0.3 is prune-eligible
  active: boolean;     // injected into the system prompt when true
  ownerModel: string;  // "provider/id" — only injected for this model ("" = orphan)
  createdAt: number;   // epoch ms
  updatedAt: number;   // epoch ms — touched by bumps/decay; decay proxy
}
```

### The delta shape

The unit of mutation (see [`src/types.ts`](../src/types.ts)):

```ts
type Delta =
  | { op: "create";   kind: ComponentKind; content: string; evidence: string; importance?: number; ownerModel?: string }
  | { op: "update";   id: string; content?: string; evidence?: string; importance?: number; active?: boolean; ownerModel?: string }
  | { op: "delete";   id: string; reason: string };
```

### How state persists in the session

Every mutating operation calls a `persist(snapshot, version)` callback that the
caller supplies. In practice this callback is
`pi.appendEntry("harness-state", { state, version })`, which writes a snapshot
into the session tree. On `session_start`, `reconstruct()` scans the current
branch and takes the **last** `harness-state` snapshot. Because pi's tree
branches at any entry, `/tree` lets you resume from *before* any refinement —
that is the entire rollback mechanism.

---

## 5. Commands

The package registers two commands: `/refine` (the optimizer) and `/harness`
(durable I/O + importance hygiene).

### `/refine`

```
/refine [lookback-turns] [--commit] [--proposer <name>]
```

The online self-improvement command. Reviews recent trajectory evidence and
proposes evidence-backed CRUD deltas.

| Argument | Default | Range / values | Meaning |
|---|---|---|---|
| `lookback-turns` | `25` | `1`–`200` (clamped) | how many recent turns to review |
| `--commit` | off | flag | also export durable state after refining |
| `--proposer <name>` | `steering` | `steering` \| `dedupe` \| any registered name | which [proposer](#9-delta-proposers) runs |

**Flow:**

1. Gathers trajectory evidence from the current branch (recent user+assistant
   messages, capped at **16000 bytes**, truncated if longer).
2. Resolves the proposer (from `--proposer`, else the `proposer` config key,
   else `steering`). **Unknown names fall back to `steering`.**
3. Calls `propose({ evidence, state, lookback })` with a **defensive copy** of
   state (proposers cannot mutate the live store).
4. If the proposer returns `deltas`, they are applied directly (persisted via a
   `harness-state` entry → `/tree` rollback covers them).
5. Writes a `harness-refinement` **audit entry** recording `lookback`, `commit`,
   `source` (`manual`|`auto`), `proposer` (which ran), `applied` (count), and the
   `rationales`.
6. If `--commit`, flushes current state to the durable file first.
7. If the proposer returned a `steeringMessage`, sends it as a user message —
   the agent then reasons and calls `harness_mutate` itself (the default path).

**Examples:**

```
/refine                    # last 25 turns, steering proposer, no durable flush
/refine 50                 # last 50 turns
/refine 25 --commit        # also write ~/.pi/agent/harness-state.md
/refine --proposer dedupe  # rule-based dedupe, no model reasoning
/refine 25 --commit --proposer dedupe
```

> **Why a steering message as the default?** It reuses the existing agent loop
> (no nested/hidden model call), is model-agnostic, and keeps every delta
> visible and reviewable in the transcript. A dedicated-model proposer is
> supported by the interface but intentionally not shipped — hidden model spend
> is a tradeoff kept as a separate decision (see [ROADMAP](ROADMAP.md)).

### `/harness`

```
/harness <subcommand> [args]
```

Durable I/O and importance hygiene. Subcommands:

#### `status [path]`

```
/harness status
/harness status ./some-file.md
```

Reports whole-store active/total counts broken down by kind (status is a
whole-store command), annotated with the active model's share, plus the durable
file's presence and last-modified time. The path defaults to the resolved
durable path (global or project scope); an explicit non-flag argument overrides
it.

#### `export [path]`

```
/harness export
/harness export ./snapshot.md
```

Writes all **active** items to the durable markdown file (see [§7](#7-the-durable-file-format)).
Inactive items are never exported. Returns the count written and the path.

#### `import [--prune] [path]`

```
/harness import
/harness import --prune
/harness import ./snapshot.md --prune
```

Parses a durable markdown file and **merges** it into the live store, then
persists a snapshot. **Merge semantics:**

| Situation | Result |
|---|---|
| Parsed item's `id` matches an existing item | **UPDATE** in place — durable wins on `content`/`evidence`/`importance`; item reactivated; `createdAt` preserved. |
| Parsed item has a new/foreign id | **CREATE** (id kept if it matches `/^h_/`, else a fresh id is generated). |
| Store item absent from the file | **KEPT** by default. With `--prune`: dropped **only if** it was active before the import (inactive items are *always* preserved — they can never have been "deleted" by pi-reflect, since the export never contains them). |

`--prune` therefore makes the file the source of truth: everything active not in
the file is removed. Without it, import is purely additive/reconciliatory.
Returns counts of `imported`, `created`, `updated`, and (with `--prune`) `pruned`.

**Missing file** → warning, no-op (run `/refine --commit` or `/harness export` first).

#### `prune [--decay <days>]`

```
/harness prune               # drop items below the importance floor (0.3)
/harness prune --decay 30    # first age stale items, then prune below floor
```

**Two-phase:** first **ages** importance (if `--decay` given), then **drops**
everything below the floor (`0.3`).

- **Age phase** — every item whose `updatedAt` is older than `<days>` days gets
  `importance -= decayStep` (default **0.1**), clamped to `[0,1]`.
- **Prune phase** — items with `importance < 0.3` after decay are removed.

`updatedAt` is a weak staleness proxy: pair it with explicit `keep`/`drop` for
real signal. Time-since-update rewards both human-curated and outcome-promoted
items (both touch `updatedAt`).

#### `keep <id>`

```
/harness keep h_lz3k9p2_a1b2c
```

Bumps an item's importance **+0.1** (clamped) and touches `updatedAt`. Not found
→ warning.

#### `drop <id>`

```
/harness drop h_lz3k9p2_a1b2c
```

Bumps an item's importance **−0.1** (clamped) and touches `updatedAt`. This
*demotes*; to actually *remove*, follow with `prune` once it falls below the
floor, or use `harness_mutate` `delete`.

#### `push-mem [--all|--kind <kind>|--model <provider/id|active>]`

```
/harness push-mem            # push active MEMORY items to pi-mem
/harness push-mem --all      # push every active item
/harness push-mem --kind skill   # push only skill-kind items
/harness push-mem --all --model anthropic/sonnet  # only one model's items
/harness push-mem --all --model active            # only the active model's items
```

Copies active items into **pi-mem's** semantic memory store by **steering** the
agent to call pi-mem's `save_memory` tool once per item. There is **no
dependency** on pi-mem — if no memory tool is present, the agent tells you to
install it rather than fabricating one. The harness store is **read-only** for a
push (pi-mem gets a separate copy).

Default scope is the `memory` kind (the clean 1:1 mapping); `--all` / `--kind`
override; `--model` scopes to one owner model (default: every model; `active` =
the model driving the command). See [§11](#11-compositions).

---

## 6. Model-facing tools

Two tools are registered for the agent to call (see [`src/tools.ts`](../src/tools.ts)).

### `harness_list`

```
harness_list({ kind?: ComponentKind, model?: string })
```

Reads current state. Omit `kind` for everything, or filter by `prompt` |
`memory` | `skill` | `subagent`. `model` defaults to the **active model's**
items (what gets injected this turn); pass `"*"` for every model, or an
explicit `"provider/id"`. Returns one text line per item:

```
[h_lz3k9p2_a1b2c] (memory, importance 0.62, active, model anthropic/sonnet) <content>
  evidence: <evidence>
```

Always call this before proposing changes so you operate on current state.

### `harness_mutate`

```
harness_mutate({ deltas: Delta[] })   // 1–20 deltas per call
```

Applies a batch of structured CRUD deltas **atomically** (all-or-nothing). Each
`create` requires `evidence`. Prefer many small surgical deltas over wholesale
rewrites.

**Per-model isolation.** The active model is the *actor*: every `create` is
stamped with it, and `update`/`delete` may target only items the active model
owns — a delta aimed at another model's item rolls the whole batch back with a
clear error. (The cross-model maintenance paths — the `dedupe` proposer and
`/harness keep|drop|prune` — pass no actor, so they are unaffected.) When no
model is known (no turn started), `create`s become orphans (adopted next turn)
and `update`/`delete` are unscoped.

**Delta shapes:**

```jsonc
// create
{ "op": "create", "kind": "memory",
  "content": "Deployments require a DB migration step first.",
  "evidence": "User hit migration error twice on 2026-08-08; confirmed in deploy logs.",
  "importance": 0.7 }            // optional, default 0.5

// update (all fields except id and op are optional)
{ "op": "update", "id": "h_lz3k9p2_a1b2c",
  "content": "Updated text", "importance": 0.8, "active": true }

// delete (reason required)
{ "op": "delete", "id": "h_lz3k9p2_a1b2c", "reason": "Superseded by h_x_y." }
```

Returns a summary line plus `details.applied` (the `AppliedDelta[]`) and
`details.version`. Every call persists a `harness-state` snapshot → `/tree`
rollback covers it.

---

## 7. The durable file format

The durable markdown file is the composition seam. `/harness export` writes it;
`/harness import` parses it back. The format is intentionally human-editable and
**tolerant** of pi-reflect's edits.

### Grammar

```
# Continual Harness State

## <Section title>

- **[h_xxx]** (importance 0.62) <content>
  - evidence: <evidence>
  - model: <provider/id>      ← optional; the owner model (omitted for orphans)

## <Section title>
...

_(no active items)_      ← written only when the store is empty
```

### Section titles

Export writes these exact titles; the parser recognizes them and also accepts
loose keyword fallbacks (so pi-reflect's heading edits still parse):

| Kind | Exact export title | Keyword fallback |
|---|---|---|
| `prompt` | `Supplemental prompt notes` | contains `prompt` |
| `memory` | `Memory facts` | contains `memory` |
| `skill` | `Skill descriptions` | contains `skill`/`skills` |
| `subagent` | `Sub-agent specs` | contains `sub-agent`/`subagent` |

### Item bullets

Two bullet forms are recognized on import:

1. **Id bullet** (the export form):
   ```
   - **[h_lz3k9p2_a1b2c]** (importance 0.62) The content text
     - evidence: Why it exists
     - model: provider/id
   ```
   The `model:` line is optional; items without it import as orphans and are
   adopted by the active model on first contact.
2. **Plain bullet** (lenient — for hand-written / pi-reflect-added items):
   ```
   - **[h_xxx]** content here
   - content with no id   (imported as a new item with a generated id)
   ```

The parser skips the placeholder line `_(no active items)_` and ignores bullets
outside any known section. Importance parses from the parenthetical; missing or
non-numeric → `0.5`.

### Two-way loop

```
/refine --commit  ──►  harness-state.md  ──►  /reflect edits it offline
                                                 │
       live store  ◄──  /harness import  ◄───────┘
```

Offline edits **win** on conflict (durable content/evidence/importance replace
the live values). This is what makes pi-reflect refinements flow back online.

---

## 8. Configuration

Optional config at **`~/.pi/agent/harness.json`**. Missing or malformed →
defaults (the loader never throws).

```jsonc
{
  "durableScope": "global",                 // "global" (default) | "project"
  "proposer": "steering",                   // steering | dedupe | <custom>
  "injection":    { "enabled": true, "maxTokens": 1500, "maxPerKind": 10, "charsPerToken": 4 },
  "remindRefine":  { "enabled": false, "everyTurns": 50 },
  "autoRefine":    { "enabled": false, "everyTurns": 100, "commit": false },
  "outcomeImportance": { "enabled": false, "bump": 0.03 }
}
```

### Keys

| Key | Default | Values | Effect |
|---|---|---|---|
| `durableScope` | `"global"` | `"global"` \| `"project"` | Where the durable file lives. See [paths](#15-file--path-layout). |
| `proposer` | `"steering"` | name string | Default proposer for `/refine` and auto-refine. Unknown name → `steering`. |
| `injection.enabled` | `true` | bool | Master switch for the [injection selection policy](#injection-selection-on-by-default). `false` → legacy "all items, in store order". |
| `injection.maxTokens` | `1500` | number > 0 | Total token budget for the rendered block (intro + headers + items). |
| `injection.maxPerKind` | `10` | number > 0 | Max items surfaced per kind (balanced sections). |
| `injection.charsPerToken` | `4` | number > 0 | Token estimate (chars per token) for the budget arithmetic. |
| `remindRefine.enabled` | `false` | bool | Opt-in `/refine` reminder on a cadence (informational, never mutates). |
| `remindRefine.everyTurns` | `50` | int | Reminder cadence. |
| `autoRefine.enabled` | `false` | bool | Opt-in **autonomous** self-refinement. Off by default. |
| `autoRefine.everyTurns` | `100` | int | Auto-refine cadence. |
| `autoRefine.commit` | `false` | bool | Also flush durable state on each auto-refine. |
| `outcomeImportance.enabled` | `false` | bool | Opt-in **autonomous** importance promotion. Off by default. |
| `outcomeImportance.bump` | `0.03` | finite number | Per-reference importance bump. Non-numeric → default (coerced; prevents NaN corruption). |

### Injection selection (on by default)

The harness accumulates notes, but the system prompt is finite — so the block
appended each turn is the result of a **selection policy**, not the whole
store. It is **on by default**; the store itself is never changed by selection
(nothing is lost), only what is *surfaced*.

The policy (pure, deterministic; `src/select.ts`):

1. **Filter** — only active items bound to the active model (per-model
   isolation, unchanged).
2. **Order** — importance desc; ties keep store/insertion order (stable).
3. **Cap** — `maxPerKind` (balanced sections), then `maxTokens` (total budget).
   The budget is filled **round-robin across kinds by importance rank**, so one
   kind cannot starve the others; an item that doesn't fit is **skipped** (not a
   hard stop), so a large item never blocks smaller higher-priority ones.

The defaults (`maxTokens: 1500`, `maxPerKind: 10`) are a **no-op for small
stores** (nothing trimmed) and protective as the harness grows. When the policy
drops items, the block ends with a transparency footer naming the count and how
to raise the ceiling or `/harness prune`.

```json
{ "injection": { "maxTokens": 3000 } }      // raise the ceiling
{ "injection": { "maxPerKind": 5 } }         // trim harder, per kind
{ "injection": { "enabled": false } }        // opt out: legacy "all, in order"
```

Bad numeric values are coerced to the defaults (no `NaN` / no `<= 0` leaks into
the sizing arithmetic). `selectForInjection` is pure and re-exported, so a
companion package can layer a richer policy (e.g. relevance to the current turn)
without touching `inject.ts`.

### Scope resolution

- **`global`** (default, backward compatible) → `~/.pi/agent/harness-state.md`
- **`project`** → `~/.pi/agent/harness-state/<slug>.md`, where `<slug>` is derived
  from the current working directory (path separators → `-`, non-alnum stripped,
  collapsed, lowercased, last 80 chars, fallback `"default"`).

Use `"project"` when different codebases should keep separate harness state for
pi-reflect to refine independently.

### Robustness

- Missing/malformed file → `DEFAULT_CONFIG` (never throws).
- `durableScope` other than `"project"` → treated as `"global"`.
- `outcomeImportance.bump` is **coerced to a finite number** — a string like
  `"0.03"` would otherwise corrupt importance to `NaN` (it is an arithmetic
  operand); non-finite values fall back to the default.
- Unknown keys are ignored.
- Config is **cached** for the process lifetime after first read.

---

## 9. Delta proposers

`/refine` is split into two stages: **propose** (decide what deltas to pursue)
and **apply** (apply returned deltas directly, or send a steering message). The
propose stage is **pluggable** via a registry ([`src/proposer.ts`](../src/proposer.ts)).

### Shipped proposers

| Name | Strategy | Model call? | Select with |
|---|---|---|---|
| `steering` (default) | Delegates reasoning to the agent via a steering message; reuses the agent loop. | No (uses the main loop) | default, or `--proposer steering` |
| `dedupe` | Rule-based: drops near-duplicate **active** items by token Jaccard ≥ **0.6** (same kind **and same owner model** — never across models), keeping the higher-importance one. Greedy, contradiction-free. | No | `--proposer dedupe`, or `"proposer": "dedupe"` |

The `dedupe` proposer orders active items by importance descending; the first is
always a keeper, and each later item is compared only against keepers, so a
keeper is never subsequently dropped. Its `rationale`s (e.g.
`dedupe: "foo…" ≈ keeper "bar…" (Jaccard 0.73); kept higher-importance h_x`)
land in the audit entry.

### Selecting a proposer

- Per run: `/refine --proposer <name>`
- Default (incl. auto-refine): `"proposer": "<name>"` in config
- Unknown name → silently falls back to `steering`

Both the direct-apply path and the steering path are **audited**: the
`harness-refinement` entry records which proposer ran and how many deltas it
applied directly.

### The contract

```ts
interface ProposeInput  { evidence: string; state: HarnessState; lookback: number; }
interface ProposedDelta { delta: Delta; rationale: string; }
interface ProposeResult { deltas?: ProposedDelta[]; steeringMessage?: string; }
interface DeltaProposer { readonly name: string; propose(input: ProposeInput): Promise<ProposeResult>; }
```

- `state` is a **defensive copy** — mutating it has no effect on the live store.
  Return `deltas` to change state.
- A proposer may return **both** `deltas` and a `steeringMessage`; deltas are
  applied first, then the steering message is sent.
- Returning an empty object (`{}`) means "nothing to do".

### Writing a custom proposer

From another extension (the registry is re-exported from the package entry):

```ts
import { registerProposer } from "pi-continual-harness";

registerProposer({
  name: "my-proposer",
  async propose({ evidence, state }) {
    // inspect trajectory evidence + current state; return deltas
    return { deltas: [/* { delta, rationale } */] };
  },
});
```

Then `my-proposer` is selectable via `/refine --proposer my-proposer` or
`"proposer": "my-proposer"`. See [§14](#14-extension-api).

> **A dedicated-model proposer** (a hidden LLM call that returns deltas) is the
> obvious next alternate the interface supports, but is intentionally **not
> shipped** — non-visible model spend is a tradeoff kept as a separate decision.

---

## 10. Autonomous features

Three `turn_end` hooks. **All are opt-in and off by default.** All cadence
counters **reset on `session_start`**, so a forked/resumed session starts from a
fresh baseline.

### Reminder (`src/remind.ts`)

`remindRefine: { enabled, everyTurns }` — informational only.

- Fires every `everyTurns` (default **50**) turns.
- Notifies you to run `/refine`. **Never mutates state.**
- First observed turn seeds the baseline (no reminder on the seed turn).

This is the gentlest option — autonomy without mutation.

### Auto-refine (`src/auto-refine.ts`)

`autoRefine: { enabled, everyTurns, commit }` — **autonomous self-mutation**.

- Fires `/refine` itself every `everyTurns` (default **100**) turns.
- Runs the **exact same `runRefine()`** as manual `/refine` — no parallel
  mutation logic — so it inherits every safety property: structured
  evidence-backed deltas, audited `harness-refinement` entry tagged
  `source: "auto"`, branch-local snapshots, `/tree` rollback.
- **Visible**: notifies before firing; the steering message appears in the
  transcript.
- `commit: true` also flushes durable state on each run.
- First observed turn seeds the baseline (no auto-refine on the seed turn); each
  fired refine resets the counter (so the refine turn can't immediately
  re-trigger).

This is the package's **first** opt-in autonomous-mutation path.

### Outcome-importance loop (`src/outcome.ts`)

`outcomeImportance: { enabled, bump }` — **autonomous importance promotion**.

- Scans **new** assistant output each turn for `[h_xxxx]` citation tags matching
  **active** item ids **owned by the active model** (only that model's items are
  injected, so only those can be cited). A citation is unambiguous *positive*
  evidence the item was useful.
- Bumps each referenced item's importance by **+`bump`** (default **0.03**,
  clamped to `[0,1]`) and touches `updatedAt`, so promoted items survive
  time-based decay.
- Persisted per bump via `harness-state` entries → branch-local, `/tree`
  rollback, visible (notifies per turn).
- **Seeding**: the first observed turn sets the scan cursor (no retroactive bump
  for the whole history). Enabling mid-session is safe.

This is the package's **second** opt-in autonomous-mutation path. It closes the
outcome half of the fitness loop: useful items rise, ignored items keep decaying.

> **Hard scope cut — no autonomous demotion.** Correction/demotion from outcomes
> is genuinely fuzzy and high-false-positive, so it is **intentionally not**
> autonomized. Demotion stays with the audited, reviewable primitives:
> `/harness drop`, `prune --decay`, and the `dedupe` proposer. A fuzzy
> `corrections` proposer is the natural future extension via the registry.

---

## 11. Compositions

### pi-reflect (offline refinement)

[pi-reflect](https://github.com/jo-inc/pi-reflect) does the "deep" path:
offline transcript → behavioral-file refinement. The harness composes via the
durable markdown file, and the loop is **two-way**:

```
/refine --commit   ──►   harness-state.md   ──►   /reflect edits it
                                                       │
   live store     ◄──   /harness import     ◄────────┘
```

```
/reflect ~/.pi/agent/harness-state.md
```

Offline edits **win** on conflict (durable content/evidence/importance replace
live values; `createdAt` preserved). Use `--prune` on import to make the file the
source of truth.

### pi-mem (storage)

[pi-mem](https://github.com/georgebashi/pi-mem) is a durable semantic memory
store (LanceDB + embeddings). `/harness push-mem` copies active items into it:

```
/harness push-mem            # active MEMORY items → pi-mem
/harness push-mem --all      # every active item
/harness push-mem --kind skill
/harness push-mem --all --model active   # only the active model's items
```

The composition works by **steering** the agent to call pi-mem's `save_memory`
tool once per item. There is **no dependency** on pi-mem — if no memory tool is
present, the agent says so rather than fabricating one. The harness store is
**read-only** for a push (pi-mem gets a separate copy).

```bash
pi install npm:pi-mem        # optional companion
```

### What the harness does NOT do

- It does not run pi-reflect for you (point `/reflect` at the file yourself).
- It does not auto-push to pi-mem (push is explicit and reviewable).
- It does not orchestrate sub-agents (sub-agent *specs* are stored as data only).

---

## 12. Safety, audit & rollback

### Core safety properties

1. **Manual by default.** No autonomous mutation unless explicitly opt-in.
2. **Structured, evidence-backed deltas.** Every mutation is a small CRUD delta,
   visible in the transcript; every `create` requires `evidence`.
3. **Branch-local state + `/tree` rollback.** The entire safety net — no bespoke
   snapshot system.
4. **All-or-nothing batches.** `applyDeltas` rolls back on any failure.
5. **Importance clamped to `[0,1]`.** Promotion can never runaway; demotion
   floors at 0.
6. **Importance never silently corrupts.** Config `bump` is coerced to a finite
   number.

### The two autonomous paths

| Feature | What it mutates | Opt-in key | Off by default? |
|---|---|---|---|
| Auto-refine | prompt/memory/skill/subagent items (via deltas) | `autoRefine.enabled` | ✅ |
| Outcome loop | `importance` of cited items (promotion only) | `outcomeImportance.enabled` | ✅ |

Both are persisted via `harness-state` entries (branchable) and both notify
before/when they act.

### Audit trail

Two session entry types:

| Entry type | Written by | Contains |
|---|---|---|
| `harness-state` | every mutation (`harness_mutate`, direct-apply proposers, bumps, prune, import) | `{ state, version }` — a full snapshot |
| `harness-refinement` | every `/refine`/auto-refine | `{ lookback, commit, startedAt, source, proposer, applied, rationales[] }` |

`source` is `"manual"` or `"auto"` so autonomous runs are distinguishable in the
tree.

### How to undo anything

- **Undo a refine / mutation** → `/tree` to the entry before it, resume.
- **Undo an auto-refine** → same; it's a `harness-refinement` + `harness-state`
  pair in the tree.
- **Undo an outcome bump** → `/tree`, or `/harness drop <id>` to nudge it back
  down.
- **Discard everything** → start a fresh session (state is rebuilt from the
  branch).

---

## 13. Workflows & recipes

### A. Daily driver (manual only)

```bash
# work normally; when you notice a recurring correction:
/refine
# periodically snapshot for safety / offline tooling:
/refine --commit
```

No config file needed — everything is off by default.

### B. Periodic deep clean

```bash
/harness prune --decay 30    # age untouched-for-30-days items, drop below floor
/refine --proposer dedupe    # collapse near-duplicates
/refine --commit             # snapshot the cleaned state
```

### C. Project isolation

`~/.pi/agent/harness.json`:
```json
{ "durableScope": "project" }
```
Each project now keeps its own `~/.pi/agent/harness-state/<slug>.md`, so pi-reflect
refines them independently.

### D. Offline round-trip with pi-reflect

```bash
/refine --commit                              # 1. export
/reflect ~/.pi/agent/harness-state.md         # 2. refine offline (edits the file)
# (next session, or now:)
/harness import                               # 3. merge offline edits back in
```

To make the file authoritative (drop active items pi-reflect removed):
```bash
/harness import --prune
```

### E. Persistent memory via pi-mem

```bash
pi install npm:pi-mem
/refine                       # accumulate memory-kind facts
/harness push-mem             # copy them into pi-mem's semantic store
```

### F. Fully autonomous (opt-in, both loops)

`~/.pi/agent/harness.json`:
```json
{
  "autoRefine":       { "enabled": true, "everyTurns": 100, "commit": true },
  "outcomeImportance":{ "enabled": true, "bump": 0.03 }
}
```

The agent now self-refines on a cadence **and** promotes items it actually uses.
Both are `/tree`-rollbackable and visible. Promotion-only — demotion stays manual.

### G. Dedupe-focused refinement

```bash
/refine --proposer dedupe --commit
```

Rule-based, deterministic, no model reasoning — collapses near-duplicates and
records the Jaccard scores in the audit trail.

---

## 14. Extension API

The package re-exports a small public API for other extensions:

```ts
import {
  // delta proposers — see §9
  registerProposer,   // register a named delta proposer
  listProposers,      // list registered proposer names
  type DeltaProposer,
  type ProposeInput,
  type ProposedDelta,
  type ProposeResult,
  // injection selection — see §8 → "Injection selection"
  selectForInjection, // pure: items + ownerKey + cfg → selected subset
  normalizeInjection, // resolve a partial config against the defaults
  estimateTokens,     // chars → rough token count (charsPerToken)
  DEFAULT_INJECTION,  // the shipped defaults (on; 1500 / 10 / 4)
  type InjectionConfig,
  type NormalizedInjection,
  type SelectionResult,
} from "pi-continual-harness";
```

There are two documented extension points: the **proposer registry** and the
**injection selection policy**. Register a proposer from your extension's setup
and it becomes selectable via `/refine --proposer <name>` or the `proposer`
config key (see [§9](#9-delta-proposers)). `selectForInjection` is pure — call
it to inspect what *would* be injected, or layer a richer policy (e.g. relevance
to the current turn) on top (see [§8 → Injection selection](#injection-selection-on-by-default)).

> The store internals (`getState`, `applyDeltas`, `snapshotState`, etc.) are
> *importable* from the source modules but are **not** part of the stable public
> API — they may change between minor versions. If you need a new extension
> point, open an issue.

---

## 15. File & path layout

| Path | What |
|---|---|
| `~/.pi/agent/harness.json` | optional config (see [§8](#8-configuration)) |
| `~/.pi/agent/harness-state.md` | durable file, **global** scope (default) |
| `~/.pi/agent/harness-state/<slug>.md` | durable file, **project** scope |
| session tree, entry type `harness-state` | authoritative live state snapshots |
| session tree, entry type `harness-refinement` | refine audit entries |

`~` is your home directory. On Windows, `%USERPROFILE%\.pi\agent\...`.

---

## 16. Defaults reference

| Constant | Value | Where |
|---|---|---|
| Importance floor (prune threshold) | `0.3` | `store.ts` `IMPORTANCE_FLOOR` |
| Default lookback turns | `25` (clamped `1`–`200`) | `refine.ts` `DEFAULT_LOOKBACK_TURNS` |
| Evidence byte cap | `16000` | `refine.ts` `DEFAULT_EVIDENCE_BYTES` |
| `keep` / `drop` nudge | `±0.1` | `harness.ts` |
| Decay step | `0.1` per aging pass | `store.ts` `decayAndPrune` |
| Reminder cadence | `50` turns | `config.ts` `DEFAULT_EVERY_TURNS` |
| Auto-refine cadence | `100` turns | `config.ts` `DEFAULT_AUTO_EVERY_TURNS` |
| Outcome bump | `0.03` per reference | `config.ts` `DEFAULT_REF_BUMP` |
| Injection enabled | `true` (on by default; opt-out) | `select.ts` `DEFAULT_INJECTION` |
| Injection token budget | `1500` | `select.ts` `DEFAULT_INJECTION.maxTokens` |
| Injection per-kind cap | `10` | `select.ts` `DEFAULT_INJECTION.maxPerKind` |
| Injection chars/token | `4` | `select.ts` `DEFAULT_INJECTION.charsPerToken` |
| Dedupe threshold | `0.6` Jaccard | `proposer.ts` `DEDUPE_THRESHOLD` |
| `harness_mutate` batch size | `1`–`20` deltas | `tools.ts` |
| Default create importance | `0.5` | `store.ts` `applyOne` |
| Item id format | `h_<base36 ms>_<5-char random>` | `store.ts` `genId` |

---

## 17. Troubleshooting & FAQ

**`/harness status` says "Durable: none at …"**
You haven't exported yet. Run `/refine --commit` or `/harness export`.

**`/harness import` says "No durable file at …"**
Same cause — export first. Or point import at an explicit path.

**I enabled `outcomeImportance` and nothing happened on the first turn.**
By design — the first observed turn seeds the scan cursor (no retroactive bump
for the whole history). Citations on *subsequent* turns bump importance.

**My `bump` in config isn't being applied.**
It must be a **finite number**. `"bump": "0.03"` (a string) is coerced to the
default — this is deliberate: a string would otherwise corrupt importance to
`NaN` (it is an arithmetic operand). Use `"bump": 0.03` (no quotes).

**A `--proposer` name I typed did nothing different.**
Unknown proposer names silently fall back to `steering`. Check
`listProposers()` or that your custom proposer was registered before `/refine`
ran.

**Auto-refine isn't firing.**
Check `autoRefine.enabled` is `true` and that enough turns have elapsed: the
first observed turn after enabling seeds the baseline (no fire then), and the
first fire comes `everyTurns` turns later (e.g. turn 100 if seeded at turn 0
with `everyTurns: 100`). Counters reset on `session_start`, so a fork/resume
restarts the cadence.

**How do I completely reset the harness?**
State is session-scoped. Start a fresh session, or `/tree` to before any
harness-state entry. The durable file can be deleted manually if you also want
to clear the offline copy.

**Does auto-refine make hidden model calls?**
No. The default `steering` proposer reuses the main agent loop via a steering
message — the reasoning is visible in the transcript. A dedicated-model variant
is supported by the interface but intentionally not shipped.

**Can demotion be automated from outcomes?**
Not directly — it's high-false-positive, so it's intentionally manual. Use
`/harness drop`, `prune --decay`, or the `dedupe` proposer. A fuzzy `corrections`
proposer is the planned future extension.

**Is the store thread-safe?**
Mutations are synchronous and cannot interleave inside a single operation.
`applyDeltas` is all-or-nothing.

**What's the difference between the injected block and the durable file?**
The injected block (system prompt, each turn) is a **bounded, importance-selected
subset** of the live active state (see
[§8 → Injection selection](#injection-selection-on-by-default)); the durable file
is a **best-effort export of *all* active items** for offline tools. They can
briefly diverge if you edit the file by hand — run `/harness import` to reconcile.

---

*License: MIT. See the [README](../README.md) for the research grounding and
the [ROADMAP](ROADMAP.md) for implementation history.*

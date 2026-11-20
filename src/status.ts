// `/harness status` report builder (issue #20) — a three-band read-only report:
//
//   1. Impact summary, DERIVED from the session branch's audit trail
//      (`harness-state` snapshots + `harness-refinement` entries) by reusing
//      corpus.ts's lifecycle classification — no new persisted state.
//   2. Injection stats for this session (surfaced items + budget utilization,
//      recorded at render time in inject.ts).
//   3. Zero-state guidance (0 active items → actionable first steps) and a
//      rotating one-line feature hint (src/hints.ts).
//
// buildStatusReport is PURE: state + branch entries + options in, report out.
// handleStatus (harness.ts) stays thin glue: config load, the durable-layer
// stat() I/O, hint selection, one ctx.ui.notify.

import { classifyTransition, parseDedupeDelete, walkAuditTrail } from "./corpus.js";
import { DEFAULT_REF_BUMP, type HarnessConfig } from "./config.js";
import { isOnTrial } from "./decay.js";
import { autoRunnable } from "./checks.js";
import type { InjectionStats } from "./inject.js";
import type { StatusHint } from "./hints.js";
import type { ComponentKind, HarnessState } from "./types.js";

/** Impact of the audit trail. Lifecycle counters come from consecutive
 *  `harness-state` snapshot diffs (classifyTransition); run/merge/update
 *  counters from `harness-refinement` entries. Lifecycle events and
 *  direct-apply update/merge ops are owner-attributed (the per-model view);
 *  run counts are whole-store only (a run is not model-attributed). */
export interface ImpactCounts {
  /** /refine runs by source (manual vs the opt-in turn_end auto-refine). */
  manualRuns: number;
  autoRuns: number;
  /** Items that appeared in a snapshot (any path: /refine, harness_mutate, import). */
  created: number;
  /** Direct-apply update ops in audited refine entries (proposer batches).
   *  Steering-path content edits do not change importance, so snapshot diffs
   *  cannot see them — this counter is a lower bound. */
  updated: number;
  /** Items removed at/above the importance floor (explicit deletes,
   *  delete-only dedupe). */
  deleted: number;
  /** Items removed below the importance floor (prune). */
  pruned: number;
  /** /harness keep bumps (+0.1 transitions). */
  kept: number;
  /** /harness drop bumps (−0.1 transitions). Decay uses the same −0.1 step,
   *  so decayed-but-surviving items are counted here — indistinguishable in
   *  snapshot diffs by design. */
  dropped: number;
  /** Outcome-loop promotions: citation bumps applied (config-aware magnitude). */
  cited: number;
  /** Dedupe merges (delete reason "merged into h_…"). */
  merged: number;
}

function emptyImpact(): ImpactCounts {
  return {
    manualRuns: 0,
    autoRuns: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    pruned: 0,
    kept: 0,
    dropped: 0,
    cited: 0,
    merged: 0,
  };
}

/** Aggregate the audit trail (via the shared walkAuditTrail in corpus.ts)
 *  into whole-store impact plus per-owner lifecycle counts (the per-model
 *  annotation mirrors the counts band). Pure. */
function aggregateImpact(
  entries: Iterable<unknown>,
  citeBump: number,
): { whole: ImpactCounts; byOwner: Map<string, ImpactCounts> } {
  const whole = emptyImpact();
  const byOwner = new Map<string, ImpactCounts>();
  const owner = (key: string): ImpactCounts => {
    let c = byOwner.get(key);
    if (!c) {
      c = emptyImpact();
      byOwner.set(key, c);
    }
    return c;
  };

  walkAuditTrail(entries, {
    onTransition: (prev, next) => {
      for (const t of classifyTransition(prev, next, citeBump)) {
        const key = t.item.ownerModel || "(orphan)";
        const o = owner(key);
        // A switch (not if/else): a future LifecycleEvent falls to default
        // and is NOT counted as a delete — the old trailing `else` would have
        // silently mislabeled it (review simplification #5).
        switch (t.event) {
          case "created":
            whole.created += 1;
            o.created += 1;
            break;
          case "kept":
            whole.kept += 1;
            o.kept += 1;
            break;
          case "dropped":
            whole.dropped += 1;
            o.dropped += 1;
            break;
          case "cited":
            whole.cited += 1;
            o.cited += 1;
            break;
          case "pruned":
            whole.pruned += 1;
            o.pruned += 1;
            break;
          case "deleted":
            whole.deleted += 1;
            o.deleted += 1;
            break;
          default:
            break; // unknown future event: ignore, never mislabel
        }
      }
    },
    onRefine: (step) => {
      if (step.source === "auto") whole.autoRuns += 1;
      else whole.manualRuns += 1; // manual by default (legacy entries predate `source`)
      // Owner attribution for direct-apply ops (review #27): at an audit entry
      // the last snapshot is the post-run state and the one before it is
      // pre-run — an update target lives post-run; a merged duplicate only
      // pre-run. Dedupe plans same-owner pairs, so either lookup attributes
      // the same model.
      const ownerOf = (id: string): string | undefined => {
        const item =
          step.current?.items.find((i) => i.id === id) ?? step.pre?.items.find((i) => i.id === id);
        return item ? item.ownerModel || "(orphan)" : undefined;
      };
      for (const d of step.appliedDeltas as Array<{ op?: string; id?: string; reason?: string }>) {
        if (!d || typeof d !== "object") continue;
        if (d.op === "update") {
          whole.updated += 1;
          const key = d.id ? ownerOf(d.id) : undefined;
          if (key !== undefined) owner(key).updated += 1;
        }
        if (d.op === "delete" && typeof d.reason === "string") {
          const parsed = parseDedupeDelete(d.reason);
          // "merged into h_…" = the keeper's evidence was unioned; the bare
          // "near-duplicate of" delete is a plain delete, not a merge.
          if (parsed && d.reason.startsWith("merged into")) {
            whole.merged += 1;
            const key = (d.id ? ownerOf(d.id) : undefined) ?? ownerOf(parsed.keeperId);
            if (key !== undefined) owner(key).merged += 1;
          }
        }
      }
    },
  });
  return { whole, byOwner };
}

/** Options for buildStatusReport. */
export interface StatusOptions {
  /** Active model key ("provider/id"); undefined when no model is known. */
  modelKey?: string;
  /** Resolved harness config — drives the citation-bump classification and
   *  the contextual hints (classifier, outcomeImportance, remindRefine). */
  config: HarnessConfig;
  /** Session injection stats (inject.ts); undefined before the first render. */
  injection?: InjectionStats;
}

/** The full /harness status report, all bands, pre-render. */
export interface StatusReport {
  active: number;
  total: number;
  perKind: Record<ComponentKind, number>;
  scopeGlobal: number;
  scopeProject: number;
  /** Active-model annotation: this model's active count + distinct owners. */
  model: { mine: number; models: number; key?: string };
  /** Whole-store audit-trail impact (band 1). */
  impact: ImpactCounts;
  /** Events and direct-apply ops attributed to the active model's items,
   *  when a model key is known. */
  modelImpact?: ImpactCounts;
  /** Injection stats for this session (band 2), when a render happened. */
  injection?: InjectionStats;
  /** Count of active on-trial items (unverified, no support yet) — the
   *  self-grown share of the store that trial decay bounds. */
  trial: number;
  /** Active items carrying a `check` command + latest verdicts (the
   *  verification surface, 0.24.0). Undefined when nothing carries a check. */
  verification?: {
    withCheck: number;
    /** Trusted (auto-runnable at refine time); the rest run only via the
     *  explicit `/harness check`. */
    autoRunnable: number;
    /** Items whose latest check FAILED — flagged, never auto-deleted. */
    failing: number;
  };
  /** Active items re-learned >= 2 times after deletion (graduation
   *  candidates — see tombstones.ts). */
  recurring: number;
  /** Applicable hints in stable priority order; the caller picks one
   *  (rotation lives in hints.ts — keeps this builder pure). */
  hints: StatusHint[];
  /** Present when 0 active items: actionable first steps (band 3). */
  zeroState?: string[];
}

/** Contextual hints for the current store/config/impact (see hints.ts). */
function applicableHints(
  state: HarnessState,
  config: HarnessConfig,
  impact: ImpactCounts,
): StatusHint[] {
  const hints: StatusHint[] = [];
  const active = state.items.filter((i) => i.active);
  // Classifier/gate not fully configured → the cheapest activation lever is
  // invisible to the user. `classifier.model` ALONE changes nothing gating-wise
  // (the gate needs `autoRefine.gate: true` too — review #27), so the hint
  // stays until the gate is on and the copy names the keys. Since auto-
  // discovery (0.22.0) a classifier may resolve with `classifier.model` unset
  // (hosted default on pi ≥ 1.5.1 + Copilot auth), so the copy treats the
  // model as optional.
  if (
    config.autoRefine?.gate !== true ||
    (!config.classifier?.model && config.classifier?.auto === false)
  ) {
    hints.push({
      id: "classifier-gate",
      text: 'the auto-refine gate is available: set `autoRefine: { "gate": true }` in harness.json so cadenced refines skip when nothing durable happened (a classifier resolves automatically on pi ≥ 1.5.1 with GitHub Copilot; otherwise also set `classifier.model`)',
    });
  }
  // Zero citations ever and the loop is off → the outcome half of the fitness
  // loop never runs for this user.
  if (impact.cited === 0 && !config.outcomeImportance?.enabled) {
    hints.push({
      id: "outcome-loop",
      text: "the outcome loop promotes items you cite by their `[h_xxxx]` tag — opt in via `outcomeImportance` in harness.json",
    });
  }
  // Memory items present → the pi-mem composition is one command away.
  if (active.some((i) => i.kind === "memory")) {
    hints.push({
      id: "push-mem",
      text: "`/harness push-mem` copies these memory items to pi-mem so they outlive the harness",
    });
  }
  // Reminder off → the /refine habit has no support (companion nudge of #19).
  if (!config.remindRefine?.enabled) {
    hints.push({
      id: "remind-refine",
      text: "a periodic nudge to run `/refine` is one key away: set `remindRefine.enabled: true` in harness.json",
    });
  }
  // Mixed durable scopes → /harness split classifies the whole store at once.
  if (active.some((i) => i.scope === "project") && active.some((i) => i.scope !== "project")) {
    hints.push({
      id: "split-scopes",
      text: "`/harness split` classifies items global vs project in one audited batch",
    });
  }
  // On-trial items exist but the automatic pass is off → they only ever leave
  // via manual pruning. The unverified share is the "self-grown state" budget
  // the trial-decay loop exists to bound.
  if (active.some((i) => isOnTrial(i)) && config.trialDecay?.enabled !== true) {
    hints.push({
      id: "trial-decay",
      text: `${active.filter((i) => isOnTrial(i)).length} active item(s) are unverified with no support yet — set \`trialDecay: { "enabled": true }\` in harness.json so stale ones decay and expire instead of accumulating`,
    });
  }
  // Recurring corrections without a check → the graduation nudge: prose that
  // keeps coming back wants to become a deterministic command.
  const recurringNoCheck = active.filter((i) => (i.support?.recreates ?? 0) >= 2 && !i.check);
  if (recurringNoCheck.length > 0) {
    hints.push({
      id: "graduate-check",
      text: `${recurringNoCheck.length} recurring correction(s) (deleted before, re-learned) carry no \`check\` command — attach one (a test selector or grep) so the correction verifies itself instead of riding the prompt forever`,
    });
  }
  return hints;
}

/** First steps for an empty (0 active) store — never bare zeros. */
function zeroStateGuidance(total: number): string[] {
  const lines = [
    "No active items yet. First steps:",
    "- Run `/refine` after a working session to capture your first lessons (evidence-backed, reviewable).",
    "- See the Quick start (§3) of the MANUAL — docs/MANUAL.md in the pi-continual-harness repo — for the three-step loop.",
  ];
  if (total > 0)
    lines.push(`- ${total} inactive item(s) exist — restore or prune them via /harness.`);
  return lines;
}

/**
 * Build the full status report from the store snapshot and the session
 * branch's audit trail. Pure: no I/O, no module state, no mutation.
 */
export function buildStatusReport(
  state: HarnessState,
  branchEntries: Iterable<unknown>,
  opts: StatusOptions,
): StatusReport {
  const items = state.items;
  const active = items.filter((i) => i.active);
  const perKind: Record<ComponentKind, number> = { prompt: 0, memory: 0, skill: 0, subagent: 0 };
  for (const i of active) perKind[i.kind] += 1;
  const scopeProject = active.filter((i) => i.scope === "project").length;
  const withCheck = active.filter((i) => i.check);
  const owners = [...new Set(active.map((i) => i.ownerModel).filter(Boolean))];
  const mine = opts.modelKey
    ? active.filter((i) => i.ownerModel === opts.modelKey).length
    : active.length;

  const citeBump = opts.config.outcomeImportance?.bump ?? DEFAULT_REF_BUMP;
  const { whole, byOwner } = aggregateImpact(branchEntries, citeBump);

  return {
    active: active.length,
    total: items.length,
    perKind,
    scopeGlobal: active.length - scopeProject,
    scopeProject,
    model: { mine, models: owners.length, ...(opts.modelKey ? { key: opts.modelKey } : {}) },
    impact: whole,
    ...(opts.modelKey ? { modelImpact: byOwner.get(opts.modelKey) ?? emptyImpact() } : {}),
    ...(opts.injection ? { injection: opts.injection } : {}),
    trial: active.filter((i) => isOnTrial(i)).length,
    ...(withCheck.length > 0
      ? {
          verification: {
            withCheck: withCheck.length,
            autoRunnable: withCheck.filter(autoRunnable).length,
            failing: withCheck.filter(
              (i) => (i.support?.fails ?? 0) > 0 && i.support?.lastCheckOk === false,
            ).length,
          },
        }
      : {}),
    recurring: active.filter((i) => (i.support?.recreates ?? 0) >= 2).length,
    hints: applicableHints(state, opts.config, whole),
    ...(active.length === 0 ? { zeroState: zeroStateGuidance(items.length) } : {}),
  };
}

function impactLine(c: ImpactCounts): string {
  const parts = [
    `created ${c.created}`,
    `updated ${c.updated}`,
    `kept ${c.kept}`,
    `cited ${c.cited}`,
  ];
  if (c.dropped || c.pruned || c.deleted || c.merged) {
    parts.push(
      `dropped ${c.dropped}`,
      `pruned ${c.pruned}`,
      `deleted ${c.deleted}`,
      `merged ${c.merged}`,
    );
  }
  return parts.join(", ");
}

/** Render the report as the single notify string. `durable` is the
 *  durable-layers line (I/O belongs to the caller); `hint` the picked
 *  one-liner (rotation lives in hints.ts). */
export function renderStatusReport(
  r: StatusReport,
  extra: { durable: string; hint?: StatusHint },
): string {
  const lines: string[] = [];
  lines.push(
    `Harness: ${r.active} active / ${r.total} total — ` +
      `prompt ${r.perKind.prompt}, memory ${r.perKind.memory}, skill ${r.perKind.skill}, subagent ${r.perKind.subagent}` +
      ` — scope ${r.scopeGlobal} global / ${r.scopeProject} project.` +
      (r.model.key
        ? ` ${r.model.mine} active for [${r.model.key}] across ${r.model.models} model(s).`
        : ""),
  );
  if (r.zeroState) lines.push(...r.zeroState);
  // Band 1 — impact (derived from the audit trail; nothing persisted).
  const runs = [r.impact.manualRuns + r.impact.autoRuns, r.impact.manualRuns, r.impact.autoRuns];
  lines.push(
    `Impact: ${runs[0]} refine run(s) (${runs[1]} manual, ${runs[2]} auto) — ${impactLine(r.impact)}.`,
  );
  if (r.modelImpact) lines.push(`For [${r.model.key}]: ${impactLine(r.modelImpact)}.`);
  // Band 2 — injection stats for this session.
  if (r.injection && r.injection.renders > 0) {
    const inj = r.injection;
    const budget = `~${inj.lastTokens}/${inj.maxTokens} tokens`;
    const agent =
      inj.agentSurfaced > 0 ? `, ${inj.agentSurfaced} of them agent-authored (unverified)` : "";
    const omitted = inj.omitted > 0 ? `, ${inj.omitted} omitted by selection` : "";
    lines.push(
      `Injection: ${inj.renders} render(s) this session, ${inj.surfaced} item(s) surfaced (${budget}${agent}${omitted}).`,
    );
  }
  // Trial band — the self-grown share (between bands 2 and 3): how many
  // active items are unverified with no support yet, and what bounds them.
  if (r.trial > 0) {
    lines.push(
      `Trial: ${r.trial} active item(s) unverified with no support yet — they decay toward expiry only while \`trialDecay\` is enabled; \`/harness keep <id>\` confirms one now.`,
    );
  }
  // Verification band (0.24.0): the deterministic-check surface.
  if (r.verification) {
    const v = r.verification;
    lines.push(
      v.failing > 0
        ? `Checks: ${v.failing} of ${v.withCheck} check-carrying item(s) FAILING — fix the root cause or rewrite the item; \`/harness check\` re-runs, the refine digest flags them.`
        : `Checks: ${v.withCheck} item(s) carry verification commands (${v.autoRunnable} trusted → auto-run at /refine while \`checks.enabled\`) — all passing.`,
    );
  }
  if (r.recurring > 0) {
    lines.push(
      `Recurring: ${r.recurring} correction(s) deleted and re-learned — graduate them into \`check\` commands instead of re-storing prose (see the digest's Recurring section).`,
    );
  }
  // Band 3 — the rotating one-line hint.
  if (extra.hint) lines.push(`Hint: ${extra.hint.text}`);
  lines.push(extra.durable);
  return lines.join("\n");
}

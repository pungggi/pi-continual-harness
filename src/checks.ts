// Deterministic checks — the graduation path from prose to code (0.24.0).
//
// THE IDEA (Potato Pyramid lesson): an agent's correction stored as prose must
// be re-read, re-trusted, and re-injected every turn, and nothing verifies it
// still holds. A `check` command turns the correction into a falsifiable
// claim: exit 0 = the lesson holds (EARNED support — the item leaves the
// trial queue exactly like a citation or keep); non-zero = it does not (the
// item is flagged in the digest and /harness status; nothing is deleted —
// a failing check tells the improver to REWRITE or graduate the item, and
// the human what to fix at the root).
//
// TRUST BOUNDARY (mirrors provenance): a check is EXECUTABLE content, so the
// auto-run path is trusted-only — items whose provenance is owner/absent.
// An agent can PROPOSE a check (deltas carry `check`), but writing one from
// an agent surface flips the item to agent-authored (store.applyOne), so an
// agent-authored command never executes without an explicit human action:
//   - `/harness check [id]` runs any item's check on demand (this file), and
//   - the durable file is the owner surface: hand-writing a `check:` line
//     (or trusting the item by removing its provenance line) opts the
//     command into the auto-run path.
//
// RUN TIMING (chosen design): /refine time — manual refines and the gated
// opt-in auto-refine run due checks BEFORE the lessons digest is built, so
// the proposer sees fresh pass/fail signals in the same prompt. Bounded:
// at most `checks.maxPerRun` commands (never-checked first, then
// oldest-checked), each under `checks.timeoutMs`. Off by default
// (`checks.enabled: true` in harness.json opts in) — the runner spawns
// subprocesses, so it follows the package's opt-in rule for autonomous
// effects, exactly like trial decay and the outcome loop.

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { getState, makePersist, recordCheckResults } from "./store.js";
import type { HarnessItem } from "./types.js";

const execAsync = promisify(exec);

/** One check execution outcome. `detail` is a bounded tail of the command's
 *  output, for notifications only (never stored). */
export interface CheckResult {
  id: string;
  ok: boolean;
  /** Trimmed stdout/stderr tail (bounded), when there was output. */
  detail?: string;
  /** Wall time in ms. */
  durationMs: number;
}

/** True when the item's check may run AUTOMATICALLY: active, has a check,
 *  and trusted (owner/absent provenance). Agent-authored checks need the
 *  explicit /harness check command — see the module header. */
export function autoRunnable(item: HarnessItem): boolean {
  return Boolean(item.active && item.check && item.provenance !== "agent");
}

/** Plan one run: auto-runnable items, never-checked first then oldest
 *  lastCheckAt first (stale verdicts refresh first), capped at maxPerRun.
 *  Pure. */
export function planCheckRun(items: HarnessItem[], maxPerRun: number): HarnessItem[] {
  return items
    .filter(autoRunnable)
    .map((item, idx) => [item, idx] as const)
    .sort(
      (a, b) =>
        (a[0].support?.lastCheckAt ?? 0) - (b[0].support?.lastCheckAt ?? 0) || a[1] - b[1],
    )
    .map(([item]) => item)
    .slice(0, Math.max(0, maxPerRun));
}

/** Execute one check command. Exit 0 → ok; anything else (non-zero exit,\n *  spawn error, timeout) → not ok, with a bounded detail tail. The timeout\n *  is enforced by the OS kill (child_process timeout), so a hung command\n *  cannot stall the refine. */
export async function runOneCheck(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<Omit<CheckResult, "id">> {
  const started = Date.now();
  try {
    await execAsync(cmd, {
      cwd,
      timeout: Math.max(1000, timeoutMs),
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    return { ok: true, durationMs: Date.now() - started };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
    const tail = (e.stderr || e.stdout || e.message || "").toString().replace(/\s+/g, " ").trim();
    return {
      ok: false,
      durationMs: Date.now() - started,
      ...(tail ? { detail: tail.slice(-160) } : {}),
    };
  }
}

/** Execute a planned list, record outcomes as support (one persist), and\n *  summarize. `pi` persists via the same harness-state entries as every\n *  mutation, so check outcomes are /tree-rollback-able like the rest. */
export async function runChecks(
  pi: ExtensionAPI,
  cwd: string,
  planned: HarnessItem[],
  timeoutMs: number,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const item of planned) {
    const r = await runOneCheck(item.check!, cwd, timeoutMs);
    results.push({ id: item.id, ...r });
  }
  if (results.length > 0) recordCheckResults(results.map(({ id, ok }) => ({ id, ok })), makePersist(pi));
  return results;
}

/** Summarize results for a notify; undefined when there is nothing to say. */
export function summarizeChecks(results: CheckResult[]): string | undefined {
  if (results.length === 0) return undefined;
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const parts: string[] = [];
  if (passed.length > 0) parts.push(`${passed.length} passed`);
  if (failed.length > 0) {
    parts.push(
      `${failed.length} failed: ${failed.map((r) => `[${r.id}]${r.detail ? ` (${r.detail})` : ""}`).join(", ")}`,
    );
  }
  return `Checks: ${parts.join(", ")}. Passing checks count as earned support; failing items are flagged in /harness status and the refine digest — fix the root cause or rewrite the item.`;
}

/** /refine hook: run due trusted checks (when `checks.enabled`), BEFORE the\n *  lessons digest is built — pass/fail lands in support counters, so the\n *  steering prompt sees fresh verdicts without any plumbing of its own. */
export async function handleRefineChecks(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<CheckResult[]> {
  const config = await loadConfig();
  if (config.checks?.enabled !== true) return [];
  const planned = planCheckRun(getState().items, config.checks?.maxPerRun ?? 10);
  if (planned.length === 0) return [];
  const timeoutMs = config.checks?.timeoutMs ?? 20_000;
  const results = await runChecks(pi, ctx.cwd, planned, timeoutMs);
  const summary = summarizeChecks(results);
  if (summary) ctx.ui.notify(summary, results.every((r) => r.ok) ? "info" : "warning");
  return results;
}

/** `/harness check [id]` — the EXPLICIT runner. Runs one item's check by id\n *  (any trust class: this is a human action, so agent-authored commands are\n *  allowed and their outcomes still count as support), or every item that\n *  carries a check when no id is given. Bounded by the same timeout; ignores\n *  `checks.enabled` (an explicit command is the opt-in). */
export async function runHarnessCheck(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const config = await loadConfig();
  const timeoutMs = config.checks?.timeoutMs ?? 20_000;
  const all = getState().items.filter((i) => i.active && i.check);
  if (all.length === 0 && rest.length === 0) {
    ctx.ui.notify(
      "No items carry a check yet. Add one via a harness_mutate update (`check` field) — e.g. `npm run typecheck` or a grep that pins the correction — then re-run.",
      "info",
    );
    return;
  }
  let planned: HarnessItem[];
  if (rest.length > 0) {
    const id = rest[0]!;
    const item = getState().items.find((i) => i.id === id || i.id === id.toLowerCase());
    if (!item) {
      ctx.ui.notify(`/harness check: no item with id ${id}.`, "warning");
      return;
    }
    if (!item.check) {
      ctx.ui.notify(
        `/harness check: [${item.id}] carries no check — set one via a harness_mutate update first.`,
        "warning",
      );
      return;
    }
    planned = [item];
  } else {
    planned = all;
  }
  const results = await runChecks(pi, ctx.cwd, planned, timeoutMs);
  const lines = results.map(
    (r) =>
      `[${r.id}] ${r.ok ? "ok" : "FAILED"} (${(r.durationMs / 1000).toFixed(1)}s)${r.detail ? ` — ${r.detail}` : ""}`,
  );
  ctx.ui.notify(`Check run: ${results.length} command(s)\n${lines.join("\n")}`, results.every((r) => r.ok) ? "info" : "warning");
}

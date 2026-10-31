// /harness setup — the guided configuration wizard (issue #22).
//
// Every opt-in feature (autoImport, gate, autoRefine, cadences, the import
// reminders) is normally enabled by hand-editing ~/.pi/agent/harness.json
// with exact key spellings from the MANUAL. That friction blocks activation,
// so this module replaces it with:
//
//   /harness setup                          interactive wizard
//   /harness setup --preset recommended     scripted preset (still confirms)
//   /harness setup --preset power --yes     scripted consent: no prompts
//
// The flow: show the current effective config + durable-layer paths, choose
// one of three presets (pure data, values derived from DEFAULT_CONFIG so the
// wizard cannot drift from the loader), confirm each delta the preset implies
// (autonomous switches get their own explicit confirm with a safety note),
// review the final diff + JSON, then ONE write through saveConfig (backup +
// atomic write + reload through the coercion path).
//
// Safety properties (issue constraints):
//  - Config-file writes ONLY: never touches harness state, never appends
//    entries, no durable-layer writes, no network.
//  - Autonomous mutation switches (autoImport, autoRefine.enabled,
//    outcomeImportance.enabled) require their own explicit confirm step
//    regardless of preset. `--yes` is the scripted equivalent of that consent
//    and skips every prompt — documented on the flag itself.
//  - No write on: unknown preset / missing --preset value, cancelling the
//    preset menu, or declining the final write. Declining an INDIVIDUAL
//    feature only skips that feature — the remaining deltas still apply
//    (that is what the per-feature loop is for); the final diff + JSON
//    preview always shows exactly what will land.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  deepMergeConfig,
  isPlainObject,
  loadConfig,
  projectDurablePath,
  readConfigRaw,
  saveConfig,
  type HarnessConfig,
} from "./config.js";
import { DEFAULT_DURABLE_PATH } from "./store.js";

export type PresetName = "quiet" | "recommended" | "power";

/** One config change a preset implies. Pure data — no I/O, no state. */
export interface PresetDelta {
  /** Dotted config path, e.g. "autoImport" or "importRemind.enabled". */
  path: string;
  /** Target value (JSON-representable). */
  value: unknown;
  /** One-line rationale shown in the confirm loop. */
  rationale: string;
  /** Safety note for autonomous switches (shown with their own confirm). */
  safety?: string;
  /** Autonomous mutation switch: gets its own explicit confirm regardless of
   *  preset. */
  autonomous?: boolean;
}

/** A named bundle of config deltas. Pure data. */
export interface Preset {
  name: PresetName;
  /** One-line summary for menus. */
  title: string;
  /** Shown before anything is applied. */
  description: string;
  /** Non-delta notes displayed with the diff (e.g. gate readiness). */
  notes: string[];
  deltas: PresetDelta[];
}

/** Defensive deep copy so preset data can never alias (nor mutate)
 *  DEFAULT_CONFIG — preset objects must stay inert snapshots. */
function clone<T>(v: T): T {
  return structuredClone(v);
}

/** The deltas "recommended" implies (also the base of "power"). Values are
 *  derived from the config module, never hardcoded — e.g. #19 changed what
 *  the importRemind default IS and this must not drift from it. */
function recommendedDeltas(): PresetDelta[] {
  return [
    {
      path: "autoImport",
      value: true,
      rationale:
        "Durable sync: refinements survive into new sessions (session_start layered import + turn_end layered export when the store changed).",
      safety:
        "This lets the harness write durable state files on a cadence (turn_end auto-export) — autonomous file mutation. " +
        "Every run is visible (one notify line) and /tree-rollback-able.",
      autonomous: true,
    },
    {
      path: "importRemind",
      value: clone(DEFAULT_CONFIG.importRemind),
      rationale: `Awareness reminders for the sync: the start-of-session import lists what arrived; a bounded cadence (default every ${DEFAULT_CONFIG.importRemind?.everyTurns} turns) re-surfaces it.`,
    },
    {
      path: "remindRefine",
      value: clone(DEFAULT_CONFIG.remindRefine),
      rationale: `Activation nudge (on by default since #19): every ${DEFAULT_CONFIG.remindRefine?.everyTurns} completed turns a one-line /refine reminder, escalating to a rotating educational guide every ${DEFAULT_CONFIG.remindRefine?.detailEvery}th reminder. Notify-only — it never mutates state.`,
    },
  ];
}

export const PRESETS: Record<PresetName, Preset> = {
  quiet: {
    name: "quiet",
    title: "everything manual (today's shipped defaults, pinned explicitly)",
    description:
      "Pins the opt-in feature keys to their shipped defaults so nothing autonomous ever runs — an explicit no rather than an absent file. The one exception: the default-on /refine nudge is notify-only, and quiet silences it too.",
    notes: [],
    deltas: [
      {
        path: "autoImport",
        value: DEFAULT_CONFIG.autoImport,
        rationale: "Durable sync stays off: /harness import and /harness export remain manual.",
      },
      {
        path: "importRemind",
        value: clone(DEFAULT_CONFIG.importRemind),
        rationale: "Reminder defaults pinned (only effective with autoImport on).",
      },
      {
        path: "remindRefine",
        value: { ...clone(DEFAULT_CONFIG.remindRefine), enabled: false },
        rationale:
          "The /refine activation nudge is on by default (notify-only, never mutates); quiet silences it explicitly.",
      },
      {
        path: "autoRefine",
        value: clone(DEFAULT_CONFIG.autoRefine),
        rationale: "Autonomous refinement stays off.",
      },
      {
        path: "outcomeImportance",
        value: clone(DEFAULT_CONFIG.outcomeImportance),
        rationale: "Autonomous importance promotion stays off.",
      },
    ],
  },
  recommended: {
    name: "recommended",
    title: "durable sync + awareness reminders",
    description:
      "autoImport on (refinements survive into new sessions) paired with the importRemind awareness reminders.",
    notes: [
      "Gate-ready: to make refinement signal-driven later, set classifier.model + autoRefine.gate (pi >= 0.99). This preset leaves the gate off.",
    ],
    deltas: recommendedDeltas(),
  },
  power: {
    name: "power",
    title: "recommended + autonomous refinement",
    description:
      "Everything in recommended, plus autoRefine: the agent runs /refine itself on a cadence.",
    notes: [],
    deltas: [
      ...recommendedDeltas(),
      {
        path: "autoRefine",
        value: { ...clone(DEFAULT_CONFIG.autoRefine), enabled: true },
        rationale: `The agent runs /refine itself every ${DEFAULT_CONFIG.autoRefine?.everyTurns} turns (commit stays off unless you set it).`,
        safety:
          "AUTONOMOUS: this lets the agent mutate harness state on a cadence. It reuses the exact /refine routine " +
          "(audited source:auto entries, branch-local, /tree rollback) and notifies before firing.",
        autonomous: true,
      },
    ],
  },
};

/** Menu rows for the TUI's --preset value completion (harness.ts). */
export const PRESET_COMPLETIONS: Array<{ value: string; description: string }> = [
  {
    value: "quiet",
    description: "Everything manual: opt-ins off, the default-on /refine nudge silenced",
  },
  { value: "recommended", description: "autoImport + importRemind awareness reminders" },
  { value: "power", description: "recommended + autoRefine (autonomous, own confirm)" },
];

/** Expand a preset name to its data. Unknown names → undefined; callers
 *  degrade to a warning + no write. hasOwn guards the prototype chain:
 *  "constructor" / "__proto__" are not presets, they are inherited Object
 *  members (review #26). */
export function expandPreset(name: string): Preset | undefined {
  return Object.hasOwn(PRESETS, name) ? PRESETS[name as PresetName] : undefined;
}

/** Pure dotted-path setter: returns a clone of `obj` with `path` set to
 *  `value` (missing intermediate objects are created). Never mutates. */
export function setPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const keys = path.split(".");
  const out: Record<string, unknown> = { ...obj };
  let cur: Record<string, unknown> = out;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i]!;
    cur[k] = isPlainObject(cur[k]) ? { ...cur[k] } : {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys.at(-1)!] = value;
  return out;
}

/** Read a dotted path from a config-ish object; undefined when absent. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Apply the accepted deltas to a raw parsed config file (the object handed
 *  to saveConfig). Declined deltas are skipped. Each delta is applied with
 *  saveConfig's own two-level deep-merge semantics — nested sibling keys
 *  (known or unknown) survive and are VISIBLE in the reviewed JSON — so the
 *  JSON the user confirms is byte-for-byte what lands on disk (review #26).
 *  Pure. */
export function planWrite(
  existing: Record<string, unknown> | undefined,
  deltas: PresetDelta[],
  declined: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  let out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const d of deltas) {
    if (declined.has(d.path)) continue;
    out = deepMergeConfig(out, setPath({}, d.path, d.value));
  }
  return out;
}

function fmt(v: unknown): string {
  return v === undefined ? "(unset)" : (JSON.stringify(v) ?? String(v));
}

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One line per top-level key of an effective config (loader-merged, so this
 *  is exactly what pi will read — no hardcoded default assumptions). */
export function formatConfig(cfg: HarnessConfig): string[] {
  return Object.entries(cfg).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
}

/** Value of a `--flag value` token pair; undefined when missing or valueless. */
function flagValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

/** Phase 2: pick the preset. A `--preset` flag wins; otherwise drive pi's
 *  blocking menu (cancel / dismissal → undefined → no write). */
async function choosePreset(
  ctx: ExtensionCommandContext,
  flagPreset: string | undefined,
): Promise<Preset | undefined> {
  if (flagPreset !== undefined) return expandPreset(flagPreset);
  ctx.ui.notify(
    [
      "Presets:",
      `  quiet        — ${PRESETS.quiet.title}`,
      `  recommended  — ${PRESETS.recommended.title}`,
      `  power        — ${PRESETS.power.title}`,
    ].join("\n"),
    "info",
  );
  const choice = await ctx.ui.select("Continual Harness setup — choose a preset", [
    "recommended",
    "power",
    "quiet",
    "cancel",
  ]);
  if (choice === undefined || choice === "cancel") {
    ctx.ui.notify(
      "Setup cancelled — nothing written. Scripted form: /harness setup --preset <quiet|recommended|power> [--yes].",
      "info",
    );
    return undefined;
  }
  return expandPreset(choice); // menu values are preset names
}

/** Phase 3: the per-feature confirm loop. Returns the declined paths; the
 *  caller aborts when EVERY delta was declined. `--yes` (scripted consent)
 *  skips every prompt INCLUDING the autonomous confirms — that is its point. */
async function confirmDeltas(
  ctx: ExtensionCommandContext,
  preset: Preset,
  current: HarnessConfig,
): Promise<Set<string> | undefined> {
  const declined = new Set<string>();
  for (const d of preset.deltas) {
    const cur = getPath(current, d.path);
    if (jsonEq(cur, d.value)) continue; // already effective — nothing to ask
    const ok = await ctx.ui.confirm(
      d.autonomous === true ? `Enable ${d.path}? (autonomous)` : `Set ${d.path}?`,
      `${d.path}: ${fmt(cur)} → ${fmt(d.value)}\n\n${d.rationale}${d.safety ? `\n\n${d.safety}` : ""}`,
    );
    if (!ok) declined.add(d.path);
  }
  if (preset.deltas.every((d) => declined.has(d.path))) {
    ctx.ui.notify("Every change declined — nothing written.", "info");
    return undefined;
  }
  return declined;
}

/**
 * The /harness setup handler. `path` is injectable for tests; production
 * always targets CONFIG_PATH. Drives pi's native blocking prompts
 * (ctx.ui.select / confirm); when a prompt is dismissed or unavailable the
 * answer counts as decline/cancel and the flow degrades to NO WRITE.
 */
export async function handleSetup(
  ctx: ExtensionCommandContext,
  rest: string[],
  path: string = CONFIG_PATH,
): Promise<void> {
  const flagPreset = flagValue(rest, "--preset");
  const yes = rest.includes("--yes");
  if (rest.includes("--preset") && flagPreset === undefined) {
    ctx.ui.notify(
      "/harness setup: --preset needs a value (quiet | recommended | power).",
      "warning",
    );
    return;
  }
  if (flagPreset !== undefined && expandPreset(flagPreset) === undefined) {
    ctx.ui.notify(
      `Unknown preset "${flagPreset}" — available: quiet, recommended, power. Nothing written.`,
      "warning",
    );
    return;
  }

  // 1. Current state: effective config (file merged over shipped defaults) +
  //    the durable-layer paths, so the user sees the whole picture first.
  const current = await loadConfig(path);
  ctx.ui.notify(
    [
      `Continual Harness setup — config: ${path}`,
      `Durable layers: ${DEFAULT_DURABLE_PATH} (global); ${projectDurablePath(ctx.cwd)} (this project)`,
      "Current effective config (file merged over shipped defaults):",
      ...formatConfig(current),
    ].join("\n"),
    "info",
  );

  // 2. Preset: flag wins; otherwise the interactive menu (cancel → no write).
  const preset = await choosePreset(ctx, flagPreset);
  if (preset === undefined) return;
  if (preset.notes.length > 0) ctx.ui.notify(preset.notes.join("\n"), "info");

  // 3. Per-feature confirm loop. Without --yes, each delta gets its own
  //    confirm — autonomous ones with an explicit "this lets the agent mutate
  //    state on a cadence" safety note.
  const declined = yes ? new Set<string>() : await confirmDeltas(ctx, preset, current);
  if (declined === undefined) return;

  // 4. Reviewed write: plan over the RAW file (unknown keys preserved), show
  //    the final diff + the exact JSON, confirm, then one saveConfig (backup +
  //    atomic write + reload through the coercion path).
  const raw = await readConfigRaw(path);
  const planned = planWrite(raw, preset.deltas, declined);
  const diff = preset.deltas.map((d) =>
    declined.has(d.path)
      ? `  ${d.path}: ${fmt(getPath(current, d.path))}  (skipped — declined)`
      : `  ${d.path}: ${fmt(getPath(current, d.path))} → ${fmt(d.value)}`,
  );
  ctx.ui.notify(
    [`Planned ${path}:`, ...diff, "", JSON.stringify(planned, null, 2)].join("\n"),
    "info",
  );
  if (!yes) {
    const ok = await ctx.ui.confirm(
      "Write harness.json?",
      `Back up (if present) and write ${path} exactly as shown, then reload the effective config.`,
    );
    if (!ok) {
      ctx.ui.notify("Declined — nothing written.", "info");
      return;
    }
  }
  try {
    const res = await saveConfig(planned, path);
    ctx.ui.notify(
      [
        `Wrote ${res.written}${res.backup ? ` (previous file backed up: ${res.backup})` : ""}.`,
        "Effective config now (re-read through the loader):",
        ...formatConfig(res.effective),
      ].join("\n"),
      "info",
    );
  } catch (err) {
    ctx.ui.notify(
      `/harness setup failed — config file not replaced: ${(err as Error).message}`,
      "error",
    );
  }
}

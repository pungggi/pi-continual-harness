// Virtual-model binding policy (pi ≥ 0.99). A virtual model (pi.registerVirtualModel,
// e.g. a Jev router) appears as its own catalog entry with api "pi-virtual"; ctx.model
// names the VIRTUAL model, while each assistant response names the PHYSICAL model it
// was routed to. Strict per-model isolation therefore has two defensible keys:
//
//   "virtual"  (default, pre-0.12 behavior): key = the selected model's provider/id,
//              virtual or physical. One harness per selection; switching to a router
//              starts a blank harness even if it always routes to the same model.
//   "physical" (opt-in): when the selected model is virtual, key = the physical model
//              of the latest successful response on the branch (pi's own
//              findLatestResponse semantics: failed/aborted responses are skipped).
//              Items accumulated under the physical model keep injecting through a
//              router; when the router switches physical models mid-conversation the
//              key changes and isolation applies exactly as after a manual switch.
//              Before the first response on a branch there is no physical key yet:
//              the binding resolves to undefined, so creates become orphans and are
//              adopted by the resolved key on the next contact (the existing
//              adoption machinery — no special-casing needed).
//
// Kept dependency-free and local: pi exports the virtual-model constants from its
// package entry only partially, and these helpers are tiny (the api id is a stable
// public constant, "pi-virtual").

import type { VirtualBinding } from "./config.js";

/** pi's public constant for virtual catalog entries (VIRTUAL_MODEL_API). */
export const VIRTUAL_MODEL_API = "pi-virtual";

/** Minimal structural shapes so tests can build fakes without pi types. */
interface ModelLike {
  provider?: string;
  id?: string;
  api?: string;
}

interface AssistantLike {
  role?: string;
  provider?: string;
  model?: string;
}

/** Whether a model object names a virtual (router) catalog entry. */
export function isVirtualModel(m?: ModelLike): boolean {
  return m?.api === VIRTUAL_MODEL_API;
}

/**
 * Key of the physical model behind the latest SUCCESSFUL response on a branch.
 * Scans message entries backwards; failed/aborted responses do not produce
 * assistant message entries that reach the branch tail, matching pi's
 * findLatestResponse contract closely enough for binding purposes.
 * Returns undefined when no assistant response exists yet.
 */
export function physicalKeyFromBranch(entries: Iterable<unknown>): string | undefined {
  const msgs: AssistantLike[] = [];
  for (const e of entries as Array<{ type?: string; message?: AssistantLike }>) {
    if (e?.type === "message" && e.message?.role === "assistant") msgs.push(e.message);
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.provider && m.model) return `${m.provider}/${m.model}`;
  }
  return undefined;
}

/** Canonical owner key, mirroring store.modelKey with optional-field guards. */
function plainKey(m?: ModelLike): string | undefined {
  return m?.provider && m?.id ? `${m.provider}/${m.id}` : undefined;
}

/** Defensive branch access: test fakes build minimal ctx without a session
 *  manager; production always has one. */
export function branchEntries(ctx: { sessionManager?: { getBranch?: () => unknown[] } }): unknown[] {
  return ctx.sessionManager?.getBranch?.() ?? [];
}

/**
 * Resolve the harness binding key under the configured policy. `entries` is the
 * session branch (used only for the "physical" policy); pass [] when unknown.
 */
export function resolveBindingKey(
  model: ModelLike | undefined,
  entries: Iterable<unknown>,
  policy: VirtualBinding = "virtual",
): string | undefined {
  if (policy !== "physical" || !isVirtualModel(model)) return plainKey(model);
  return physicalKeyFromBranch(entries);
}

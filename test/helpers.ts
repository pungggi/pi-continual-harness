// Shared test fake for the ExtensionAPI. Extracted from integration.test.ts so
// the layers/env-override tests can reuse it.
//
// handlers is Map<event, Handler[]>: EVERY registered handler runs (matching
// production pi, where all turn_end subscribers fire) — use fire() to invoke.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Handler = (event?: unknown, ctx?: unknown) => unknown | Promise<unknown>;

export interface FakeCtx {
  ui: {
    notify: (msg: string, level: string) => void;
    setStatus: (key: string, text: string | undefined) => void;
  };
  sessionManager: {
    getBranch: () => unknown[];
  };
  cwd: string;
  model: { provider: string; id: string };
}

export function makeFakePi(branch: unknown[], cwd = "/tmp") {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Record<string, unknown>>();
  const commands = new Map<
    string,
    { description?: string; getArgumentCompletions?: (prefix: string) => unknown; handler: Handler }
  >();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const sentMessages: string[] = [];
  const notifications: Array<{ msg: string; level: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];

  const pi = {
    on: (ev: string, h: Handler) => {
      const arr = handlers.get(ev) ?? [];
      arr.push(h);
      handlers.set(ev, arr);
    },
    registerTool: (def: Record<string, unknown>) => {
      tools.set(def.name as string, def);
    },
    registerCommand: (
      name: string,
      opts: { description?: string; getArgumentCompletions?: (prefix: string) => unknown; handler: Handler },
    ) => {
      commands.set(name, opts);
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage: (msg: string) => {
      sentMessages.push(msg);
    },
  };

  const ctx = (): FakeCtx => ({
    ui: {
      notify: (msg, level) => notifications.push({ msg, level }),
      setStatus: (key, text) => statuses.push({ key, text }),
    },
    sessionManager: { getBranch: () => branch },
    cwd,
    model: { provider: "test", id: "main" },
  });

  /** Invoke every handler registered for an event, in registration order. */
  const fire = async (ev: string, event?: unknown, ctxArg?: unknown): Promise<unknown[]> =>
    Promise.all((handlers.get(ev) ?? []).map((h) => h(event, ctxArg)));

  return {
    pi: pi as unknown as ExtensionAPI,
    handlers,
    tools,
    commands,
    entries,
    sentMessages,
    notifications,
    statuses,
    ctx,
    fire,
  };
}

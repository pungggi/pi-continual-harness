// Virtual-model binding policy (pi ≥ 0.99). Pure unit tests over src/vmodel.ts:
// virtual detection, physical-key reconstruction from the branch, and the
// policy-aware resolution — the seams model-binding.test.ts drives end-to-end.

import { describe, it, expect } from "vitest";
import { isVirtualModel, physicalKeyFromBranch, resolveBindingKey, VIRTUAL_MODEL_API } from "../src/vmodel.js";

describe("isVirtualModel", () => {
  it("matches pi's virtual catalog api id", () => {
    expect(VIRTUAL_MODEL_API).toBe("pi-virtual");
    expect(isVirtualModel({ api: "pi-virtual" })).toBe(true);
    expect(isVirtualModel({ api: "anthropic" })).toBe(false);
    expect(isVirtualModel(undefined)).toBe(false);
    expect(isVirtualModel({})).toBe(false);
  });
});

describe("physicalKeyFromBranch", () => {
  const entry = (role: string, extra: Record<string, unknown> = {}) => ({
    type: "message",
    message: { role, content: [], ...extra },
  });

  it("returns the latest assistant response's physical model", () => {
    const branch = [
      entry("user"),
      entry("assistant", { provider: "anthropic", model: "claude-a" }),
      entry("assistant", { provider: "openai", model: "gpt-b" }),
    ];
    expect(physicalKeyFromBranch(branch)).toBe("openai/gpt-b");
  });

  it("skips non-assistant messages and returns undefined with no responses", () => {
    expect(physicalKeyFromBranch([entry("user")])).toBeUndefined();
    expect(physicalKeyFromBranch([])).toBeUndefined();
    expect(
      physicalKeyFromBranch([entry("assistant", { provider: "x", model: "y" }), entry("assistant")]),
    ).toBe("x/y"); // falls back to the last assistant message WITH a model
  });
});

describe("resolveBindingKey", () => {
  const physical = { provider: "anthropic", id: "claude-x", api: "anthropic" };
  const virtual = { provider: "openai-codex", id: "auto", api: "pi-virtual" };
  const branch = [
    { type: "message", message: { role: "assistant", provider: "anthropic", model: "claude-x", content: [] } },
  ];

  it("default (virtual) policy: plain provider/id, virtual or physical", () => {
    expect(resolveBindingKey(physical, [], "virtual")).toBe("anthropic/claude-x");
    expect(resolveBindingKey(virtual, branch, "virtual")).toBe("openai-codex/auto");
    expect(resolveBindingKey(virtual, [])).toBe("openai-codex/auto"); // default arg
  });

  it("physical policy: physical selections stay plain; virtual resolve from the branch", () => {
    expect(resolveBindingKey(physical, [], "physical")).toBe("anthropic/claude-x");
    expect(resolveBindingKey(virtual, branch, "physical")).toBe("anthropic/claude-x");
  });

  it("physical policy with no response yet: undefined (orphans until first contact)", () => {
    expect(resolveBindingKey(virtual, [], "physical")).toBeUndefined();
  });

  it("unknown model: undefined under every policy", () => {
    expect(resolveBindingKey(undefined, branch, "physical")).toBeUndefined();
    expect(resolveBindingKey(undefined, [], "virtual")).toBeUndefined();
  });
});

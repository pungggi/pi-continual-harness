// Classifier adapter (pi ≥ 0.99). Pure unit tests over src/classify.ts: model
// resolution, the pi-ai shape mapping (bool/choice/score answers, error paths,
// usage passthrough), and the auto-refine gate decision semantics.

import { describe, it, expect } from "vitest";
import {
  buildGateRequest,
  gateDecision,
  makeClassifyFn,
  resolveClassifierModel,
  type ClassifyBoolResult,
} from "../src/classify.js";

const jev = { provider: "typesafe", id: "jev-latest" };

type FakeRegistry = Parameters<typeof makeClassifyFn>[0];

function registryWith(models: unknown[], classify?: (model: unknown, context: unknown, options?: unknown) => Promise<unknown>): FakeRegistry {
  return {
    ...(classify ? { classify } : {}),
    findOfType: (_t: "classifier", provider: string, id: string) =>
      models.find((m) => (m as { provider: string }).provider === provider && (m as { id: string }).id === id),
    getModelsOfType: () => models,
  } as FakeRegistry;
}

describe("resolveClassifierModel", () => {
  it("resolves provider/id via findOfType and bare ids via the catalog", () => {
    expect(resolveClassifierModel(registryWith([jev]) as never, "typesafe/jev-latest")).toEqual(jev);
    expect(resolveClassifierModel(registryWith([jev]) as never, "jev-latest")).toEqual(jev);
  });

  it("returns undefined when unconfigured, unresolvable, or no registry", () => {
    expect(resolveClassifierModel(registryWith([jev]) as never, undefined)).toBeUndefined();
    expect(resolveClassifierModel(undefined, "typesafe/jev-latest")).toBeUndefined();
    expect(resolveClassifierModel(registryWith([]) as never, "nope")).toBeUndefined();
  });
});

describe("makeClassifyFn", () => {
  const questions = {
    gate: { instructions: "i", trueCriteria: "t", falseCriteria: "f" },
  };

  it("maps bool answers (probability of true) with confidence, and passes usage through", async () => {
    const raw = { stopReason: "stop", answers: { gate: { type: "bool", probability: 0.82 } }, usage: { input: 10, output: 2 } };
    const reg = registryWith([jev], async () => raw);
    const fn = makeClassifyFn(reg, jev);
    const res = await fn({ state: {}, questions });
    expect(res).toEqual({
      ok: true,
      answers: { gate: { value: true, confidence: 0.82 } },
      model: "typesafe/jev-latest",
      usage: { input: 10, output: 2 },
    });
  });

  it("maps choice and score answers defensively", async () => {
    const reg = registryWith([jev], async () => ({
      stopReason: "stop",
      answers: {
        a: { type: "choice", choice: "false", confidence: 0.7 },
        b: { type: "score", score: 0.9, confidence: 0.9 },
      },
    }));
    const fn = makeClassifyFn(reg, jev);
    const res = await fn({ state: {}, questions: { a: questions.gate, b: questions.gate } });
    expect(res.ok).toBe(true);
    expect(res.answers.a).toEqual({ value: false, confidence: 0.7 });
    expect(res.answers.b).toEqual({ value: true, confidence: 0.9 });
  });

  it("error stopReason and thrown errors surface as ok:false (never throw)", async () => {
    const regErr = registryWith([jev], async () => ({ stopReason: "error", errorMessage: "boom" }));
    const r1 = await makeClassifyFn(regErr, jev)({ state: {}, questions });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("boom");

    const regThrow = registryWith([jev], async () => {
      throw new Error("transport");
    });
    const r2 = await makeClassifyFn(regThrow, jev)({ state: {}, questions });
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe("transport");
  });

  it("missing classify on the registry degrades to ok:false", async () => {
    const r = await makeClassifyFn(registryWith([jev]), jev)({ state: {}, questions });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unavailable");
  });
});

describe("gate decision + request", () => {
  it("builds a bounded gate request over the trajectory", () => {
    const req = buildGateRequest("the agent learned X");
    expect(req.state.trajectory).toBe("the agent learned X");
    expect(Object.keys(req.questions)).toEqual(["gate"]);
    expect(req.questions.gate!.trueCriteria).toContain("durable");
  });

  it("a NO skips; errors and missing answers fall back to proceeding", () => {
    const no: ClassifyBoolResult = { ok: true, answers: { gate: { value: false, confidence: 0.9 } } };
    expect(gateDecision(no)).toEqual({ proceed: false, because: "classifier: no durable correction (confidence 0.9)" });
    const yes: ClassifyBoolResult = { ok: true, answers: { gate: { value: true } } };
    expect(gateDecision(yes).proceed).toBe(true);
    const err: ClassifyBoolResult = { ok: false, answers: {}, error: "boom" };
    expect(gateDecision(err).proceed).toBe(true);
    const missing: ClassifyBoolResult = { ok: true, answers: {} };
    expect(gateDecision(missing).proceed).toBe(true);
  });
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // entry.ts is the thin registration shim — its bodies are one-line
      // dynamic-import delegations exercised (and pinned) by test/entry.test.ts
      // through the factory; per-line coverage of the lambdas adds noise.
      // command-meta.ts is two string constants.
      exclude: ["src/entry.ts", "src/command-meta.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        // Global floor for the whole package.
        statements: 95,
        // The pure policy modules are advertised as "pure, deterministic,
        // unit-tested" (README §Injection selection / §Proposers) — hold
        // them at full statement coverage so a new branch without a test
        // fails CI instead of silently eroding that property.
        "src/select.ts": { statements: 100 },
        "src/lessons.ts": { statements: 100 },
        "src/cadence.ts": { statements: 100 },
        "src/vmodel.ts": { statements: 100 },
      },
    },
  },
});

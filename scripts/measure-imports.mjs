// Startup-cost profiler for issue #36: times raw ESM import of each dist
// module in a plain Node process (no pi, no jiti), plus the full API entry.
const t = async (label, fn) => {
  const t0 = performance.now();
  await fn();
  console.log(`${label}: ${(performance.now() - t0).toFixed(1)}ms`);
};

await t("entry.js (thin)", () => import("../dist/entry.js"));
await t("schemas.js", () => import("../dist/schemas.js"));
await t("command-meta.js", () => import("../dist/command-meta.js"));
await t("typebox", () => import("typebox"));
await t("full index.js (public API)", () => import("../dist/index.js"));

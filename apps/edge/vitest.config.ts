import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Durable Object tests run in the real Workers runtime (workerd) against the
 * bindings declared in the single wrangler config (AGENTS.md: tests use
 * @cloudflare/vitest-pool-workers).
 */
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "../../infra/wrangler.edge.toml" },
        miniflare: {
          // Tests never touch the network: an empty OSRM base URL disables
          // routing, so checkout uses the market's static floor-rate inputs.
          bindings: { OSRM_BASE_URL: "" },
        },
        // Pending DO alarms left over from timer tests trip the pool's
        // per-file storage-isolation bookkeeping ("Isolated storage failed"),
        // not the assertions. Isolation is preserved by convention instead:
        // every test file namespaces its DO ids by market (ao/ce/cg/st).
        isolatedStorage: false,
      },
    },
  },
});

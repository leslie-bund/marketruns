import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const betterAuthStub = new URL("./test/better-auth-stub.ts", import.meta.url).pathname;

/**
 * Durable Object tests run in the real Workers runtime (workerd) against the
 * bindings declared in the single wrangler config (AGENTS.md: tests use
 * @cloudflare/vitest-pool-workers).
 */
export default defineWorkersConfig({
  resolve: {
    alias: [
      { find: /^better-auth$/, replacement: betterAuthStub },
      { find: /^better-auth\/adapters\/drizzle$/, replacement: betterAuthStub },
    ],
  },
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "../../infra/wrangler.edge.toml" },
        miniflare: {
          // Tests never touch the network: an empty OSRM base URL disables
          // routing, so checkout uses the market's static floor-rate inputs.
          bindings: { OSRM_BASE_URL: "", DATABASE_URL: "", ALLOW_HEADER_AUTH: "true", ID_DOCUMENT_HMAC_SECRET: "test-document-hmac-key", OPS_LEGACY_DEV: "true", OPS_LOCAL_DEV: "true" },
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

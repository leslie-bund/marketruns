import { defineConfig } from "vitest/config";

/**
 * The identity worker's logic is storage-agnostic (repository seam) and its
 * crypto is WebCrypto — plain node vitest covers it. No Durable Object or
 * Cloudflare bindings are exercised, so no vitest-pool-workers here
 * (contrast apps/edge). A real-database integration test belongs beside
 * apps/archive's persist.integration.test.ts as a follow-up.
 */
export default defineConfig({ test: { environment: "node" } });

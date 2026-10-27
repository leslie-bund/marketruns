import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "ux-audit.spec.ts",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8081",
    viewport: { width: 390, height: 844 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node ux-stack.mjs",
    url: "http://127.0.0.1:8081",
    timeout: 240_000,
    reuseExistingServer: false,
  },
});

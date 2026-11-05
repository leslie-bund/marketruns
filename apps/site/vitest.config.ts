import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    external: ["node:sqlite"],
  },
  test: {
    server: {
      deps: {
        external: ["node:sqlite"],
      },
    },
  },
});

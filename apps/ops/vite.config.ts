import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "OPS_");
  const edgeOrigin = env.OPS_EDGE_URL ?? "http://localhost:8787";

  return {
    base: "/",
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 7100,
      proxy: {
        "/ops": {
          target: edgeOrigin,
          changeOrigin: true,
          headers: { origin: edgeOrigin },
          ws: true,
        },
      },
    },
    resolve: {
      alias: { "@": path.resolve(__dirname, "./src") },
    },
  };
});

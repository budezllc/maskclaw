import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { maskclawControlPlugin } from "./src/controlPlugin";
import { surfaceFromViteMode } from "./src/surface";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const sidecarLike = mode === "sidecar" || mode === "development";
  const devControlToken =
    sidecarLike && !process.env.VITEST
      ? (process.env.MASKCLAW_DEV_CONTROL_TOKEN ?? randomBytes(32).toString("hex"))
      : "";
  if (devControlToken && !process.env.MASKCLAW_DEV_CONTROL_TOKEN) {
    console.log(`[maskclaw] Control API dev token: ${devControlToken}`);
  }

  return {
    base: "./",
    plugins: [react(), tailwindcss(), maskclawControlPlugin(devControlToken)],
    resolve: {
      alias: {
        "@": path.resolve(rootDir, "./src"),
      },
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      allowedHosts: ["maskclaw.local", "127.0.0.1"],
      proxy: {
        "/v1": "http://127.0.0.1:4000",
        "/health": "http://127.0.0.1:4000",
        "/host": "http://127.0.0.1:8787",
      },
    },
    preview: {
      host: "127.0.0.1",
      port: 5173,
      allowedHosts: ["maskclaw.local", "127.0.0.1"],
    },
    define: {
      "import.meta.env.VITE_SURFACE": JSON.stringify(surfaceFromViteMode(mode)),
      "import.meta.env.VITE_DEV_CONTROL_TOKEN": JSON.stringify(devControlToken),
    },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      setupFiles: ["./src/test-setup.ts"],
    },
  };
});

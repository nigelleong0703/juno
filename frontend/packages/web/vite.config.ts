import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The web build of the app. Workspace packages export TypeScript sources directly, so they are
 * excluded from dependency pre-bundling and transformed by Vite like first-party code.
 *
 * `@agent-desktop/ui` imports its own modules through the `@/*` alias declared in
 * `packages/ui/tsconfig.json`; Vite transforms those sources here, so the same alias must be
 * resolvable in this build. It points at the ui package's `src`.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../ui/src", import.meta.url)),
    },
  },
  server: {
    port: 5199,
    strictPort: true,
    // Set JUNO_DEV_ALLOWED_HOSTS (comma-separated) to reach the dev server through a tunnel host name.
    allowedHosts: (process.env.JUNO_DEV_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean),
    // The browser sends API/cookie/SSE/WS traffic to its own origin. Only this development
    // proxy connects to agentd on the Mac; request Origin and credentials pass through unchanged.
    proxy: {
      "/auth": { target: "http://127.0.0.1:8787", changeOrigin: false, ws: true, rewriteWsOrigin: false },
      "/v1": { target: "http://127.0.0.1:8787", changeOrigin: false, ws: true, rewriteWsOrigin: false },
      "/healthz": { target: "http://127.0.0.1:8787", changeOrigin: false },
    },
  },
  optimizeDeps: {
    // Workspace packages ship TS sources too; keep them out of pre-bundling.
    exclude: ["@agent-desktop/ui", "@agent-desktop/client", "@agent-desktop/app"],
  },
});

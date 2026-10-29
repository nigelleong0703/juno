import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

/**
 * Electron build (E2). Three bundles: `main` and `preload` run in Node (deps externalised),
 * `renderer` is the same React app `packages/web` serves. Workspace packages export TypeScript
 * sources, so they are transformed like first-party code and the ui package's own `@/*` alias is
 * mirrored here.
 */
const uiSrc = fileURLToPath(new URL("../ui/src", import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // Released builds ship minified code (owner, 2026-10-19: the release repo has no source).
      minify: true,
      outDir: "out/main",
      rollupOptions: {
        input: "src/main/index.ts",
        // Runtime built-in: bundling npm electron inserts getElectronPath and crashes packaged apps.
        external: ["electron", "electron-updater"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: true,
      outDir: "out/preload",
      // Sandboxed preloads must be CommonJS, so force `.cjs` even though the package is ESM.
      rollupOptions: {
        input: "src/preload/index.ts",
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    // 5200 by default so the web dev server can keep 5199; JUNO_DESKTOP_PORT moves it.
    server: { host: "localhost", port: Number(process.env.JUNO_DESKTOP_PORT ?? 5200), strictPort: true },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": uiSrc, "@renderer": fileURLToPath(new URL("src/renderer/src", import.meta.url)) },
    },
    optimizeDeps: {
      exclude: ["@agent-desktop/ui", "@agent-desktop/client", "@agent-desktop/app"],
    },
    build: { outDir: "out/renderer", rollupOptions: { input: fileURLToPath(new URL("src/renderer/index.html", import.meta.url)) } },
  },
});

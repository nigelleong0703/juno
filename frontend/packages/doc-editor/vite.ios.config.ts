import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The editor page the iOS app bundles: one classic script and one stylesheet (module scripts cannot load from file
 * URLs in a web view). `scripts/build/doc-editor-ios.mjs` runs this and copies the result next to `ios/index.html`.
 */
export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: { entry: "src/standalone.tsx", formats: ["iife"], name: "JunoDocEditor", fileName: () => "editor.js", cssFileName: "editor" },
  },
});

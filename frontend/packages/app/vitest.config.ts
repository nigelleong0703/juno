import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest for the app package (E2). jsdom because the computer surface touches DOM (noVNC mounts
 * a canvas, the pane measures a container). The `@` alias mirrors packages/ui's own tsconfig
 * alias — the ui package ships TypeScript sources, so its internal `@/…` imports must resolve
 * here too.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../ui/src", import.meta.url)),
    },
  },
});

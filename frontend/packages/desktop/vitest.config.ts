import { defineConfig } from "vitest/config";

/**
 * Pure main-process tests for the packaged client (E5): CSP / origin policy, the IPC validation
 * boundary and a couple of source guards. No Electron runtime is needed.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

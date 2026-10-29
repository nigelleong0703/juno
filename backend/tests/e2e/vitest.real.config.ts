import { defineConfig } from 'vitest/config';

/**
 * Real-model scenarios (`pnpm test:e2e:real`): the same isolated stack as `pnpm test:e2e`, but agentd
 * calls a real model through the local OCX proxy (see harness/stack.ts `realModel`). Assertions check
 * behaviour (which tool ran, what was posted, what was refused), never exact model wording.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['real/**/*.test.ts'],
    globalSetup: ['./harness/stack.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 240_000,
    hookTimeout: 180_000,
    teardownTimeout: 60_000,
  },
});

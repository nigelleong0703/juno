import { readdirSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * Two projects on one shared stack (harness/stack.ts boots it once). Every scenario creates its own
 * account, so almost all files run in parallel workers. Files named `*.exclusive.test.ts` do something
 * global (they SIGKILL agentd) and run alone, after the parallel group has finished.
 *
 * E2E_ONLY=approval,steer runs only the files whose name contains one of the words.
 */
const only = (process.env['E2E_ONLY'] ?? '').split(',').map((word) => word.trim()).filter(Boolean);
const files = readdirSync('scenarios').filter((file) => file.endsWith('.test.ts') && (only.length === 0 || only.some((word) => file.includes(word))));
const exclusive = files.filter((file) => file.endsWith('.exclusive.test.ts')).map((file) => `scenarios/${file}`);
const parallel = files.filter((file) => !file.endsWith('.exclusive.test.ts')).map((file) => `scenarios/${file}`);
if (only.length > 0 && files.length === 0) throw new Error(`E2E_ONLY=${only.join(',')} matches no scenario file`);

const shared = {
  environment: 'node' as const,
  globalSetup: ['./harness/stack.ts'],
  pool: 'forks' as const,
  testTimeout: 60_000,
  hookTimeout: 180_000,
  teardownTimeout: 60_000,
};

export default defineConfig({
  test: {
    maxWorkers: 8,
    projects: [
      { test: { ...shared, name: 'parallel', include: parallel, sequence: { groupOrder: 1 } } },
      // One fork for the exclusive group: its files run one after another.
      { test: { ...shared, name: 'exclusive', include: exclusive, poolOptions: { forks: { singleFork: true } }, sequence: { groupOrder: 2 } } },
    ],
  },
});

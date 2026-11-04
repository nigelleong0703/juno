// BACKEND 5.3: the home sync happens where the computer is reached (the run's first computer tool, then file-changing ones).
import { describe, expect, it } from 'vitest';
import type { ToolContext, WakeEvent } from '../../../contracts/index.js';
import type { ComputerClient, HomeComputer } from '../../../ports/computer/index.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { requestScopedStore, runWithOwner } from '../../../owner-context.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createToolRegistry } from '../index.js';

/** A computer that is running: the passive home calls are counted, anything else of the home is a test failure. */
function runningComputer() {
  const counts = { snapshots: 0 };
  const passive: HomeComputer = {
    async snapshot() { counts.snapshots += 1; return { synced: true, files: [] }; },
    async read() { return null; },
    async write(_agent, _path, content) { return { hash: String(content.length) }; },
    async putFile() { return { hash: 'h', written: true }; },
    async extractText() { return { text: '', truncated: false }; },
    async delete() { return undefined; },
    async ensure() { return undefined; },
  };
  const never = async (): Promise<never> => { throw new Error('the sync must not wake the computer'); };
  const home: HomeComputer = { ...passive, snapshot: never, whileRunning: () => passive };
  const client = {
    home,
    pressKey: async () => undefined,
    environment: async () => ({ os: 'FakeOS', platform: 'fake', user: 'agent', home: '/home/agent', workingDirectory: '/workspace', pathStyle: 'posix', kind: 'sandbox' }),
    runShell: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  } as unknown as ComputerClient;
  return { client, counts };
}

const wake = { ownerId: 'owner', kind: 'user_message', origin: { type: 'user' }, trusted: true, payload: {} } as unknown as WakeEvent;

describe('the home sync at tool time', () => {
  it('runs after the first computer tool of a run, then only after file-changing tools', async () => {
    const store = requestScopedStore(createMemoryStore());
    const { client, counts } = runningComputer();
    const registry = await createToolRegistry({ store, enqueuer: new NoopEnqueuer(), computer: () => client });
    const ctx = (runId: string): ToolContext => ({ ownerId: 'owner', agentId: 'agt-1', conversationId: 'conv-1', runId, store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), wake, step: async (_n, fn) => fn(), signal: new AbortController().signal });
    const run = (name: string, args: unknown, runId: string) => runWithOwner('owner', async () => registry.get(name)?.execute(args, ctx(runId)));

    expect(counts.snapshots).toBe(0);
    await run('computer.key', { key: 'a' }, 'run-a');
    expect(counts.snapshots).toBe(1);
    await run('computer.key', { key: 'b' }, 'run-a');
    expect(counts.snapshots).toBe(1);
    await run('shell.run', { command: 'touch x' }, 'run-a');
    expect(counts.snapshots).toBe(2);
    // The next run's first computer tool syncs again.
    await run('computer.key', { key: 'c' }, 'run-b');
    expect(counts.snapshots).toBe(3);
  });
});

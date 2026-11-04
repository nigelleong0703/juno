import { describe, expect, it } from 'vitest';
import { ComputerError, type HomeComputer } from '../../../ports/computer/index.js';
import { requestScopedStore, runWithOwner } from '../../../owner-context.js';
import { createMemoryStore } from '../../../testing/store.js';
import { loadHomeView } from '../service.js';

/** A computer whose first snapshot only answers when released: a sandbox that is still waking up. */
function wakingComputer() {
  let release: () => void = () => undefined;
  const woke = new Promise<void>((resolve) => { release = resolve; });
  let snapshots = 0;
  const computer: HomeComputer = {
    async snapshot() { snapshots += 1; await woke; return { synced: true, files: [] }; },
    async read() { return null; },
    async write(_agent, _path, content) { return { hash: String(content.length) }; },
    async putFile() { return { hash: 'h', written: true }; },
    async extractText() { return { text: '', truncated: false }; },
    async delete() { return undefined; },
    async ensure() { return undefined; },
  };
  return { computer, release, snapshots: () => snapshots };
}

describe('home sync budget', () => {
  it('builds the view from the mirror when the computer is slow, runs one sync, and lets it finish in the background', async () => {
    const store = requestScopedStore(createMemoryStore());
    const waking = wakingComputer();
    const input = { ownerId: 'owner', agentId: 'agt-1', seq: 1, sync: true, now: new Date('2026-10-14T10:00:00Z'), timeZone: 'UTC', syncBudgetMs: 30 };
    const view = () => runWithOwner('owner', () => loadHomeView({ store, home: waking.computer }, input));

    const started = Date.now();
    const first = await view();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(first.dailyLog).toBe('');

    // A second build while the first sync is still running does not start another one.
    await view();
    expect(waking.snapshots()).toBe(1);

    waking.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The finished sync updated the mirror: the next build sees the computer as reachable.
    expect((await view()).dailyLog).toBe('memory/2026-10-14/agt-1.md');
  });

  it('never calls an active computer: a sleeping one is skipped and the mirror stands', async () => {
    const store = requestScopedStore(createMemoryStore());
    const calls: string[] = [];
    const asleep = async (): Promise<never> => { calls.push('passive'); throw new ComputerError('unavailable', 'the computer is paused'); };
    const computer: HomeComputer = {
      snapshot: async () => { calls.push('active'); return { synced: true, files: [] }; },
      read: async () => { calls.push('active'); return null; },
      write: async () => { calls.push('active'); return { hash: 'h' }; },
      putFile: async () => { calls.push('active'); return { hash: 'h', written: true }; },
      extractText: async () => { calls.push('active'); return { text: '', truncated: false }; },
      delete: async () => { calls.push('active'); },
      ensure: async () => { calls.push('active'); },
      whileRunning: () => ({ snapshot: asleep, read: asleep, write: asleep, putFile: asleep, extractText: asleep, delete: asleep, ensure: asleep }),
    };
    const view = await runWithOwner('owner', () => loadHomeView({ store, home: computer }, { ownerId: 'owner', agentId: 'agt-1', seq: 1, sync: true, now: new Date('2026-10-14T10:00:00Z'), timeZone: 'UTC' }));
    expect(calls).toEqual(['passive']);
    expect(view.dailyLog).toBe('');
  });
});

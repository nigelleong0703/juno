import { describe, expect, it } from 'vitest';
import { ComputerError, type HomeComputer } from '../../../ports/computer/index.js';
import { requestScopedStore, runWithOwner } from '../../../owner-context.js';
import { createMemoryStore } from '../../../testing/store.js';
import { getRow } from '../../home/mirror.js';
import { loadHomeView } from '../../home/service.js';
import { editHomeFile } from '../files.js';

/** A computer with an "awake" face (writes land in `files`) and the active face a background writer must never touch. */
function computer(running: { value: boolean }) {
  const files = new Map<string, string>();
  const calls = { active: 0, passive: 0 };
  const face = (kind: 'active' | 'passive'): HomeComputer => {
    const call = async <T>(result: T): Promise<T> => {
      calls[kind] += 1;
      if (kind === 'passive' && !running.value) throw new ComputerError('unavailable', 'the computer is paused');
      return result;
    };
    return {
      snapshot: () => call({ synced: true, files: [...files.keys()].map((path) => ({ path, hash: 'h', mtime: 1 })) }),
      read: () => call(null),
      write: async (_agent, path, content) => { await call(null); files.set(path, content); return { hash: 'h' }; },
      putFile: () => call({ hash: 'h', written: true }),
      extractText: () => call({ text: '', truncated: false }),
      delete: () => call(undefined),
      ensure: () => call(undefined),
    };
  };
  return { home: { ...face('active'), whileRunning: () => face('passive') } satisfies HomeComputer, files, calls };
}

describe('platform writes to a sleeping computer', () => {
  it('keep the edit in the mirror as a pending write, leave the computer alone, and land on the next running sync', async () => {
    const store = requestScopedStore(createMemoryStore());
    const running = { value: false };
    const fake = computer(running);
    const deps = { store, home: fake.home };
    const path = 'dreams/2026-10-14.md';

    await runWithOwner('owner', async () => {
      expect(await editHomeFile(deps, { ownerId: 'owner', path }, () => '# Dream\n')).toBe(true);
      // Nothing reached the computer, and it was never woken (no active call); the mirror holds the edit, pending.
      expect(fake.files.size).toBe(0);
      expect(fake.calls.active).toBe(0);
      expect(await getRow(store, 'owner', path)).toMatchObject({ content: '# Dream\n', writer: 'platform', pendingWrite: true });

      // A sync while it is still paused changes nothing either.
      await loadHomeView(deps, { ownerId: 'owner', agentId: 'agt-1', seq: 1, sync: true, now: new Date('2026-10-14T10:00:00Z'), timeZone: 'UTC' });
      expect(fake.files.size).toBe(0);
      expect(fake.calls.active).toBe(0);

      // The computer is running again: the next sync applies the pending write and clears the flag.
      running.value = true;
      await loadHomeView(deps, { ownerId: 'owner', agentId: 'agt-1', seq: 2, sync: true, now: new Date('2026-10-14T10:00:00Z'), timeZone: 'UTC' });
      expect(fake.files.get(path)).toBe('# Dream\n');
      expect((await getRow(store, 'owner', path))?.pendingWrite).toBeUndefined();
      expect(fake.calls.active).toBe(0);
    });
  });
});

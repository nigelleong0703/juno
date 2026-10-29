/**
 * Self-healing of a lost computer (BACKEND §7.11, fault tolerance): the policy numbers, and the recovery run against a
 * stubbed provider. The live version with real containers is recovery.live.test.ts.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { ComputerdError, StaleComputerError, createScreenPool, isDockerMissing, isIdempotentAction, unavailable, type ComputerProvider } from '@agent-desktop/sandbox-adapters';
import { ARCHIVE_DIR, createComputerStateStore } from '../infrastructure/computer-state.js';
import { createRecovery } from '../modules/computers/recovery.js';
import { BACKOFF_MAX_MS, backoffMs, staleOf } from '../modules/computers/recovery-policy.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('recovery policy', () => {
  it('backs off 5 s, 10 s, 20 s ... and caps at 2 minutes, never giving up', () => {
    expect([1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, BACKOFF_MAX_MS]);
    expect(backoffMs(50)).toBe(BACKOFF_MAX_MS);
  });

  it('only a stale-computer error triggers a replacement', () => {
    const stale = new StaleComputerError('gone', 'x', 'c1');
    expect(staleOf(stale)).toBe(stale);
    expect(staleOf(unavailable('docker daemon is not reachable'))).toBeUndefined();
    expect(staleOf(new Error('boom'))).toBeUndefined();
  });

  it('classifies docker "no such object" as gone and nothing else', () => {
    expect(isDockerMissing('Error: No such object: abc123')).toBe(true);
    expect(isDockerMissing('Cannot connect to the Docker daemon')).toBe(false);
    expect(isDockerMissing('permission denied while trying to connect')).toBe(false);
  });

  it('retries only pure reads after a dropped link', () => {
    expect(isIdempotentAction({ kind: 'screenshot' })).toBe(true);
    expect(isIdempotentAction({ kind: 'readFile', path: '/workspace/a' })).toBe(true);
    expect(isIdempotentAction({ kind: 'browser', input: { action: 'snapshot' } })).toBe(true);
    expect(isIdempotentAction({ kind: 'click', point: { x: 1, y: 1 } })).toBe(false);
    expect(isIdempotentAction({ kind: 'shell', input: { command: 'ls', timeoutMs: 1 } })).toBe(false);
    expect(isIdempotentAction({ kind: 'writeFile', input: { path: '/a', content: '' } })).toBe(false);
    expect(isIdempotentAction({ kind: 'browser', input: { action: 'click', ref: 'e1' } })).toBe(false);
  });
});

function setup(ensure: () => Promise<void>, waitMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'self-heal-'));
  dirs.push(dir);
  const file = join(dir, 'owners', 'h', 'computerd-binding.json');
  const state = createComputerStateStore(file, { sandboxId: 'old-computer-id', template: 't', linkId: 'l1' });
  state.set({ sandboxId: 'old-computer-id', template: 't', linkId: 'l1' });
  const store = createMemoryStore();
  const pool = createScreenPool(4, []);
  pool.lease('agent-a');
  const destroyed: string[] = [];
  const provider = { destroy: vi.fn(async (b: { sandboxId: string }) => void destroyed.push(b.sandboxId)) } as unknown as ComputerProvider;
  const sleeps: number[] = [];
  let attempts = 0;
  const recovery = createRecovery({
    store, provider, pool, state, ownerId: 'o1',
    ensureBinding: async () => {
      attempts += 1;
      await ensure();
      const created = { sandboxId: `new-${attempts}`, template: 't', linkId: 'l2' };
      state.set(created);
      return created;
    },
    sleep: async (ms) => void sleeps.push(ms),
    ...(waitMs === undefined ? {} : { waitMs }),
  });
  return { dir, file, state, store, pool, destroyed, sleeps, recovery, attempts: () => attempts };
}

describe('recovery run', () => {
  it('archives the binding with a reason, drops the pool, destroys the old computer, creates a new one and audits it', async () => {
    const f = setup(async () => undefined);
    await f.recovery.recover('old-computer-id', 'gone', new AbortController().signal);
    expect(f.state.get()?.sandboxId).toBe('new-1');
    expect(f.pool.entries()).toEqual([]);
    expect(f.destroyed).toEqual(['old-computer-id']);
    const archive = join(f.dir, 'owners', 'h', ARCHIVE_DIR);
    const [name] = readdirSync(archive);
    expect(JSON.parse(readFileSync(join(archive, name ?? ''), 'utf8'))).toMatchObject({ reason: 'gone', binding: { sandboxId: 'old-computer-id' } });
    const audit = (await f.store.list('audit', { limit: 10 })).items;
    expect(audit.map((entry) => entry.action)).toEqual(['computer.recreated']);
  });

  it('keeps trying with growing delays until the create works, auditing every failed attempt', async () => {
    let failures = 3;
    const f = setup(async () => { if (failures-- > 0) throw unavailable('image missing'); });
    await f.recovery.recover('old-computer-id', 'gone', new AbortController().signal);
    expect(f.sleeps).toEqual([5_000, 10_000, 20_000]);
    expect(f.state.get()?.sandboxId).toBe('new-4');
    const actions = (await f.store.list('audit', { limit: 10 })).items.map((entry) => entry.action).sort();
    expect(actions).toEqual(['computer.recreate_failed', 'computer.recreate_failed', 'computer.recreate_failed', 'computer.recreated']);
  });

  it('concurrent callers join one recovery; a caller that runs out of time hears "computer_recovering"', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = setup(() => gate, 20);
    const first = f.recovery.recover('old-computer-id', 'gone', new AbortController().signal);
    const second = f.recovery.recover('old-computer-id', 'gone', new AbortController().signal);
    await expect(first).rejects.toMatchObject({ code: 'computer_recovering' });
    await expect(second).rejects.toBeInstanceOf(ComputerdError);
    release();
    await vi.waitFor(() => expect(f.state.get()?.sandboxId).toBe('new-1'));
    expect(f.attempts()).toBe(1);
    // Already replaced: a late caller with the old id just proceeds.
    await f.recovery.recover('old-computer-id', 'gone', new AbortController().signal);
    expect(f.attempts()).toBe(1);
  });
});

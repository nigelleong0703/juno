/**
 * The single-instance lock of agentd: a second holder gets nothing until the first lets go (or dies).
 * Postgres runs on a throwaway embedded cluster.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { acquireInstanceLock, tryLockPostgres } from '../instance-lock.js';

let dir: string;
let pg: EmbeddedPostgres;
let url: string;

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'instance-lock-'));
  const port = await freePort();
  pg = new EmbeddedPostgres({ databaseDir: join(dir, 'pg'), port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => undefined, onError: () => undefined });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('scratch');
  url = `postgres://postgres:postgres@127.0.0.1:${String(port)}/scratch`;
}, 180_000);

afterAll(async () => {
  await pg?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('Postgres instance lock', () => {
  it('a second acquire gets null while the first holds it, and the lock is free again after release', async () => {
    const lost = vi.fn();
    const first = await tryLockPostgres(url, lost);
    expect(first).not.toBeNull();
    expect(await tryLockPostgres(url, lost)).toBeNull();
    expect(await tryLockPostgres(url, lost)).toBeNull();

    await first?.release();
    const second = await tryLockPostgres(url, lost);
    expect(second).not.toBeNull();
    await second?.release();
    // A release and an unsuccessful try are not "lost".
    expect(lost).not.toHaveBeenCalled();
  });

  it('acquireInstanceLock waits (starting nothing) until the holder lets go', async () => {
    const lost = vi.fn();
    const holder = await tryLockPostgres(url, lost);
    expect(holder).not.toBeNull();
    let acquired = false;
    const waiting = acquireInstanceLock(url, { onLost: lost, retryMs: 50 }).then((lock) => { acquired = true; return lock; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(acquired).toBe(false);

    await holder?.release();
    const lock = await waiting;
    expect(acquired).toBe(true);
    await lock.release();
    expect(lost).not.toHaveBeenCalled();
  });

  it('acquireInstanceLock does nothing without a database URL', async () => {
    const onLost = vi.fn();
    await (await acquireInstanceLock(undefined, { onLost })).release();
    await (await acquireInstanceLock('', { onLost })).release();
    expect(onLost).not.toHaveBeenCalled();
  });

  it('reports a lost lock when the holding connection is terminated', async () => {
    const lost = vi.fn();
    const held = await tryLockPostgres(url, lost);
    expect(held).not.toBeNull();
    const admin = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await admin`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'juno-agentd-lock'`;
      await vi.waitFor(() => expect(lost).toHaveBeenCalledTimes(1), { timeout: 5000 });
    } finally {
      await admin.end();
    }
  });
});

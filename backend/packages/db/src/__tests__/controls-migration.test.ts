/**
 * Control rows on Postgres (BACKEND 7.8b). Migration 0058 on a scratch database moves a screen the person holds into `controls` and
 * strips the old fields from every screen row. Then the locking the control gateway relies on, against a real database: two
 * transactions that lock a screen's row and flip its control row can never both win, even for a screen that has no control row yet.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ControlState, ScreenDoc } from '@agent-desktop/contracts';
import { createPostgresStore } from '../postgres-store.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PG_MIGRATIONS = resolve(HERE, '../../migrations');
const PG_FILE = '0059_controls.sql';
const AT = '2026-10-29T01:02:03.000Z';

const screen = (id: string, extra: Record<string, unknown> = {}) => ({
  id, ownerId: 'owner-a', computerId: 'sbx', agentId: `agent-${id}`, displayNo: 1, state: 'live', title: 't', resolution: '1x1', lastUsedAt: AT, lastVncPort: 5901, lastWebPort: 6081, ...extra,
});

describe('Postgres 0059', () => {
  let dir: string;
  let pg: EmbeddedPostgres;
  let sql: ReturnType<typeof postgres>;
  let url: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'controls-migration-pg-'));
    const port = await new Promise<number>((done) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const free = (server.address() as { port: number }).port;
        server.close(() => done(free));
      });
    });
    pg = new EmbeddedPostgres({ databaseDir: join(dir, 'pg'), port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => undefined, onError: () => undefined });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('scratch');
    url = `postgres://postgres:postgres@127.0.0.1:${String(port)}/scratch`;
    sql = postgres(url, { onnotice: () => undefined });
    for (const file of readdirSync(PG_MIGRATIONS).filter((f) => f.endsWith('.sql') && f < PG_FILE).sort()) await sql.unsafe(readFileSync(join(PG_MIGRATIONS, file), 'utf8'));
    const rows: Array<[string, Record<string, unknown>]> = [
      ['held', screen('held', { controller: 'user', controllerSince: AT, takeover: { pid: '41', tabs: [{ tab: 't1', url: 'https://a.test/', title: 'A' }], blockedAt: AT } })],
      ['idle', screen('idle', { controller: 'agent', controllerSince: AT })],
    ];
    for (const [id, doc] of rows) await sql`INSERT INTO screens (id, owner_id, agent_id, doc) VALUES (${id}, 'owner-a', ${String(doc['agentId'])}, ${sql.json(doc as never)})`;
    await sql.unsafe(readFileSync(join(PG_MIGRATIONS, PG_FILE), 'utf8'));
    await sql.unsafe(readFileSync(join(PG_MIGRATIONS, PG_FILE), 'utf8'));
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await pg?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('moves a screen the person holds into a control row, once, and strips the old fields from every screen', async () => {
    const controls = await sql<Array<{ id: string; doc: ControlState }>>`SELECT id, doc FROM controls`;
    expect(controls.map((row) => row.id)).toEqual(['screen:held']);
    expect(controls[0]?.doc).toMatchObject({
      holder: 'user', epoch: 1, since: AT, agentId: 'agent-held', blockedAt: AT, resumeSnapshotRequired: false,
      before: { pid: '41', tabs: [{ tab: 't1' }] }, surface: { kind: 'screen', screenId: 'held' },
    });
    expect(controls[0]?.doc.before).not.toHaveProperty('blockedAt');
    const screens = await sql<Array<{ doc: Record<string, unknown> }>>`SELECT doc FROM screens`;
    for (const row of screens) for (const key of ['controller', 'controllerSince', 'takeover']) expect(row.doc).not.toHaveProperty(key);
  });

  it('two transactions flipping the control row of the same screen cannot both win, with or without a control row', async () => {
    const store = await createPostgresStore(url);
    try {
      const scoped = store.forOwner?.('owner-a');
      if (!scoped) throw new Error('scoped store required');
      await scoped.put('screens', screen('fresh') as ScreenDoc);
      // The gateway's change: lock the screen row, re-read the control row, flip only if the agent still holds it.
      const take = (id: string) => scoped.tx(async (tx) => {
        await tx.getForUpdate?.('screens', id);
        const current = await tx.get('controls', `screen:${id}`);
        if (current?.holder === 'user') return false;
        await new Promise((resolve) => setTimeout(resolve, 30));
        await tx.put('controls', {
          id: `screen:${id}`, ownerId: 'owner-a', surface: { kind: 'screen', screenId: id }, holder: 'user', epoch: (current?.epoch ?? 0) + 1, since: AT,
          resumeSnapshotRequired: false, capabilities: { take: true, stop: false, resumeRemote: true },
        });
        return true;
      });
      for (const id of ['fresh', 'idle']) {
        const results = await Promise.all([take(id), take(id), take(id)]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect((await scoped.get('controls', `screen:${id}`))?.epoch).toBe(1);
      }
    } finally {
      await store.close();
    }
  });
});

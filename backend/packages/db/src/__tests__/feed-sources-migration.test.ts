/**
 * Migration 0024 on a scratch database: every feed source becomes a plain routine for the same owner and agent (the hidden
 * routine converted in place, no duplicate), posts point at the routine, and the feed_sources table is gone.
 * Boots its own throwaway embedded Postgres; touches no running database.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { feedPostSchema, routineSchema } from '@agent-desktop/public-contracts';

const MIGRATIONS = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../migrations');
const CONVERT = '0024_feed_sources_to_routines.sql';
const NOW = '2026-10-10T00:00:00.000Z';

let dir: string;
let pg: EmbeddedPostgres;
let sql: ReturnType<typeof postgres>;

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

const apply = async (file: string): Promise<void> => { await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8')); };
const insert = (table: string, id: string, owner: string, doc: Record<string, unknown>) =>
  sql`INSERT INTO ${sql(table)} (id, owner_id, agent_id, status, kind, doc) VALUES (${id}, ${owner}, ${String(doc['agentId'] ?? '')}, ${String(doc['status'] ?? '')}, ${typeof doc['kind'] === 'string' ? doc['kind'] : null}, ${sql.json(doc as never)})`;

const source = (id: string, extra: Record<string, unknown>) => ({
  id, agentId: 'agent-1', kind: 'news', title: 'Tech news', instructions: 'Apple, AI news', schedule: { kind: 'daily', time: '07:30' },
  notify: false, enabled: true, timezone: 'Asia/Singapore', createdAt: NOW, ...extra,
});
const hiddenRoutine = (sourceId: string, extra: Record<string, unknown> = {}) => ({
  id: 'rtn-' + sourceId, ownerId: 'owner-a', agentId: 'agent-1', name: 'Feed: x', instructions: 'old',
  trigger: { kind: 'schedule', cron: '30 7 * * *', human: 'Every day at 07:30 (Asia/Singapore)', tz: 'Asia/Singapore' },
  delivery: { channel: 'chat', target: 'conv-1' }, notify: { mode: 'never' }, enabled: true, status: 'active', feedSourceId: sourceId,
  runs: [{ id: 'rr-1', routineId: 'rtn-' + sourceId, status: 'completed', summary: 'ok', startedAt: NOW }], createdAt: NOW, ...extra,
});
const post = (id: string, extra: Record<string, unknown>) => ({ id, ownerId: 'owner-a', agentId: 'agent-1', title: id, summary: 's', liked: false, createdAt: NOW, updatedAt: NOW, ...extra });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'feed-migration-'));
  const port = await freePort();
  pg = new EmbeddedPostgres({ databaseDir: join(dir, 'pg'), port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => undefined, onError: () => undefined });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('scratch');
  sql = postgres(`postgres://postgres:postgres@127.0.0.1:${String(port)}/scratch`, { onnotice: () => undefined });
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f < CONVERT).sort()) await apply(file);

  await insert('agents', 'agent-1', 'owner-a', { id: 'agent-1' });
  await insert('agents', 'agent-b', 'owner-b', { id: 'agent-b' });
  await insert('feed_sources', 'fsrc-news', 'owner-a', source('fsrc-news', {}));
  await insert('routines', 'rtn-fsrc-news', 'owner-a', hiddenRoutine('fsrc-news'));
  await insert('feed_sources', 'fsrc-watch', 'owner-a', source('fsrc-watch', { kind: 'watch', title: 'Acme updates', instructions: 'News about Acme', schedule: { kind: 'weekly', day: 'mon', time: '09:05' }, notify: true, enabled: false }));
  await insert('routines', 'rtn-fsrc-watch', 'owner-a', hiddenRoutine('fsrc-watch', { enabled: false, notify: { mode: 'never' } }));
  // A source whose routine row is missing gets one built from its schedule.
  await insert('feed_sources', 'fsrc-brief', 'owner-a', source('fsrc-brief', { kind: 'brief', title: 'Morning brief', instructions: 'My day', schedule: { kind: 'daily', time: '07:00', days: ['fri', 'mon', 'mon'] }, notify: true, timezone: 'UTC' }));
  // Another owner's plain routine and a source of theirs stay theirs.
  await insert('routines', 'rtn-plain', 'owner-b', { ...hiddenRoutine('x'), id: 'rtn-plain', ownerId: 'owner-b', name: 'Plain', instructions: 'mine', feedSourceId: undefined });
  await insert('feed_sources', 'fsrc-b', 'owner-b', source('fsrc-b', { agentId: 'agent-b' }));
  // A source whose agent is gone has nothing to run: no routine is made for it.
  await insert('feed_sources', 'fsrc-orphan', 'owner-b', source('fsrc-orphan', { agentId: 'agent-deleted' }));

  await insert('feed_posts', 'p-news', 'owner-a', post('p-news', { sourceId: 'fsrc-news', kind: 'news', sourceUrl: 'https://example.com/a' }));
  await insert('feed_posts', 'p-gone', 'owner-a', post('p-gone', { sourceId: 'fsrc-deleted', kind: 'email' }));
  await insert('feed_posts', 'p-own', 'owner-a', post('p-own', {}));
  await apply(CONVERT);
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await pg?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const routineDoc = async (id: string) => (await sql<Array<{ doc: Record<string, unknown> }>>`SELECT doc FROM routines WHERE id = ${id}`)[0]?.doc;

describe('migration 0024: feed sources become routines', () => {
  it('converts each hidden routine in place: name, instructions with a kind line, notify, schedule, enabled and history kept', async () => {
    const news = routineSchema.parse(await routineDoc('rtn-fsrc-news'));
    expect(news).toMatchObject({ name: 'Tech news', enabled: true, notify: { mode: 'never' }, trigger: { cron: '30 7 * * *', tz: 'Asia/Singapore' }, delivery: { target: 'conv-1' } });
    expect(news.instructions).toMatch(/^Apple, AI news\n\nFind the latest on these topics and post one digest to the Feed/);
    expect(news.runs).toHaveLength(1);
    expect(await routineDoc('rtn-fsrc-news')).not.toHaveProperty('feedSourceId');

    const watch = routineSchema.parse(await routineDoc('rtn-fsrc-watch'));
    expect(watch).toMatchObject({ name: 'Acme updates', enabled: false, notify: { mode: 'always' } });
    expect(watch.instructions).toMatch(/^News about Acme\n\nCheck this and post to the Feed only if it changed/);
  });

  it('creates the missing routine from the schedule, and no routine twice', async () => {
    const brief = routineSchema.parse(await routineDoc('rtn-fsrc-brief'));
    expect(brief).toMatchObject({ name: 'Morning brief', agentId: 'agent-1', enabled: true, notify: { mode: 'always' }, trigger: { cron: '0 7 * * 1,5', tz: 'UTC' }, delivery: { channel: 'chat' } });
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM routines WHERE owner_id = 'owner-a' ORDER BY id`;
    expect(rows.map((r) => r.id)).toEqual(['rtn-fsrc-brief', 'rtn-fsrc-news', 'rtn-fsrc-watch']);
    // The watch source's weekly schedule survives as the routine's own cron (checked on the converted row).
    expect((await routineDoc('rtn-fsrc-watch') as { trigger: { cron: string } }).trigger.cron).toBe('30 7 * * *');
  });

  it('leaves another owner\'s routine alone, and converts their source too', async () => {
    expect(await routineDoc('rtn-plain')).toMatchObject({ name: 'Plain', instructions: 'mine' });
    expect(routineSchema.parse(await routineDoc('rtn-fsrc-b'))).toMatchObject({ name: 'Tech news', agentId: 'agent-b' });
    expect(await sql`SELECT id FROM routines WHERE doc ? 'feedSourceId'`).toHaveLength(0);
    expect(await routineDoc('rtn-fsrc-orphan')).toBeUndefined();
  });

  it('points posts at their routine where it exists, drops sourceId and kind, keeps content', async () => {
    const rows = await sql<Array<{ id: string; kind: string | null; doc: Record<string, unknown> }>>`SELECT id, kind, doc FROM feed_posts ORDER BY id`;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(feedPostSchema.parse(byId['p-news']?.doc)).toMatchObject({ routineId: 'rtn-fsrc-news', title: 'p-news', sourceUrl: 'https://example.com/a' });
    expect(byId['p-gone']?.doc).not.toHaveProperty('routineId');
    for (const row of rows) {
      expect(row.doc).not.toHaveProperty('sourceId');
      expect(row.doc).not.toHaveProperty('kind');
      expect(row.kind).toBeNull();
    }
  });

  it('drops the feed_sources table', async () => {
    expect(await sql`SELECT to_regclass('public.feed_sources') AS t`).toEqual([{ t: null }]);
  });
});

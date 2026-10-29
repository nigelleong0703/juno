/**
 * Postgres 0036 on a scratch database: a stranger's platform message (stored with the owner's id as author until
 * contract 0.46.0) gets the synthetic author id `ext-<kind>-<first 16 hex of sha256(externalId)>`, the same value agentd's
 * `channelAuthorId` writes today; the owner's own messages, app messages, other owners' rows and rows already rewritten stay as they are.
 * Boots its own throwaway embedded Postgres; touches no running database.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PG_MIGRATIONS = resolve(HERE, '../../migrations');
const PG_FILE = '0036_stranger_author_ids.sql';
const AT = '2026-10-22T00:00:00.000Z';

/** The formula agentd's `channelAuthorId` uses. */
const synthetic = (kind: string, externalId: string): string => 'ext-' + kind + '-' + createHash('sha256').update(externalId).digest('hex').slice(0, 16);

const item = (id: string, authorId: string, extra: Record<string, unknown> = {}) =>
  ({ id, conversationId: 'cvn-1', type: 'user_message', at: AT, authorId, text: 'hi', attachments: [], mentions: [], ...extra });
const sender = (kind: string, externalId: string, role: 'owner' | 'stranger') => ({ channelSender: { kind, externalId, name: 'Someone', role } });

/** [row id, owner, doc]. A stranger with a non-ASCII id checks the UTF-8 hashing agrees on both sides. */
const ROWS: Array<[string, string, Record<string, unknown>]> = [
  ['stranger-1', 'owner-a', item('stranger-1', 'owner-a', sender('telegram', 'user-9', 'stranger'))],
  ['stranger-2', 'owner-a', item('stranger-2', 'owner-a', sender('discord', '张伟 #12', 'stranger'))],
  ['owner-said', 'owner-a', item('owner-said', 'owner-a', sender('telegram', 'user-7', 'owner'))],
  ['typed-in-app', 'owner-a', item('typed-in-app', 'owner-a')],
  ['other-owner', 'owner-b', item('other-owner', 'owner-b', sender('slack', 'U123', 'stranger'))],
  ['done-already', 'owner-a', item('done-already', synthetic('telegram', 'user-9'), sender('telegram', 'user-9', 'stranger'))],
  ['agent-reply', 'owner-a', { id: 'agent-reply', conversationId: 'cvn-1', type: 'agent_message', at: AT, agentId: 'agent-1', markdown: 'ok', citations: [] }],
];

const EXPECTED: Record<string, string | undefined> = {
  'stranger-1': synthetic('telegram', 'user-9'),
  'stranger-2': synthetic('discord', '张伟 #12'),
  'owner-said': 'owner-a',
  'typed-in-app': 'owner-a',
  'other-owner': synthetic('slack', 'U123'),
  'done-already': synthetic('telegram', 'user-9'),
  'agent-reply': undefined,
};

describe('Postgres 0036', () => {
  let dir: string;
  let pg: EmbeddedPostgres;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'author-migration-pg-'));
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
    sql = postgres(`postgres://postgres:postgres@127.0.0.1:${String(port)}/scratch`, { onnotice: () => undefined });
    for (const file of readdirSync(PG_MIGRATIONS).filter((f) => f.endsWith('.sql') && f < PG_FILE).sort()) await sql.unsafe(readFileSync(join(PG_MIGRATIONS, file), 'utf8'));
    for (const [id, owner, doc] of ROWS) {
      await sql`INSERT INTO items (id, owner_id, conversation_id, kind, doc) VALUES (${id}, ${owner}, 'cvn-1', ${String(doc['type'])}, ${sql.json(doc as never)})`;
    }
    await sql.unsafe(readFileSync(join(PG_MIGRATIONS, PG_FILE), 'utf8'));
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await pg?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites only the stranger rows that carry the owner id, to the value agentd writes', async () => {
    const rows = await sql<Array<{ id: string; doc: { authorId?: string } }>>`SELECT id, doc FROM items`;
    expect(rows).toHaveLength(ROWS.length);
    for (const row of rows) expect(row.doc.authorId, row.id).toBe(EXPECTED[row.id]);
  });

  it('is safe to run again', async () => {
    await sql.unsafe(readFileSync(join(PG_MIGRATIONS, PG_FILE), 'utf8'));
    const rows = await sql<Array<{ id: string; doc: { authorId?: string } }>>`SELECT id, doc FROM items`;
    for (const row of rows) expect(row.doc.authorId, row.id).toBe(EXPECTED[row.id]);
  });
});

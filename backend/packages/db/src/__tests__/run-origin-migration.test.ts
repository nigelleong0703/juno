/**
 * Postgres 0056 on a scratch database: old runs get an origin derived from `kind` (children get a parent_run origin and the root's
 * origin as rootOrigin), audit rows get the root origin of their run plus `unattended`, and the generated `initiator` / `unattended`
 * columns serve the audit filters. Boots its own throwaway embedded Postgres; touches no running database.
 */
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
const PG_FILE = '0056_run_origin.sql';
const AT = '2026-10-22T00:00:00.000Z';

const run = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, agentId: 'agent-1', conversationId: 'cvn-1', title: 't', kind, startedAt: AT, ...extra });
const audit = (id: string, runId: string | undefined) => ({ id, at: AT, actor: 'agent', action: 'tool.policy', decision: 'asked', reason: 'r', ...(runId === undefined ? {} : { runId }) });

const RUNS: Array<[string, string, Record<string, unknown>]> = [
  ['run-chat', 'owner-a', run('run-chat', 'chat')],
  ['run-routine', 'owner-a', run('run-routine', 'routine')],
  ['run-child', 'owner-a', run('run-child', 'background', { parentRunId: 'run-routine' })],
  ['run-grandchild', 'owner-a', run('run-grandchild', 'background', { parentRunId: 'run-child' })],
  ['run-orphan', 'owner-a', run('run-orphan', 'background', { parentRunId: 'run-gone' })],
  ['run-b', 'owner-b', run('run-b', 'chat', { conversationId: 'cvn-b' })],
  ['run-has-origin', 'owner-a', run('run-has-origin', 'routine', { origin: { type: 'routine', routineId: 'rt-1', occurrenceAt: AT } })],
];
const AUDITS: Array<[string, string, string | undefined]> = [
  ['aud-chat', 'owner-a', 'run-chat'],
  ['aud-grandchild', 'owner-a', 'run-grandchild'],
  ['aud-has-origin', 'owner-a', 'run-has-origin'],
  ['aud-orphan-run', 'owner-a', 'run-orphan'],
  ['aud-no-run', 'owner-a', undefined],
  ['aud-other-owner', 'owner-b', 'run-chat'],
];

describe('Postgres 0056', () => {
  let dir: string;
  let pg: EmbeddedPostgres;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'origin-migration-pg-'));
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
    for (const [id, owner, doc] of RUNS) await sql`INSERT INTO runs (id, owner_id, doc) VALUES (${id}, ${owner}, ${sql.json(doc as never)})`;
    for (const [id, owner, runId] of AUDITS) await sql`INSERT INTO audit (id, owner_id, run_id, doc) VALUES (${id}, ${owner}, ${runId ?? null}, ${sql.json(audit(id, runId) as never)})`;
    await sql.unsafe(readFileSync(join(PG_MIGRATIONS, PG_FILE), 'utf8'));
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await pg?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const origins = async () => Object.fromEntries((await sql<Array<{ id: string; doc: { origin?: unknown; rootOrigin?: unknown } }>>`SELECT id, doc FROM runs`).map((r) => [r.id, r.doc]));

  it('derives a run origin from kind, and a child gets the root of its chain', async () => {
    const runs = await origins();
    expect(runs['run-chat']?.origin).toEqual({ type: 'owner_message', conversationId: 'cvn-1' });
    expect(runs['run-b']?.origin).toEqual({ type: 'owner_message', conversationId: 'cvn-b' });
    expect(runs['run-routine']?.origin).toEqual({ type: 'system', wakeKind: 'routine' });
    expect(runs['run-child']?.origin).toEqual({ type: 'parent_run', runId: 'run-routine' });
    expect(runs['run-child']?.rootOrigin).toEqual({ type: 'system', wakeKind: 'routine' });
    expect(runs['run-grandchild']?.origin).toEqual({ type: 'parent_run', runId: 'run-child' });
    expect(runs['run-grandchild']?.rootOrigin).toEqual({ type: 'system', wakeKind: 'routine' });
    expect(runs['run-orphan']?.rootOrigin).toMatchObject({ type: 'system', wakeKind: 'child_task' });
    expect(runs['run-has-origin']?.origin).toEqual({ type: 'routine', routineId: 'rt-1', occurrenceAt: AT });
  });

  it('gives each audit row its run root origin, and a system origin when it has no run', async () => {
    const rows = await sql<Array<{ id: string; initiator: string; unattended: boolean; doc: { initiator: unknown } }>>`SELECT id, initiator, unattended, doc FROM audit`;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by['aud-chat']).toMatchObject({ initiator: 'owner_message', unattended: false });
    expect(by['aud-grandchild']).toMatchObject({ initiator: 'system', unattended: true, doc: { initiator: { type: 'system', wakeKind: 'routine' } } });
    expect(by['aud-has-origin']).toMatchObject({ initiator: 'routine', unattended: true });
    expect(by['aud-orphan-run']).toMatchObject({ initiator: 'system', unattended: true });
    expect(by['aud-no-run']).toMatchObject({ initiator: 'system', unattended: true });
    // The other owner's audit row points at a run id that is not theirs, so it is not attributed to the first owner's chat run.
    expect(by['aud-other-owner']).toMatchObject({ initiator: 'system', unattended: true });
  });

  it('is safe to run again', async () => {
    const before = await origins();
    await sql.unsafe(readFileSync(join(PG_MIGRATIONS, PG_FILE), 'utf8'));
    expect(await origins()).toEqual(before);
  });
});

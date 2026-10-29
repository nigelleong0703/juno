/**
 * The task tree's storage (BACKEND 6.5) on Postgres. Migration 0057 on a scratch database: existing child runs get their
 * parent link, root and depth, blocked runs a cause, runs with a review card an effect-review flag, background jobs their root
 * and (for a stopped MCP call) an unconfirmed stop. Then the store itself: a child run's parent link is written when the run is
 * (it never was), and a keyset position over rows that start at the same instant neither repeats nor skips a row.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeScratchPostgres, scratchPostgresUrl, uid } from './store-backends';
import { createPostgresStore } from '../postgres-store.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PG_MIGRATIONS = resolve(HERE, '../../migrations');
const PG_FILE = '0057_task_tree.sql';
const AT = '2026-10-28T00:00:00.000Z';

const run = (id: string, extra: Record<string, unknown> = {}) => ({ id, agentId: 'agent-1', conversationId: 'cvn-1', title: 't', kind: 'chat', status: 'completed', startedAt: AT, ...extra });
const job = (id: string, extra: Record<string, unknown> = {}) => ({ id, agentId: 'agent-1', conversationId: 'cvn-1', runId: 'run-root', kind: 'shell', label: 'l', status: 'completed', startedAt: AT, ...extra });
const review = (id: string, runId: string, state: string) => ({ id, kind: 'question', status: state === 'pending' ? 'pending' : 'answered', runId, reconciliation: { state } });

const RUNS: Array<[string, string, Record<string, unknown>]> = [
  ['run-root', 'owner-a', run('run-root')],
  ['run-child', 'owner-a', run('run-child', { kind: 'background', parentRunId: 'run-root' })],
  ['run-grandchild', 'owner-a', run('run-grandchild', { kind: 'background', parentRunId: 'run-child' })],
  ['run-orphan', 'owner-a', run('run-orphan', { kind: 'background', parentRunId: 'run-gone' })],
  ['run-orphan-kid', 'owner-a', run('run-orphan-kid', { kind: 'background', parentRunId: 'run-orphan' })],
  ['run-routine', 'owner-a', run('run-routine', { kind: 'routine', routineId: 'rt-1' })],
  ['run-b-child', 'owner-b', run('run-b-child', { kind: 'background', parentRunId: 'run-root' })],
  ['blocked-input', 'owner-a', run('blocked-input', { status: 'blocked', error: 'run blocked: tasks need input: ship it' })],
  ['blocked-default', 'owner-a', run('blocked-default', { status: 'blocked' })],
  ['blocked-steps', 'owner-a', run('blocked-steps', { status: 'blocked', error: 'run blocked: the step limit was reached before the run produced a final answer' })],
  ['blocked-stalled', 'owner-a', run('blocked-stalled', { status: 'blocked', error: 'run blocked: no progress on 2 open task(s): a, b' })],
  ['blocked-checks', 'owner-a', run('blocked-checks', { status: 'blocked', error: 'run blocked: configured completion checks did not pass (x)' })],
  ['blocked-unreadable', 'owner-a', run('blocked-unreadable', { status: 'blocked', error: 'run blocked: task state unreadable (bad)' })],
  ['blocked-budget', 'owner-a', run('blocked-budget', { status: 'blocked', error: 'run blocked: the cost budget is spent' })],
  ['with-open-review', 'owner-a', run('with-open-review')],
  ['with-settled-review', 'owner-a', run('with-settled-review')],
];
const REQUESTS: Array<[string, string, string, Record<string, unknown>]> = [
  ['rq-1', 'owner-a', 'with-open-review', review('rq-1', 'with-open-review', 'still_unknown')],
  ['rq-2', 'owner-a', 'with-settled-review', review('rq-2', 'with-settled-review', 'user_reported_succeeded')],
  ['rq-3', 'owner-a', 'with-settled-review', review('rq-3', 'with-settled-review', 'retry_completed')],
  ['rq-plain', 'owner-a', 'run-root', { id: 'rq-plain', kind: 'approval', status: 'pending', runId: 'run-root' }],
];
const JOBS: Array<[string, string, Record<string, unknown>]> = [
  ['shell-1', 'owner-a', job('shell-1')],
  ['mcp-stopped', 'owner-a', job('mcp-stopped', { kind: 'mcp', status: 'stopped', runId: 'run-grandchild' })],
  ['mcp-done', 'owner-a', job('mcp-done', { kind: 'mcp' })],
  ['shell-stopped', 'owner-a', job('shell-stopped', { status: 'stopped' })],
];

describe('Postgres 0057', () => {
  let dir: string;
  let pg: EmbeddedPostgres;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'task-tree-migration-pg-'));
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
    for (const [id, owner, runId, doc] of REQUESTS) await sql`INSERT INTO requests (id, owner_id, run_id, doc) VALUES (${id}, ${owner}, ${runId}, ${sql.json(doc as never)})`;
    for (const [id, owner, doc] of JOBS) await sql`INSERT INTO background_tasks (id, owner_id, run_id, doc) VALUES (${id}, ${owner}, ${String(doc['runId'])}, ${sql.json(doc as never)})`;
    await sql.unsafe(readFileSync(join(PG_MIGRATIONS, PG_FILE), 'utf8'));
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await pg?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const runs = async () => Object.fromEntries((await sql<Array<{ id: string; parent_id: string | null; routine_id: string | null; doc: Record<string, unknown> }>>`SELECT id, parent_id, routine_id, doc FROM runs`).map((r) => [r.id, r]));

  it('writes the parent link of every child run, and the routine column serves routine runs', async () => {
    const rows = await runs();
    expect(rows['run-child']?.parent_id).toBe('run-root');
    expect(rows['run-grandchild']?.parent_id).toBe('run-child');
    expect(rows['run-orphan']?.parent_id).toBe('run-gone');
    expect(rows['run-root']?.parent_id).toBeNull();
    expect(rows['run-routine']?.routine_id).toBe('rt-1');
    expect(rows['run-root']?.routine_id).toBeNull();
  });

  it('gives each child its root and depth; a child whose parent is gone starts its own tree', async () => {
    const rows = await runs();
    expect(rows['run-child']?.doc).toMatchObject({ rootRunId: 'run-root', depth: 1 });
    expect(rows['run-grandchild']?.doc).toMatchObject({ rootRunId: 'run-root', depth: 2 });
    expect(rows['run-b-child']?.doc['rootRunId']).toBeUndefined();
    expect(rows['run-orphan']?.doc['rootRunId']).toBeUndefined();
    expect(rows['run-orphan-kid']?.doc).toMatchObject({ rootRunId: 'run-orphan', depth: 1 });
    expect(rows['run-root']?.doc['rootRunId']).toBeUndefined();
  });

  it('derives the cause of each blocked run from its reason', async () => {
    const rows = await runs();
    const cause = (id: string) => rows[id]?.doc['blockCause'];
    expect(cause('blocked-input')).toBe('needs_input');
    expect(cause('blocked-default')).toBe('needs_input');
    expect(cause('blocked-steps')).toBe('limit');
    expect(cause('blocked-stalled')).toBe('no_progress');
    expect(cause('blocked-checks')).toBe('verification');
    expect(cause('blocked-unreadable')).toBe('unreadable');
    expect(cause('blocked-budget')).toBe('limit');
    expect(cause('run-root')).toBeUndefined();
  });

  it('flags a run with an unsettled review card open and one with only settled cards resolved', async () => {
    const rows = await runs();
    expect(rows['with-open-review']?.doc['effectReview']).toBe('open');
    expect(rows['with-settled-review']?.doc['effectReview']).toBe('resolved');
    expect(rows['run-root']?.doc['effectReview']).toBeUndefined();
  });

  it('gives background jobs the root of their run, and a stopped MCP call an unconfirmed stop', async () => {
    const rows = Object.fromEntries((await sql<Array<{ id: string; doc: Record<string, unknown> }>>`SELECT id, doc FROM background_tasks`).map((r) => [r.id, r.doc]));
    expect(rows['shell-1']?.['rootRunId']).toBe('run-root');
    // A past stop has no delivery record: it stays a plain cancellation, not an unknown effect.
    expect(rows['mcp-stopped']).toMatchObject({ rootRunId: 'run-root' });
    expect(rows['mcp-stopped']?.['stopDelivery']).toBeUndefined();
    expect(rows['mcp-done']?.['stopDelivery']).toBeUndefined();
    expect(rows['shell-stopped']?.['stopDelivery']).toBeUndefined();
  });

  it('is safe to run again', async () => {
    const before = await runs();
    await sql.unsafe(readFileSync(join(PG_MIGRATIONS, PG_FILE), 'utf8'));
    expect(await runs()).toEqual(before);
  });
});

describe('the Postgres store under the task tree', () => {
  afterAll(closeScratchPostgres);

  it('writes a child run its parent link when the run is written, and reads children by it', async () => {
    const store = await createPostgresStore(await scratchPostgresUrl());
    try {
      const parent = uid('run');
      const child = uid('run');
      await store.put('runs', { ...run(parent, { ownerId: 'user-1' }) } as never);
      await store.put('runs', { ...run(child, { ownerId: 'user-1', kind: 'background', parentRunId: parent }) } as never);
      await store.patch('runs', child, { status: 'running' } as never);
      expect((await store.list('runs', { where: { parentId: parent } })).items.map((r) => r.id)).toEqual([child]);
      expect((await store.list('runs', { where: { hasParent: true, statuses: ['running'] } })).items.map((r) => r.id)).toContain(child);
    } finally {
      await store.close();
    }
  });

  it('pages rows that start at the same instant by a keyset position without repeating or skipping any', async () => {
    const store = await createPostgresStore(await scratchPostgresUrl());
    try {
      const agentId = uid('agent');
      // Ids chosen so the database's default collation (which ignores case and punctuation) and byte order disagree.
      const ids = ['shell-b', 'Shell_a', 'shell_c', 'mcp-1', 'Mcp.2', 'wait.2', 'wait-1'].map((id) => id + '-' + agentId);
      for (const id of ids) await store.put('backgroundTasks', { id, ownerId: 'user-1', agentId, conversationId: 'c', runId: 'r', kind: 'shell', label: 'l', notify: false, chainId: 'x', generation: 0, status: 'completed', startedAt: AT } as never);
      const byBytes = [...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      const seen: string[] = [];
      let keyset: { at: string; id: string } | undefined;
      for (;;) {
        const page = await store.list('backgroundTasks', { where: { agentId, statuses: ['completed'] }, orderBy: 'at', order: 'desc', limit: 3, ...(keyset === undefined ? {} : { keyset }) });
        seen.push(...page.items.map((row) => row.id));
        const last = page.items.at(-1);
        if (page.items.length < 3 || last === undefined) break;
        keyset = { at: last.startedAt, id: last.id };
      }
      expect(seen).toEqual(byBytes);
    } finally {
      await store.close();
    }
  });
});

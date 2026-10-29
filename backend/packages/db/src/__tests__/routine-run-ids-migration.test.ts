/**
 * Migration 0060: runs from before contract 0.68.0 get the routine that started them, read from the routine's own run history
 * (`routines.doc.runs[].runId`). Runs that fell off that list stay plain runs; another owner's routine never claims a run.
 * The scratch database is already migrated, so the rows are written as the old code left them and the file is applied again.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { closeScratchPostgres, scratchPostgresUrl, uid } from './store-backends';

afterAll(closeScratchPostgres);

const FILE = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../migrations/0061_routine_run_ids.sql');
const AT = '2026-10-20T08:00:00.000Z';

const runDoc = (id: string, extra: Record<string, unknown> = {}) => ({ id, agentId: 'agent-1', conversationId: 'cvn-1', title: 't', kind: 'routine', status: 'completed', startedAt: AT, origin: { type: 'system', wakeKind: 'routine' }, ...extra });

describe('Postgres 0060', () => {
  it('attributes routine runs from the routine history, and leaves everything else alone', async () => {
    const sql = postgres(await scratchPostgresUrl(), { onnotice: () => undefined });
    try {
      const [owner, other, routine, onlyOther] = [uid('owner'), uid('owner'), uid('rt'), uid('rt')];
      const [listed, child, unlisted, foreign, chat] = [uid('run'), uid('run'), uid('run'), uid('run'), uid('run')];
      const put = (table: string, id: string, ownerId: string, doc: Record<string, unknown>) =>
        sql`INSERT INTO ${sql(table)} (id, owner_id, doc) VALUES (${id}, ${ownerId}, ${sql.json(doc as never)})`;
      await put('routines', routine, owner, { id: routine, agentId: 'agent-1', runs: [{ id: 'rr-1', routineId: routine, runId: listed, startedAt: '2026-10-20T07:59:30.000Z' }, { id: 'rr-2', routineId: routine }] });
      await put('routines', onlyOther, other, { id: onlyOther, agentId: 'agent-2', runs: [{ id: 'rr-3', routineId: onlyOther, runId: foreign, startedAt: AT }] });
      await put('runs', listed, owner, runDoc(listed));
      await put('runs', child, owner, runDoc(child, { kind: 'background', parentRunId: listed, rootRunId: listed, depth: 1, origin: { type: 'parent_run', runId: listed }, rootOrigin: { type: 'system', wakeKind: 'routine' } }));
      await put('runs', unlisted, owner, runDoc(unlisted));
      // Same run id named by a routine of another owner: not attributed.
      await put('runs', foreign, owner, runDoc(foreign));
      await put('runs', chat, owner, runDoc(chat, { kind: 'chat', origin: { type: 'owner_message', conversationId: 'cvn-1' } }));

      await sql.unsafe(readFileSync(FILE, 'utf8'));
      await sql.unsafe(readFileSync(FILE, 'utf8'));

      const docs = Object.fromEntries((await sql<Array<{ id: string; doc: Record<string, unknown>; routine_id: string | null }>>`SELECT id, doc, routine_id FROM runs WHERE id IN ${sql([listed, child, unlisted, foreign, chat])}`).map((row) => [row.id, row]));
      expect(docs[listed]?.routine_id).toBe(routine);
      expect(docs[listed]?.doc['origin']).toEqual({ type: 'routine', routineId: routine, occurrenceAt: '2026-10-20T07:59:30.000Z' });
      // The child is not a routine run itself; it only takes the new root origin.
      expect(docs[child]?.routine_id).toBeNull();
      expect(docs[child]?.doc['rootOrigin']).toEqual(docs[listed]?.doc['origin']);
      expect(docs[unlisted]?.routine_id).toBeNull();
      expect(docs[foreign]?.routine_id).toBeNull();
      expect(docs[chat]?.routine_id).toBeNull();
      expect(docs[chat]?.doc['origin']).toEqual({ type: 'owner_message', conversationId: 'cvn-1' });
    } finally {
      await sql.end();
    }
  });
});

/**
 * Migration 0070: the old channel delivery receipts become outbox rows once. A `send` receipt is a sent row (so the start-up catch-up never sends that reply
 * again), a `send-failed` receipt with no `send` is a dropped row, an `output` receipt is a sent document row; the receipts go, other receipts stay.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { closeScratchPostgres, scratchPostgresUrl, uid } from './store-backends';

afterAll(closeScratchPostgres);

const FILE = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../migrations/0070_outbox.sql');

describe('Postgres 0070', () => {
  it('turns send / send-failed / output receipts into outbox rows, keeps other receipts, and a repeat changes nothing', async () => {
    const sql = postgres(await scratchPostgresUrl(), { onnotice: () => undefined });
    try {
      const owner = uid('owner');
      const [sent, failed, both, doc, posted] = [uid('itm'), uid('itm'), uid('itm'), uid('doc') + ':2', uid('posted')];
      const at = '2026-10-31T10:00:00.000Z';
      const receipts = [
        { id: uid('r'), type: 'send', eventId: sent },
        { id: uid('r'), type: 'send-failed', eventId: failed },
        { id: uid('r'), type: 'send-failed', eventId: both },
        { id: uid('r'), type: 'send', eventId: both },
        { id: uid('r'), type: 'output', eventId: doc },
        { id: uid('r'), type: 'posted', eventId: posted },
      ].map((receipt) => ({ ...receipt, source: 'channel', agentId: 'agent-1', conversationId: 'cvn-1', runId: 'run-1', consumedAt: at, createdAt: at }));
      for (const receipt of receipts) {
        await sql`INSERT INTO event_receipts (id, owner_id, agent_id, conversation_id, run_id, at, doc) VALUES (${receipt.id}, ${owner}, 'agent-1', 'cvn-1', 'run-1', ${at}, ${sql.json(receipt as never)})`;
      }

      await sql.unsafe(readFileSync(FILE, 'utf8'));
      await sql.unsafe(readFileSync(FILE, 'utf8'));

      const rows = await sql<Array<{ id: string; status: string; kind: string; doc: Record<string, unknown> }>>`SELECT id, status, kind, doc FROM outbox WHERE owner_id = ${owner}`;
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      expect(rows).toHaveLength(4);
      expect(byId['obx:reply:' + sent]).toMatchObject({ status: 'sent', kind: 'channel_reply', doc: { sourceId: sent, sentAt: expect.any(String), agentNotified: true } });
      expect(byId['obx:reply:' + failed]).toMatchObject({ status: 'dropped', doc: { droppedReason: 'retries_exhausted', agentNotified: true } });
      // A reply that failed once and went out on a replay is sent, not dropped.
      expect(byId['obx:reply:' + both]?.status).toBe('sent');
      expect(byId['obx:out:' + doc]).toMatchObject({ status: 'sent', kind: 'channel_output' });

      const left = await sql<Array<{ doc: { type: string } }>>`SELECT doc FROM event_receipts WHERE owner_id = ${owner}`;
      expect(left.map((row) => row.doc.type)).toEqual(['posted']);
    } finally {
      await sql.end();
    }
  });
});

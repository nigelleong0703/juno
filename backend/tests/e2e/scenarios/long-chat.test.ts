import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listRuns, queryStack, type Account } from '../harness/client';

/**
 * A long conversation on the durable runner: enough turns in one chat make the harness compact its context, and the
 * journal never grows with the length of the chat: it only holds the steps of invocations that are still running.
 * (Resuming a killed run is restart.exclusive.test.ts.)
 */
const TURNS = Number(process.env['LONG_CHAT_TURNS'] ?? 16);
// ~6k characters a turn: with the stack's small scripted context window the harness compacts after a dozen turns.
const FILLER = 'Notes for the record: the quarterly review covers hiring, budget, the roadmap and the open risks. '.repeat(60);

/** Saved steps of this chat's own invocations (its session and its runs): other scenarios run beside this one. */
async function journalRows(sessionKey: string, runIds: string[]): Promise<number> {
  const keys = [sessionKey, ...runIds];
  const rows = await queryStack(`SELECT count(*) AS n FROM journal j JOIN invocations i ON i.id = j.invocation_id WHERE i.key IN (${keys.map(() => '?').join(',')})`, keys);
  return Number(rows[0]?.['n']);
}

async function allDone(account: Account, conversationId: string, count: number): Promise<string[]> {
  for (let i = 0; i < 240; i += 1) {
    const runs = await listRuns(account, conversationId);
    if (runs.length >= count && runs.every((run) => ['completed', 'failed', 'stopped'].includes(run.status))) return runs.map((run) => run.id);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`runs did not finish (wanted ${String(count)})`);
}

describe('long chat', () => {
  it('compacts a long chat and keeps the journal small', async () => {
    const account = await createAccount('long-chat');
    const agent = await account.api('POST', '/v1/agents', { name: 'Marathon' });
    expect(agent.status).toBe(201);
    const first = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
    const conversationId: string = first.body.id;
    const sessionKey = `${agent.body.id}:${conversationId}`;
    let runIds: string[] = [];
    for (let turn = 1; turn <= TURNS; turn += 1) {
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: `Turn ${String(turn)}. ${FILLER}` }));
      expect(sent.status).toBe(202);
      runIds = await allDone(account, conversationId, turn);
    }

    const compactions = Number((await queryStack('SELECT count(*) AS n FROM compactions WHERE kind = ?', [sessionKey]))[0]?.['n']);
    expect(compactions).toBeGreaterThan(0);
    // Finished runs leave no steps behind, however long the chat.
    expect(await journalRows(sessionKey, runIds)).toBeLessThan(20);
  }, 300_000);
});

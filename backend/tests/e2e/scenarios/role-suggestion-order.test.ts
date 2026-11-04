import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listRuns, scriptModel, type Account } from '../harness/client';

type Item = { type: string; markdown?: string; at: string };
const listItems = async (account: Account, conversationId: string): Promise<Item[]> => (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`)).body.items as Item[];

/**
 * BACKEND §10.11: the once-per-agent role suggestion is written after the run that triggered it has finished its reply, never while a
 * run of the chat is working (the first outside user saw "机票优惠助手" appear in the middle of his flight search).
 */
const ROLE = '{"title":"Flight deals helper","description":"Finds the cheapest flights for you."}';
const ANSWER = 'The cheapest direct flight is S$120.';

describe('role suggestion timing', () => {
  it('lands after the final reply of the run whose message was the third, and only once', async () => {
    const account = await createAccount('role-order', 'Robin');
    const agentId: string = (await account.api('GET', '/v1/agents')).body.items[0].id;
    const conversationId: string = (await account.api('GET', '/v1/conversations')).body.items[0].id;
    const sessionKey = `${agentId}:${conversationId}`;
    scriptModel('aux:quick-text', [{ text: ROLE }]);
    scriptModel(sessionKey, [{ text: 'hello' }, { text: 'one' }, { text: 'two' }, { matchLastText: 'cheapest flight', text: ANSWER }]);
    // Wait for the n-th agent bubble and for every run to be over, so each message gets its own run.
    const settle = async (bubbles: number): Promise<void> => {
      for (let i = 0; i < 240; i += 1) {
        const said = (await listItems(account, conversationId)).filter((item) => item.type === 'agent_message').length;
        if (said >= bubbles && (await listRuns(account, conversationId)).every((run) => run.status === 'completed')) return;
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    await settle(1);
    for (const [index, text] of ['find flights', 'for next week', 'the cheapest flight from SIN to CSX on 3 Nov'].entries()) {
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }))).status).toBe(202);
      await settle(index + 2);
    }
    let items = await listItems(account, conversationId);
    for (let i = 0; i < 80 && !items.some((item) => item.type === 'role_suggestion'); i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      items = await listItems(account, conversationId);
    }
    const cards = items.filter((item) => item.type === 'role_suggestion');
    expect(cards, JSON.stringify(items.map((item) => [item.type, item.markdown ?? '']))).toHaveLength(1);
    const reply = items.find((item) => item.type === 'agent_message' && item.markdown === ANSWER);
    expect(reply, 'the answer to the third message was posted').toBeDefined();
    expect(Date.parse(String(cards[0]?.at)), 'the card comes after the final reply').toBeGreaterThan(Date.parse(String(reply?.at)));
  }, 120_000);
});

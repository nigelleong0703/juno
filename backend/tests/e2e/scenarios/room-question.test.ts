import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, listRuns, scriptModel } from '../harness/client';

/**
 * A question card asked in a mention-mode room: the person's answer becomes their next message and must wake the
 * agent that asked (the answer mentions it), and only that agent.
 */
const CARD = { version: 1, blocks: [{ type: 'choices', id: 'city', options: [{ id: 'sg', label: 'Singapore' }, { id: 'ldn', label: 'London' }] }] };

describe('room question', () => {
  it('wakes the asking agent when the card is answered, and no other member', async () => {
    const account = await createAccount('room-question');
    const events = await listenEvents(account.cookie);
    try {
      const ada = (await account.api('POST', '/v1/agents', { name: 'Ada' })).body.id as string;
      const bo = (await account.api('POST', '/v1/agents', { name: 'Bo' })).body.id as string;
      const created = await account.api('POST', '/v1/conversations', { kind: 'room', title: 'Trip', memberAgentIds: [ada, bo] });
      expect(created.status).toBe(201);
      const roomId: string = created.body.id;
      const done = `ANSWERED-${randomUUID().slice(0, 8)}`;
      scriptModel(`${ada}:${roomId}`, [
        { toolCalls: [{ id: 'ask', name: 'send_message', arguments: { kind: 'question', text: 'Which city?', ui: CARD } }] },
        { text: 'Pick a city above.' },
        { matchLastText: 'Singapore', step: 0, text: done },
      ]);
      const sent = await account.api('POST', `/v1/conversations/${roomId}/runs`, aguiInput(`/v1/conversations/${roomId}/runs`, { text: '@Ada plan the trip', mentions: [{ kind: 'agent', id: ada, label: '@Ada' }] }));
      expect(sent.status).toBe(202);
      const asked = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.kind === 'question' && e.data.request.conversationId === roomId, 45_000);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === roomId && String(e.data.item.markdown).includes('Pick a city above'), 45_000);
      for (let i = 0; i < 60 && !(await listRuns(account, roomId)).every((run) => run.status === 'completed'); i += 1) await new Promise((r) => setTimeout(r, 500));
      const before = (await listRuns(account, roomId)).length;

      const answered = await account.api('POST', `/v1/requests/${asked.data.request.id}/resolve`, { action: 'answer', answers: { city: 'sg' } });
      expect(answered.status).toBe(200);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === roomId && String(e.data.item.markdown).includes(done), 45_000);

      const runs = await listRuns(account, roomId);
      expect(runs.length).toBe(before + 1);
      expect(runs.every((run) => run.agentId === ada)).toBe(true);
    } finally {
      events.close();
    }
  });
});

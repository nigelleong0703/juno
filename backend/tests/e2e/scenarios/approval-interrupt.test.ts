import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall, transcriptMessages, type Account } from '../harness/client';

/**
 * A typed message while a run waits on an approval wakes the run WITHOUT deciding the card: the request stays
 * pending, the model gets the system note plus the message and decides (reply and wait, or request_withdraw).
 * A tap on the card afterwards still reaches the agent.
 */
async function askRule(account: Account, name: string) {
  const agent = await account.api('POST', '/v1/agents', { name });
  expect(agent.status).toBe(201);
  const rule = await account.api('POST', '/v1/rules', { description: 'Ask before listing agents', scope: 'action', behavior: 'ask', subject: 'agent_directory', enabled: true });
  expect(rule.status).toBeLessThan(300);
  return agent.body.id as string;
}

describe('message while an approval is pending', () => {
  it('wakes the run, keeps the card open, and a later tap still reaches the agent', async () => {
    const account = await createAccount('approval-interrupt');
    const events = await listenEvents(account.cookie);
    try {
      const agentId = await askRule(account, 'Patient');
      const typed = `wait, I'll check the price first ${randomUUID().slice(0, 4)}`;
      const reply = `OK-WAITING-${randomUUID().slice(0, 8)}`;
      const afterTap = `SAW-TAP-${randomUUID().slice(0, 8)}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agentId, [
        { toolCalls: [toolCall('call-dir', 'agent_directory')] },
        { text: reply },
        { toolCalls: [toolCall('call-dir-2', 'agent_directory')] },
        { text: afterTap },
      ], 'who else is on the team?');
      const created = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId, 30_000);
      const requestId: string = created.data.request.id;
      const runId: string = created.data.request.runId;

      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: typed }))).status).toBe(202);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(reply), 45_000);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === runId, 30_000);

      // The request was not decided by the words.
      expect((await account.api('GET', `/v1/requests/${requestId}`)).body.status).toBe('pending');
      const transcript = await transcriptMessages(sessionKey);
      const text = transcript.map((m) => m.text).join('\n');
      expect(text).toContain('Not done yet: still waiting for the user');
      expect(text).toContain('Never treat their words as approval');
      expect(text).toContain(typed);
      expect(text.indexOf('Not done yet')).toBeLessThan(text.indexOf(typed));

      // The tap afterwards wakes the agent with a new run that knows the decision.
      expect((await account.api('POST', `/v1/requests/${requestId}/resolve`, { action: 'approve' })).status).toBe(200);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(afterTap), 45_000);
      expect((await transcriptMessages(sessionKey)).map((m) => m.text).join('\n')).toContain('NOT performed');
      // The identical repeated call ran on that approval: no second card was raised.
      const requests = await account.api('GET', `/v1/requests?conversationId=${conversationId}`);
      expect(requests.body.items).toHaveLength(1);
    } finally {
      events.close();
    }
  });

  it('a changed call after a late approval is a new decision', async () => {
    const account = await createAccount('approval-changed');
    const events = await listenEvents(account.cookie);
    try {
      const agentId = await askRule(account, 'Careful');
      const afterTap = `CHANGED-${randomUUID().slice(0, 8)}`;
      const { conversationId } = await scriptedChat(account, agentId, [
        { toolCalls: [toolCall('call-dir', 'agent_directory')] },
        { text: 'waiting' },
        { toolCalls: [toolCall('call-dir-2', 'agent_directory', { search: 'someone else' })] },
        { text: afterTap },
      ], 'who else is on the team?');
      const created = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId, 30_000);
      const requestId: string = created.data.request.id;
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'hold on' }))).status).toBe(202);
      // The approval pause already ended a wire segment with RUN_FINISHED (interrupt); the tap must come after the run has
      // answered "hold on", or it would approve the original call before the message reaches the run.
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes('waiting'), 45_000);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.outcome?.type !== 'interrupt' && e.data.metadata.juno.run.id === created.data.request.runId, 45_000);
      expect((await account.api('POST', `/v1/requests/${requestId}/resolve`, { action: 'approve' })).status).toBe(200);
      const second = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId && e.data.request.id !== requestId, 45_000);
      expect(second.data.request.status).toBe('pending');
    } finally {
      events.close();
    }
  });

  it('closes the card when the model withdraws the request', async () => {
    const account = await createAccount('approval-withdraw');
    const events = await listenEvents(account.cookie);
    try {
      const agentId = await askRule(account, 'Flexible');
      const done = `WITHDRAWN-${randomUUID().slice(0, 8)}`;
      const { conversationId } = await scriptedChat(account, agentId, [
        { toolCalls: [toolCall('call-dir', 'agent_directory')] },
        { toolCalls: [toolCall('call-withdraw', 'request_withdraw', { reason: 'never mind, skip that' })] },
        { text: done },
      ], 'who else is on the team?');
      const created = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId, 30_000);
      const requestId: string = created.data.request.id;

      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'never mind, skip that' }))).status).toBe(202);
      const closed = await events.waitFor((e) => e.data.type === 'request.resolved' && e.data.request.id === requestId, 45_000);
      expect(closed.data.request.outcome).toBe('cancelled');
      expect(closed.data.request.decision.note).toBe('never mind, skip that');
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(done), 45_000);
    } finally {
      events.close();
    }
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptedChat, toolCall } from '../harness/client';

/**
 * The per-tool "Always allow" is retired (BACKEND 8.0): resolving with scope `always` is refused and makes no rule; a standing
 * permission is a delegation of a kind of decision. A per-tool auto rule made earlier (or by hand) keeps working.
 */
describe('always allow (retired) and old per-tool rules', () => {
  it('refuses scope always without deciding the request; an old auto rule still lets the tool run without asking', async () => {
    const account = await createAccount('always');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Regular' });
      const ask = await account.api('POST', '/v1/rules', {
        description: 'Ask before listing agents', scope: 'action', behavior: 'ask', subject: 'agent_directory', enabled: true,
      });
      expect(ask.status).toBeLessThan(300);
      const first = `FIRST-${randomUUID().slice(0, 8)}`;
      const { conversationId } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-dir', 'agent_directory')] },
        { text: first },
      ], 'who else is on the team?');
      const created = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId, 30_000);
      const requestId: string = created.data.request.id;
      expect(created.data.request.triggeringRuleId).toBe(ask.body.id);
      // The card is plain words with a brief; the raw tool name is not in the public request.
      expect(created.data.request.payload).toMatchObject({ action: 'agent directory', brief: { platform: { kind: 'juno' } } });
      expect(created.data.request).not.toHaveProperty('tool');

      const always = await account.api('POST', `/v1/requests/${requestId}/resolve`, { action: 'approve', scope: 'always' });
      expect(always.status).toBe(400);
      expect((await account.api('GET', `/v1/requests/${requestId}`)).body.status).toBe('pending');
      const ownRules = async () => (await account.api('GET', '/v1/rules?limit=100')).body.items.filter((r: { agentId?: string }) => r.agentId === agent.body.id);
      expect(await ownRules()).toHaveLength(0);

      const resolved = await account.api('POST', `/v1/requests/${requestId}/resolve`, { action: 'approve' });
      expect(resolved.status).toBe(200);
      expect(resolved.body).toMatchObject({ status: 'approved', outcome: 'allowed_once' });
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(first), 30_000);

      // An old per-tool auto rule (per agent, like the button used to make) still runs the tool without asking.
      expect((await account.api('DELETE', `/v1/rules/${ask.body.id}`)).status).toBe(200);
      const old = await account.api('POST', '/v1/rules', { description: 'Always allow agent_directory', scope: 'action', behavior: 'auto', subject: 'agent_directory', agentId: agent.body.id, enabled: true });
      expect(old.status).toBeLessThan(300);
      const second = `SECOND-${randomUUID().slice(0, 8)}`;
      const next = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-dir-2', 'agent_directory')] },
        { text: second },
      ], 'and again?');
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === next.conversationId && String(e.data.item.markdown).includes(second), 30_000);
      expect(events.events.some((e) => e.data.type === 'request.created' && e.data.request.conversationId === next.conversationId)).toBe(false);
    } finally {
      events.close();
    }
  });
});

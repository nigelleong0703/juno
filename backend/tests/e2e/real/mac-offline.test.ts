import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, execStack, listenEvents, toolActivity, transcriptMessages, runReport, stackUrls } from '../harness/client';

/** A server conversation stays useful when its optional owner Mac is unpaired/offline. No real Mac is touched. */
async function visibleReplies(sessionKey: string, minimum = 1) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const replies = (await transcriptMessages(sessionKey)).filter((message) => message.role === 'assistant' && message.text.trim() !== '');
    if (replies.length >= minimum) return replies;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [];
}

describe('real model: optional Mac offline', () => {
  it('checks the explicit Mac target without sandbox fallback, then continues the same cloud conversation', async () => {
    const account = await createAccount('mac-offline');
    const agentId = (await defaultAgent(account)).id;
    // This isolated fixture represents an agent previously allowed on the owner's Mac; that Mac is now offline.
    const patch = "jsonb_set(doc, '{macAccess}', 'true'::jsonb)";
    await execStack(`UPDATE agents SET doc = ${patch} WHERE id = ? AND owner_id = ?`, [agentId, account.userId]);
    const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
    expect(chat.status).toBe(201);
    const conversation: unknown = chat.body;
    if (typeof conversation !== 'object' || conversation === null || !('id' in conversation) || typeof conversation.id !== 'string') throw new Error('conversation missing');
    const conversationId = conversation.id;
    const sessionKey = `${agentId}:${conversationId}`;
    const events = await listenEvents(account.cookie);
    const finished = () => events.events.filter((event) => event.data.type === 'RUN_FINISHED' && event.data.metadata.juno.run.conversationId === conversationId).length;
    try {
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, {
        text: 'Check whether my own Mac is available. Use computer_environment with on="mac" if you need to probe, but do not probe again if the context already knows it is offline. Do not use the sandbox instead. If unavailable, tell me and stop; do not ask me to reconnect yet.',
      }))).status).toBe(202);
      await events.waitFor(() => finished() >= 1, 180_000);
      const firstReplies = await visibleReplies(sessionKey);
      const first = await toolActivity(sessionKey);
      const checks = first.calls.filter((call) => call.name === 'computer_environment');
      // Known-offline context should avoid a redundant probe; a deliberate probe must still target the Mac.
      expect(checks.length).toBeLessThanOrEqual(1);
      for (const check of checks) expect(check.arguments['on']).toBe('mac');
      expect(first.calls.filter((call) => /^(computer\.|browser\.|shell\.|files\.)/.test(call.name))).toHaveLength(0);
      for (const result of first.results.filter((entry) => entry.toolName === 'computer_environment')) expect(result.isError).toBe(true);
      expect(firstReplies.some((message) => /mac/i.test(message.text)), JSON.stringify(firstReplies)).toBe(true);
      const before = first.calls.length;
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'Leave the Mac task there. What is 7 times 8? Answer directly without tools.' }))).status).toBe(202);
      await events.waitFor(() => finished() >= 2, 180_000);
      expect((await toolActivity(sessionKey)).calls).toHaveLength(before);
      const replies = await visibleReplies(sessionKey, firstReplies.length + 1);
      expect(replies.at(-1)?.text).toContain('56');
    } catch (error) {
      const done = events.events.find((event) => event.data.type === 'RUN_FINISHED' && event.data.metadata.juno.run.conversationId === conversationId);
      console.error(await runReport(account, done?.data.metadata.juno.run.id ?? '').catch(() => 'run report unavailable'));
      throw error;
    } finally {
      events.close();
    }
  }, 420_000);
});

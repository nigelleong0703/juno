import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, listenEvents, runReport, toolActivity, transcriptMessages } from '../harness/client';

/**
 * Real model: asked to email someone with no mail app added, the agent recommends one from OUR catalog through a Connect card, and does not
 * pretend it sent anything (BACKEND 10.18.1). The stack offers one mail app that can send (Outlook Mail: the stack has a Microsoft client, no
 * Google one), so the card must name it.
 */
describe('real model: a need no added app meets', () => {
  it('shows a Connect card for a mail app that can send, and says plainly it has not sent anything', async () => {
    const account = await createAccount('connect-need-real');
    const agentId = (await defaultAgent(account)).id;
    const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
    expect(chat.status).toBe(201);
    const conversationId: string = chat.body.id;
    const sessionKey = `${agentId}:${conversationId}`;
    const events = await listenEvents(account.cookie);
    try {
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, {
        text: 'Email Alex (alex@example.com) the summary of today: we decided to ship on Friday and Mei owns the release notes.',
      }))).status).toBe(202);
      await events.waitFor((event) => event.data.type === 'RUN_FINISHED' && event.data.metadata.juno.run.conversationId === conversationId, 240_000);
      const card = events.events.find((event) => event.data.type === 'request.created' && event.data.request.kind === 'connect' && event.data.request.conversationId === conversationId);
      expect(card, 'no Connect card was shown').toBeDefined();
      const appIds: string[] = card?.data.request.payload.appIds ?? [];
      expect(appIds).toContain('outlook-mail');
      // Only catalog apps, and none that cannot send (Gmail writes drafts only).
      expect(appIds).not.toContain('gmail');
      const activity = await toolActivity(sessionKey);
      expect(activity.results.filter((result) => /send|mail/i.test(result.toolName) && !/connect|connector/i.test(result.toolName)), JSON.stringify(activity.results)).toHaveLength(0);
      const replies = (await transcriptMessages(sessionKey)).filter((message) => message.role === 'assistant' && message.text.trim() !== '');
      const last = replies.at(-1)?.text ?? '';
      expect(last, last).toMatch(/connect|outlook|mail app|add/i);
      // No claim of having sent it ("I'll email Alex once you connect" is the honest future).
      expect(last, last).not.toMatch(/\b(i('| ha)ve (sent|emailed)|i (sent|emailed)|has been sent|was sent|just sent|email sent)\b/i);
    } catch (error) {
      const done = events.events.find((event) => event.data.type === 'RUN_FINISHED' && event.data.metadata.juno.run.conversationId === conversationId);
      console.error(await runReport(account, done?.data.metadata.juno.run.id ?? '').catch(() => 'run report unavailable'));
      throw error;
    } finally {
      events.close();
    }
  }, 300_000);
});

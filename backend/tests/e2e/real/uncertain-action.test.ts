import { describe, expect, it } from 'vitest';
import { aguiInput } from '../../agui-input.js';
import { diagnose, listItems, listenEvents, runReport, toolActivity } from '../harness/client';
import { setupConnector, stubConnector, type StubTool } from '../harness/mcp-fixture';

/**
 * BACKEND §3.3d.5 with a real model: a Gmail-like app whose "send" is taken by the server (the mail goes out) but never answers, so the call
 * times out after sending. The agent must be told it may or may not have happened, check with a read tool (sent mail), find it was sent, not
 * send it again, and tell the person plainly. No "What did you verify?" card; nothing technical in the chat. Behaviour only, never wording.
 */
describe('real model: an email whose send timed out after sending', () => {
  it('checks sent mail, does not send twice, raises no card, and tells the person it went out', async () => {
    const sentMail: Array<Record<string, unknown>> = [];
    const tools: StubTool[] = [
      {
        name: 'send_email', description: 'Send an email.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
        // The mail goes out, then the connection hangs: the harness's tool timeout ends the call with no answer.
        answer: (args) => { sentMail.push(args); return sentMail.length === 1 ? { hang: true } : { result: { content: [{ type: 'text', text: 'Email sent.' }] } }; },
      },
      {
        name: 'search_sent_mail', description: 'Look in the sent folder. Returns the messages sent, newest first.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true },
        answer: () => ({ result: { content: [{ type: 'text', text: sentMail.length === 0 ? 'No sent messages.' : JSON.stringify(sentMail.map((mail) => ({ ...mail, sentAt: 'just now' }))) }] } }),
      },
    ];
    const connector = await stubConnector(tools);
    const { account, agentId } = await setupConnector('real-uncertain', connector);
    const events = await listenEvents(account.cookie);
    let where: { conversationId: string; sessionKey: string } | undefined;
    try {
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
      expect(created.status).toBe(201);
      const chat = { conversationId: created.body.id as string, sessionKey: `${agentId}:${created.body.id as string}` };
      where = chat;
      const path = `/v1/conversations/${chat.conversationId}/runs`;
      const sent = await account.api('POST', path, aguiInput(path, { text: 'Please email bob@example.com with the subject "Lunch" and the text "Lunch at 12?" using my Tracker app, then tell me when it is done.' }));
      expect(sent.status).toBe(202);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === chat.conversationId, 230_000);
      const runId: string = finished.data.metadata.juno.run.id;
      expect(finished.data.metadata.juno.run.status, await runReport(account, runId)).toBe('completed');

      const activity = await toolActivity(chat.sessionKey);
      const names = activity.calls.map((call) => (call.name === 'tool_call' ? String(call.arguments['name']) : call.name));
      expect(names, JSON.stringify(names)).toContain('linear_send_email');
      expect(names, 'the agent checked sent mail after the notice').toContain('linear_search_sent_mail');
      expect(names.lastIndexOf('linear_search_sent_mail')).toBeGreaterThan(names.indexOf('linear_send_email'));
      expect(sentMail, 'the mail was sent exactly once').toHaveLength(1);

      // A new account's agent may ask its own onboarding question; nothing is asked about the email or the uncertain send.
      const requests = ((await account.api('GET', `/v1/requests?agentId=${agentId}`)).body.items ?? []) as unknown[];
      expect(requests.filter((request) => /mail|bob|lunch|verify|uncertain|again/i.test(JSON.stringify(request))), 'nobody is asked about the email').toEqual([]);
      const said = (await listItems(account, chat.conversationId)).filter((item) => item.type === 'agent_message').map((item) => item.markdown ?? '');
      expect(said.length, 'the person is told').toBeGreaterThan(0);
      const last = said.at(-1) ?? '';
      expect(last, 'nothing technical').not.toMatch(/linear_|fingerprint|receipt|verify|tool_call|connector/i);
    } catch (error) {
      if (where !== undefined) await diagnose('uncertain-action', account, where.conversationId, where.sessionKey);
      throw error;
    } finally {
      events.close();
      await connector.close();
    }
  });
});

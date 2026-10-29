import { describe, expect, it } from 'vitest';
import { aguiInput } from '../../agui-input.js';
import { createAccount, defaultAgent, insertDocRow, listenEvents, scriptModel, toolCall, waitForTranscript } from '../harness/client';

/**
 * Connectors, through the real stack (BACKEND 10.18.1): a need ("send email") puts one Connect card in the chat with the catalog apps that
 * provide it, ranked by the server; a need no app of this deployment can meet is answered in words, with no card; and the card says why an
 * app is not usable with the same states the tool errors use (never finished connecting, expired).
 */
const NOW = '2026-10-29T00:00:00.000Z';

describe('connect cards from a need and from the access state', () => {
  it('a need becomes a ranked card; a need nothing here can meet makes no card and tells the model so', async () => {
    const account = await createAccount('connect-need');
    const juno = await defaultAgent(account);
    const events = await listenEvents(account.cookie);
    try {
      const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [juno.id] });
      const conversationId: string = chat.body.id;
      scriptModel(`${juno.id}:${conversationId}`, [
        { toolCalls: [toolCall('need-mail', 'connect_request', { need: 'mail.send' })] },
        { toolCalls: [toolCall('need-maps', 'connect_request', { need: 'maps.read' })] },
        { text: 'Done.' },
      ]);
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'put this in my notes, then mail it to Alex' }))).status).toBe(202);
      const card = await events.waitFor((event) => event.data.type === 'request.created' && event.data.request.kind === 'connect' && event.data.request.conversationId === conversationId, 45_000);
      expect(card.data.request.payload).toMatchObject({ kind: 'connect', appIds: ['outlook-mail'], problems: { 'outlook-mail': 'not_added' }, label: 'Send email' });
      await events.waitFor((event) => event.data.type === 'RUN_FINISHED' && event.data.outcome?.type === 'success', 45_000);
      // Gmail sends too (mail.send) but this stack has no Google OAuth client, so only Outlook Mail is offered. Maps needs a platform key this stack does not have: the model is told
      // there is nothing to connect, and no second card exists.
      const cards = events.events.filter((event) => event.data.type === 'request.created' && event.data.request.kind === 'connect');
      expect(cards).toHaveLength(1);
      const said = 'No app in our catalog can find places and travel times on this deployment';
      const texts = await waitForTranscript(`${juno.id}:${conversationId}`, (messages) => messages.some((text) => text.includes(said)));
      expect(texts.some((text) => text.includes(said))).toBe(true);
    } finally {
      events.close();
    }
  });

  it('the card names why an app is unusable with the access state: never finished connecting, or expired', async () => {
    const account = await createAccount('connect-state');
    const juno = await defaultAgent(account);
    const events = await listenEvents(account.cookie);
    try {
      const suffix = account.userId.slice(0, 12);
      await insertDocRow('connections', account.userId, { id: 'con-e2e-asana-' + suffix, kind: 'mcp', name: 'Asana', status: 'error', enabled: true, catalogId: 'asana', endpoint: 'https://mcp.asana.com/v2/mcp', transport: 'http' });
      await insertDocRow('connections', account.userId, { id: 'con-e2e-linear-' + suffix, kind: 'mcp', name: 'Linear', status: 'error', enabled: true, catalogId: 'linear', connectedAt: NOW, endpoint: 'https://mcp.linear.app/mcp', transport: 'http' });
      const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [juno.id] });
      const conversationId: string = chat.body.id;
      scriptModel(`${juno.id}:${conversationId}`, [
        { toolCalls: [toolCall('ask', 'connect_request', { connectors: ['asana', 'linear'], label: 'Tasks and issues' })] },
        { text: 'Asked.' },
      ]);
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'what is on my plate' }))).status).toBe(202);
      const card = await events.waitFor((event) => event.data.type === 'request.created' && event.data.request.kind === 'connect' && event.data.request.conversationId === conversationId, 45_000);
      expect(card.data.request.payload).toMatchObject({ appIds: ['asana', 'linear'], problems: { asana: 'needs_reconnect', linear: 'expired' } });
    } finally {
      events.close();
    }
  });
});

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, insertDocRow, listenEvents, scriptedChat, toolCall } from '../harness/client';

/**
 * A calendar write is a change and asks first (BACKEND 10.18.2): the Google Calendar app is connected to a loopback MCP server that
 * answers like the gateway's calendar service (`create_event` with the official argument names, annotated as a change). The run pauses on
 * an approval request, approving it resumes the same run, and the server sees the call exactly once with the arguments the model gave.
 */
async function calendarServer() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method !== 'POST') { response.statusCode = 204; response.end(); return; }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const reply = (result: unknown): void => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      };
      if (message.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'calendar-fixture', version: '1' } });
      if (message.method === 'tools/list') {
        return reply({ tools: [
          { name: 'list_events', description: 'List events.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
          { name: 'create_event', description: 'Add an event.', annotations: { readOnlyHint: false, destructiveHint: false },
            inputSchema: { type: 'object', properties: { summary: { type: 'string' }, startTime: { type: 'string' }, endTime: { type: 'string' }, attendees: { type: 'array', items: { type: 'object' } } }, required: ['summary', 'startTime', 'endTime'] } },
        ] });
      }
      if (message.method !== 'tools/call') { response.statusCode = 202; response.end(); return; }
      calls.push({ name: message.params?.name ?? '', args: message.params?.arguments ?? {} });
      reply({ content: [{ type: 'text', text: JSON.stringify({ id: 'evt-1', title: message.params?.arguments?.['summary'] }) }] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`,
    calls,
    close: async (): Promise<void> => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

describe('a calendar write asks first', () => {
  it('create_event pauses for approval, then runs once with the arguments the model gave', async () => {
    const calendar = await calendarServer();
    const account = await createAccount('calendar-approval');
    const agent = await defaultAgent(account);
    await insertDocRow('connections', account.userId, {
      id: `con-e2e-calendar-${account.userId.slice(0, 12)}`, kind: 'mcp', name: 'Google Calendar', status: 'connected', enabled: true,
      catalogId: 'google-calendar', permission: 'full', endpoint: calendar.url, transport: 'http', createdAt: new Date().toISOString(),
    });
    await insertDocRow('agent_apps', account.userId, {
      id: `${agent.id}:google-calendar`, agentId: agent.id, appId: 'google-calendar', enabled: true, actionsPolicy: 'ask', updatedAt: new Date().toISOString(),
    }, { agentId: agent.id });
    const events = await listenEvents(account.cookie);
    try {
      const args = { summary: 'Dentist', startTime: '2026-11-03T10:00:00+08:00', endTime: '2026-11-03T10:30:00+08:00', attendees: [{ email: 'ada@example.com' }] };
      const { conversationId } = await scriptedChat(account, agent.id, [
        { toolCalls: [toolCall('add-event', 'google_calendar_create_event', args)] },
        { text: 'Booked the dentist.' },
      ], 'put the dentist on my calendar on Tuesday at 10');
      const created = await events.waitFor((event) => event.data.type === 'request.created' && event.data.request.conversationId === conversationId, 45_000);
      expect(created.data.request.status).toBe('pending');
      // Paused: the calendar has not been called.
      expect(calendar.calls).toEqual([]);

      const resolved = await account.api('POST', `/v1/requests/${String(created.data.request.id)}/resolve`, { action: 'approve' });
      expect(resolved.status).toBe(200);
      await events.waitFor((event) => event.data.type === 'item.added' && event.data.conversationId === conversationId && String(event.data.item.markdown).includes('Booked the dentist'), 45_000);
      expect(calendar.calls).toEqual([{ name: 'create_event', args }]);
    } finally {
      events.close();
      await calendar.close();
    }
  });
});

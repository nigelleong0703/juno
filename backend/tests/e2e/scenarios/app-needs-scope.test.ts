import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, insertDocRow, scriptedChat, toolCall } from '../harness/client';

/**
 * A sign-in that lacks a permission shows on the app itself (BACKEND 10.18.2): the Google Calendar app is connected to a loopback MCP server
 * that refuses `tools/call` with 403 insufficient_scope, as the gateway does for an owner who connected before a tool needed more. After
 * the refused call the app list and the app detail carry `needsScope: true` on that installation (the status stays a plain enum value).
 */
async function scopeServer() {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method !== 'POST') { response.statusCode = 204; response.end(); return; }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string };      const reply = (result: unknown): void => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      };
      if (message.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'scope-fixture', version: '1' } });
      if (message.method === 'tools/list') return reply({ tools: [{ name: 'list_events', description: 'List events.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] });
      if (message.method !== 'tools/call') { response.statusCode = 202; response.end(); return; }
      response.statusCode = 403;
      response.setHeader('www-authenticate', 'Bearer error="insufficient_scope", scope="https://www.googleapis.com/auth/calendar.events"');
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`,
    close: async (): Promise<void> => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

type Installation = { id: string; status: string; needsScope?: boolean };

describe('a sign-in that lacks a permission', () => {
  it('marks the installation needsScope on the app list and the app detail, and a healthy one carries no flag', async () => {
    const server = await scopeServer();
    const account = await createAccount('app-needs-scope');
    const agent = await defaultAgent(account);
    const id = `con-e2e-scope-${account.userId.slice(0, 12)}`;
    await insertDocRow('connections', account.userId, {
      id, kind: 'mcp', name: 'Google Calendar', status: 'connected', enabled: true, catalogId: 'google-calendar', permission: 'full',
      endpoint: server.url, transport: 'http', connectedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
    });
    await insertDocRow('agent_apps', account.userId, { id: `${agent.id}:google-calendar`, agentId: agent.id, appId: 'google-calendar', enabled: true, actionsPolicy: 'ask', updatedAt: new Date().toISOString() }, { agentId: agent.id });
    const installationsOf = async (): Promise<Installation[]> => (await account.api('GET', '/v1/apps/google-calendar')).body.installations as Installation[];
    try {
      expect((await installationsOf())[0]).toMatchObject({ id, status: 'connected' });
      expect((await installationsOf())[0]).not.toHaveProperty('needsScope');

      await scriptedChat(account, agent.id, [
        { toolCalls: [toolCall('list', 'google_calendar_list_events', {})] },
        { text: 'Needs a new permission.' },
      ], 'what is on my calendar?');
      // The refused call writes the missing permission on the row; poll until the app shows it.
      const deadline = Date.now() + 45_000;
      while ((await installationsOf())[0]?.needsScope !== true && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));

      expect((await installationsOf())[0]).toMatchObject({ id, needsScope: true });
      const list = (await account.api('GET', '/v1/apps')).body.items as Array<{ id: string; installations: Installation[] }>;
      expect(list.find((app) => app.id === 'google-calendar')?.installations[0]).toMatchObject({ id, needsScope: true });
    } finally {
      await server.close();
    }
  });
});

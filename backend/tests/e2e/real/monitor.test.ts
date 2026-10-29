import { aguiInput } from '../../agui-input.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, insertDocRow, listenEvents, runReport, toolActivity } from '../harness/client';

/**
 * Agent-created monitors with a real model (BACKEND 3.6.3): the owner says "tell me when a new issue appears in acme/app" and the
 * agent finds the right read tool, works out where the list and the item id are from what the tool returns, and creates a
 * monitor that passes its own proving check. Assertions check what was made (tool, list path, id field, nothing changed in
 * the tracker), never wording.
 */

interface Received { tool: string; args: Record<string, unknown> }

const TOOLS = [
  { name: 'list_issues', description: 'List the open issues of a repository.', inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'owner/name' } }, required: ['repo'] }, annotations: { readOnlyHint: true } },
  { name: 'get_issue', description: 'Get one issue with its comments.', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer' } }, required: ['repo', 'number'] }, annotations: { readOnlyHint: true } },
  { name: 'create_issue', description: 'Open a new issue.', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, title: { type: 'string' } }, required: ['repo', 'title'] } },
  { name: 'add_comment', description: 'Comment on an issue.', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer' }, body: { type: 'string' } }, required: ['repo', 'number', 'body'] } },
];

const ISSUES = { open: [
  { number: 41, title: 'Login page crashes on Safari', state: 'open', author: 'maya' },
  { number: 40, title: 'Dark mode flickers', state: 'open', author: 'li' },
  { number: 37, title: 'Docs: fix the install step', state: 'open', author: 'sam' },
] };

async function fakeTracker(received: Received[]): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method !== 'POST') { response.statusCode = 204; response.end(); return; }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const reply = (result: unknown): void => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); };
      if (message.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tracker', version: '1' } });
      if (message.method === 'tools/list') return reply({ tools: TOOLS });
      if (message.method === 'tools/call') {
        received.push({ tool: message.params?.name ?? '', args: message.params?.arguments ?? {} });
        return reply({ content: [{ type: 'text', text: message.params?.name === 'list_issues' ? JSON.stringify(ISSUES) : 'ok' }] });
      }
      response.statusCode = 202;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp` };
}

describe('real model: creating a monitor', () => {
  it('watches the issue list of a connected tracker with the right read tool, list path and id field', async () => {
    const account = await createAccount('real-monitor');
    const events = await listenEvents(account.cookie);
    const received: Received[] = [];
    const tracker = await fakeTracker(received);
    try {
      await insertDocRow('connections', account.userId, {
        id: `con-e2e-tracker-${account.userId.slice(0, 12)}`, kind: 'mcp', name: 'Tracker', status: 'connected', enabled: true, permission: 'full',
        endpoint: tracker.url, transport: 'http', createdAt: new Date().toISOString(),
      });
      const agent = await defaultAgent(account);
      const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.id] });
      const conversationId: string = chat.body.id;
      const sessionKey = `${agent.id}:${conversationId}`;
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'Tell me when a new issue appears in acme/app on Tracker.' }));
      expect(sent.status).toBe(202);
      const done = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId, 300_000);
      expect(done.data.metadata.juno.run.status, await runReport(account, done.data.metadata.juno.run.id)).toBe('completed');

      const activity = await toolActivity(sessionKey);
      const made = activity.results.find((entry) => entry.toolName === 'monitor_create');
      expect(made, JSON.stringify(activity.calls)).toBeDefined();
      expect(made?.isError, made?.text).toBe(false);
      const routines = (await account.api('GET', '/v1/routines')).body.items as Array<{ trigger: { kind: string; tool?: string; items?: string; id?: string; args?: Record<string, unknown>; everyMinutes?: number }; delivery: { target?: string } }>;
      const monitors = routines.filter((routine) => routine.trigger.kind === 'check');
      expect(monitors, JSON.stringify(activity.calls)).toHaveLength(1);
      const trigger = monitors[0]?.trigger;
      expect(trigger?.tool).toBe('tracker_list_issues');
      expect(trigger?.items).toBe('open');
      expect(trigger?.id).toBe('number');
      expect(JSON.stringify(trigger?.args)).toContain('acme/app');
      expect(trigger?.everyMinutes).toBeGreaterThanOrEqual(15);
      expect(monitors[0]?.delivery.target).toBe(conversationId);
      // It only read: nothing in the tracker was changed.
      expect(received.filter((call) => call.tool !== 'list_issues' && call.tool !== 'get_issue')).toEqual([]);
      expect(received.filter((call) => call.tool === 'list_issues').length).toBeGreaterThan(0);
    } finally {
      events.close();
      await new Promise<void>((resolve) => tracker.server.close(() => resolve()));
    }
  }, 600_000);
});

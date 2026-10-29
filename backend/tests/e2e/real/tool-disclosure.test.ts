import { aguiInput } from '../../agui-input.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createAccount, defaultAgent, insertDocRow, listenEvents, modelUsage, runReport, toolActivity, type Account, type EventListener } from '../harness/client';

/**
 * Progressive tool disclosure with a real model (the stack's default, Muse Spark, which has native deferred tool loading):
 * a connected-app server exposes 30 tools, more than the model is shown in the compact core, so the rest are declared as
 * deferred functions behind the provider's own tool search. The test asks for one of the hidden ones and checks what actually ran:
 *   - the model searched, then called the hidden tool by its own name (never through tool_call), and the server received it;
 *   - the request that follows the search is still a cache hit (>= 90% of the previous request's input is cached): loading a
 *     tool must not rewrite the prefix;
 *   - a hidden ACTION tool still raises the ordinary approval, and the server receives nothing until the owner approves.
 * Assertions are behavioural (which tool ran, what the server received, whether a card appeared, token counts), never wording.
 */

const NOW = new Date().toISOString();

interface Received { tool: string; args: Record<string, unknown> }

const HIDDEN_INDEX = 28;
const ACTION_INDEX = 29;

/** 30 tools: 28 filler ones followed by the two useful tools; array order grants no visibility. */
const TOOLS = Array.from({ length: 30 }, (_, index) => {
  if (index === HIDDEN_INDEX) {
    return { name: 'search_notes', description: 'Search the notes by words; use it to find the wifi password or any saved detail.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } };
  }
  if (index === ACTION_INDEX) {
    return { name: 'create_note', description: 'Create a new note with a title and a body.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'] } };
  }
  return { name: 'list_label_' + String(index), description: 'List the notes that carry one label (' + String(index) + '). This does not search note text.', inputSchema: { type: 'object', properties: { label: { type: 'string' } } }, annotations: { readOnlyHint: true } };
});

/** A minimal streamable-HTTP MCP server (JSON replies) that records every tool call it receives. */
async function fakeMcp(received: Received[]): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method !== 'POST') { response.statusCode = 204; response.end(); return; }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      const reply = (result: unknown): void => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); };
      if (message.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'notes', version: '1' } });
      if (message.method === 'tools/list') return reply({ tools: TOOLS });
      if (message.method === 'tools/call') {
        received.push({ tool: message.params?.name ?? '', args: message.params?.arguments ?? {} });
        const text = message.params?.name === 'search_notes' ? 'Wifi password: hunter2 (from the flat notes).' : 'No notes carry that label.';
        return reply({ content: [{ type: 'text', text }] });
      }
      response.statusCode = 202;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp` };
}

async function setup(prefix: string) {
  const account = await createAccount(prefix);
  const events = await listenEvents(account.cookie);
  const received: Received[] = [];
  const server = await fakeMcp(received);
  await insertDocRow('connections', account.userId, {
    id: `con-e2e-notes-${account.userId.slice(0, 12)}`,
    kind: 'mcp',
    name: 'Notes',
    status: 'connected',
    enabled: true,
    permission: 'full',
    endpoint: server.url,
    transport: 'http',
    createdAt: NOW,
  });
  const agent = await defaultAgent(account);
  const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.id] });
  expect(chat.status).toBe(201);
  return {
    account, events, received, agentId: agent.id, conversationId: chat.body.id as string,
    sessionKey: `${agent.id}:${chat.body.id}`,
    close: async (): Promise<void> => { events.close(); await new Promise<void>((resolve) => server.server.close(() => resolve())); },
  };
}

const runsDone = (events: EventListener, conversationId: string): number =>
  events.events.filter((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId).length;

async function say(account: Account, conversationId: string, text: string): Promise<void> {
  expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }))).status).toBe(202);
}

async function until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs = 240_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const found = await read();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('timed out waiting for ' + what);
}

const pendingApproval = (account: Account, agentId: string) => until('a pending approval', async () => {
  const body = (await account.api('GET', `/v1/requests?agentId=${agentId}&status=pending&kind=approval`)).body as { items: Array<{ id: string }> };
  return body.items[0];
});

describe('real model: tool disclosure', () => {
  it('searches for a hidden connected-app tool, calls it by its own name, and keeps the prompt cache', async () => {
    const env = await setup('real-disclosure-read');
    const { account, events, received, conversationId, sessionKey } = env;
    try {
      await say(account, conversationId, 'Search my notes for the wifi password. Do not ask me anything first.');
      await events.waitFor(() => runsDone(events, conversationId) >= 1, 240_000);
      const activity = await toolActivity(sessionKey);
      const names = activity.calls.map((call) => call.name);
      // The model searched and then called the hidden tool directly; the proxy is not offered.
      expect(names, JSON.stringify(names)).toContain('tool_search');
      expect(names, JSON.stringify(names)).not.toContain('tool_call');
      const searched = names.indexOf('tool_search');
      const called = names.findIndex((name) => name.includes('search_notes'));
      expect(called, JSON.stringify(names)).toBeGreaterThan(searched);
      expect(received.map((call) => call.tool)).toContain('search_notes');
      // The request after the search is a cache hit: the loaded tool did not rewrite the prefix.
      const usage = await modelUsage(sessionKey);
      const at = usage.findIndex((call) => call.tools.includes('tool_search'));
      const before = usage[at];
      const after = usage[at + 1];
      expect(before && after, JSON.stringify(usage)).toBeTruthy();
      const previousInput = (before?.input ?? 0) + (before?.cacheRead ?? 0) + (before?.cacheWrite ?? 0);
      console.log('[disclosure-e2e] cache after search: cached ' + String(after?.cacheRead) + ' of previous input ' + String(previousInput) + ' (' + String(Math.round(100 * (after?.cacheRead ?? 0) / Math.max(1, previousInput))) + '%)');
      expect(after?.cacheRead ?? 0, JSON.stringify(usage)).toBeGreaterThanOrEqual(0.9 * previousInput);
      // The answer reached the user: the fixture's text is in the transcript or the reply.
      expect(JSON.stringify(await toolActivity(sessionKey))).toContain('hunter2');
    } catch (error) {
      console.error('[disclosure-e2e] run report', await runReport(account, events.events.find((e) => e.data.type === 'RUN_FINISHED')?.data.metadata.juno.run.id ?? '').catch(() => ''));
      throw error;
    } finally {
      await env.close();
    }
  }, 600_000);

  it('a hidden action tool still raises the ordinary approval, and the server sees nothing until it is approved', async () => {
    const env = await setup('real-disclosure-action');
    const { account, events, received, agentId, conversationId } = env;
    try {
      await say(account, conversationId, 'Create a note titled Groceries with the body "milk, eggs". Do not ask me anything first.');
      const card = await pendingApproval(account, agentId);
      expect(card, 'a hidden action asks the owner').toBeDefined();
      // Reading on the way is fine; the ACTION must not have run before the owner decided.
      expect(received.filter((call) => call.tool === 'create_note'), 'nothing is created before approval').toHaveLength(0);
      // The model may raise the same decision again (a second attempt); approve every card it asks for
      // until the run finishes, then check what actually reached the connector.
      const deadline = Date.now() + 240_000;
      const approved = new Set<string>();
      while (runsDone(events, conversationId) < 1 && Date.now() < deadline) {
        const body = (await account.api('GET', `/v1/requests?agentId=${agentId}&status=pending&kind=approval`)).body as { items: Array<{ id: string }> };
        for (const item of body.items) {
          if (approved.has(item.id)) continue;
          approved.add(item.id);
          expect((await account.api('POST', `/v1/requests/${item.id}/resolve`, { action: 'approve' })).status).toBe(200);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      expect(approved.size).toBeGreaterThan(0);
      expect(received.filter((call) => call.tool === 'create_note').length).toBeGreaterThan(0);
    } catch (error) {
      console.error('[disclosure-e2e] run report', await runReport(account, events.events.find((e) => e.data.type === 'RUN_FINISHED')?.data.metadata.juno.run.id ?? '').catch(() => ''));
      throw error;
    } finally {
      await env.close();
    }
  }, 600_000);
});

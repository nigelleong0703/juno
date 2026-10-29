import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';
import { createAccount, defaultAgent, insertDocRow } from './client';

export interface ToolCall { name: string; args: Record<string, unknown> }
interface McpMessage { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }
interface HeldResponse { response: ServerResponse; message: McpMessage }

/**
 * Isolated HTTP MCP server with one write tool (`create_issue`): it records every call and every external effect
 * independently of the stack's PostgreSQL. The FIRST call is held open (its response is only sent by `releaseFirst`),
 * which is the window a crash or a frozen worker has to land in. `firstCallExecutes` says whether that held call already
 * committed its effect on the (fake) external system. With `delayAllCallsMs` no call is held: every call executes and
 * answers after that delay (a slow but ordinary tool, to keep runs busy).
 */
export async function uncertainConnector(firstCallExecutes: boolean, options: { delayAllCallsMs?: number } = {}) {
  const calls: ToolCall[] = [];
  const effects: ToolCall[] = [];
  let firstHeld: HeldResponse | undefined;
  let firstCallSeen: (() => void) | undefined;
  let callCountChanged: (() => void) | undefined;
  const firstSeen = new Promise<void>((resolve) => { firstCallSeen = resolve; });
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method !== 'POST') { response.statusCode = 204; response.end(); return; }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as McpMessage;
      const reply = (result: unknown): void => {
        if (response.destroyed || response.writableEnded) return;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      };
      if (message.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'recovery-fixture', version: '1' } });
      if (message.method === 'tools/list') return reply({ tools: [{ name: 'create_issue', description: 'Create an issue in the tracker.', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, title: { type: 'string' } }, required: ['repo', 'title'] } }] });
      if (message.method !== 'tools/call') { response.statusCode = 202; response.end(); return; }

      const call = { name: message.params?.name ?? '', args: message.params?.arguments ?? {} };
      calls.push(call);
      callCountChanged?.();
      callCountChanged = undefined;
      if (options.delayAllCallsMs !== undefined) {
        effects.push(call);
        firstCallSeen?.();
        firstCallSeen = undefined;
        setTimeout(() => reply({ content: [{ type: 'text', text: 'created issue' }] }), options.delayAllCallsMs);
        return;
      }
      if (calls.length === 1) {
        firstHeld = { response, message };
        firstCallSeen?.();
        firstCallSeen = undefined;
        if (firstCallExecutes) effects.push(call);
        return;
      }
      effects.push(call);
      reply({ content: [{ type: 'text', text: 'created issue' }] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`,
    calls,
    effects,
    firstSeen,
    async waitForCalls(count: number): Promise<void> {
      const until = Date.now() + 30_000;
      while (calls.length < count && Date.now() < until) {
        await new Promise<void>((resolve) => {
          callCountChanged = resolve;
          const timer = setTimeout(() => { if (callCountChanged === resolve) callCountChanged = undefined; resolve(); }, 100);
          void timer;
        });
      }
      expect(calls.length).toBeGreaterThanOrEqual(count);
    },
    releaseFirst(): void {
      if (firstHeld === undefined) throw new Error('the first external call is not being held');
      const result = firstCallExecutes ? 'created issue' : 'no issue was created';
      firstHeld.response.setHeader('content-type', 'application/json');
      firstHeld.response.end(JSON.stringify({ jsonrpc: '2.0', id: firstHeld.message.id, result: { content: [{ type: 'text', text: result }] } }));
      firstHeld = undefined;
    },
    async close(): Promise<void> {
      if (firstHeld !== undefined && !firstHeld.response.writableEnded) {
        firstHeld.response.statusCode = 503;
        firstHeld.response.end();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A new account whose default agent can use the connector as its "Tracker" app (`linear_create_issue`). */
export async function setupConnector(prefix: string, connector: Awaited<ReturnType<typeof uncertainConnector>>) {
  const account = await createAccount(prefix);
  const agent = await defaultAgent(account);
  await insertDocRow('connections', account.userId, {
    id: `con-e2e-recovery-${account.userId.slice(0, 12)}`, kind: 'mcp', name: 'Tracker', status: 'connected', enabled: true,
    catalogId: 'linear', permission: 'full', endpoint: connector.url, transport: 'http', createdAt: new Date().toISOString(),
  });
  await insertDocRow('agent_apps', account.userId, {
    id: `${agent.id}:linear`, agentId: agent.id, appId: 'linear', enabled: true, actionsPolicy: 'allow', updatedAt: new Date().toISOString(),
  }, { agentId: agent.id });
  return { account, agentId: agent.id };
}

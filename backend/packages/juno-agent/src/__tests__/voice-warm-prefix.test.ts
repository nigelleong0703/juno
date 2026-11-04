/**
 * The call-start warm-up exists so the first spoken turn finds the provider's prompt cache primed: the request it sends must share the
 * exact prefix the next real run sends (model, reasoning, tools in order, system row, history, session id). Both go through the
 * production runtime against a capturing provider endpoint.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { DurablePromise } from '@agent-desktop/durable';
import { createVomuAgent, loadConfig, runWithOwner } from '../index.js';
import { createMemoryStore } from '../testing/store.js';
import { createMemoryBlobStore } from '../testing/blobs.js';
import { createConnectorCatalog } from '../modules/mcp/catalog.js';
import { RecordingEnqueuer } from '../execution/testing/enqueuer.js';
import { agentDoc, conversationDoc } from '../execution/brain/__tests__/agent-resources.fixtures.js';
import { runWorkflowBody, type RunBodyContext } from '../execution/harness/services/run.js';
import type { WakeEvent } from '../contracts/index.js';

interface Captured { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }

const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 } };
const answer = [
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
  { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'Done.' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] } },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage } },
];

async function providerEndpoint() {
  const calls: Captured[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'test-model', context_window: 128000, max_output_tokens: 8192 }] }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (part: Buffer) => chunks.push(part));
    request.on('end', () => {
      calls.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of answer) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { url: 'http://127.0.0.1:' + String(address.port) + '/v1', calls, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

function runCtx(key: string): RunBodyContext {
  let next = 0;
  return {
    key,
    rand: { uuidv4: () => key + '-id-' + String((next += 1)) },
    run: (_name, action) => DurablePromise.resolve(action()),
    awakeable: <T>() => ({ id: 'awake', promise: DurablePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => DurablePromise.resolve<WakeEvent[]>([]),
    cancel: { peek: async () => false, get: () => DurablePromise.resolve(new Promise<boolean>(() => {})) },
    runFinished: async () => {},
  };
}

const wake = (id: string, text: string): WakeEvent => ({
  id, ownerId: 'owner-1', agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1',
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text, channel: 'voice' },
  at: '2026-10-20T00:00:00.000Z', status: 'accepted',
});

describe('the call-start warm-up and the first spoken turn', () => {
  it('send the same model, reasoning, tools, system row, history and cache key', async () => {
    const endpoint = await providerEndpoint();
    try {
      const lines: Array<{ fields: Record<string, unknown>; message: string }> = [];
      const agent = await createVomuAgent({
        log: (fields, message) => { lines.push({ fields, message }); },
        store: createMemoryStore(), blobs: createMemoryBlobStore(), enqueuer: new RecordingEnqueuer(), connectorCatalog: createConnectorCatalog([]),
        config: loadConfig({ MODEL_BASE_URL: endpoint.url, MODEL_API_KEY: 'sk-test-key', MODEL_ID: 'test-model', API_TOKEN: 'dev-token', OWNER_ID: 'owner-1' }),
        env: { MODEL_BASE_URL: endpoint.url, MODEL_ID: 'test-model' },
      });
      const services = { store: agent.store, blobs: createMemoryBlobStore(), enqueuer: new RecordingEnqueuer(), brain: agent.brain, toolRegistry: agent.tools, log: (fields: Record<string, unknown>, message: string) => { lines.push({ fields, message }); } };
      const run = (key: string, text: string) => runWithOwner('owner-1', () => runWorkflowBody(runCtx(key), services, {
        agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake('wake-' + key, text)],
      }));
      await runWithOwner('owner-1', async () => {
        await agent.store.put('agents', agentDoc('agent-1', []));
        await agent.store.put('conversations', conversationDoc('conv-1', ['agent-1']));
      });
      // An earlier turn of the call (or chat) leaves a stored system row and some history.
      await run('run-1', 'first question');
      const before = endpoint.calls.length;
      expect(before).toBeGreaterThan(0);

      const target = { ownerId: 'owner-1', agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1' };
      expect(await runWithOwner('owner-1', () => agent.warm(target, new AbortController().signal))).toBe('warmed');
      await run('run-2', 'second question');
      const calls = lines.filter((line) => line.message === 'model call').map((line) => line.fields);
      const warm = endpoint.calls[before];
      const real = endpoint.calls[before + 1];
      if (warm === undefined || real === undefined) throw new Error('expected a warm-up request and a run request');

      for (const field of ['model', 'instructions', 'tools', 'reasoning', 'prompt_cache_key', 'include', 'store', 'tool_choice', 'parallel_tool_calls', 'prompt_cache_retention'] as const) {
        expect(JSON.stringify(warm.body[field]), field).toBe(JSON.stringify(real.body[field]));
      }
      // The two `model call` lines (the warm-up's is tagged) carry the same fingerprints of what was sent.
      const warmLine = calls.find((fields) => fields['warm'] === true);
      const runLine = calls[calls.length - 1];
      expect(warmLine?.['prefixHash']).toBeDefined();
      expect(runLine?.['warm']).toBeUndefined();
      for (const key of ['prefixHash', 'toolSchemaHash', 'systemPromptHash', 'sessionHash', 'model'] as const) expect(warmLine?.[key], key).toEqual(runLine?.[key]);
      expect(warm.headers['session-id']).toBe(real.headers['session-id']);
      expect(warm.headers['x-client-request-id']).toBe(real.headers['x-client-request-id']);
      const warmInput = warm.body['input'];
      const realInput = real.body['input'];
      if (!Array.isArray(warmInput) || !Array.isArray(realInput)) throw new Error('missing Responses input');
      // Everything but the warm-up's closing probe line is the front of the real request.
      expect(JSON.stringify(realInput.slice(0, warmInput.length - 1))).toBe(JSON.stringify(warmInput.slice(0, -1)));
    } finally {
      await endpoint.close();
    }
  });
});

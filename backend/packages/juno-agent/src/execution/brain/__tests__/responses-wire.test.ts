/**
 * The default wire is OpenAI Responses (Codex's request shape): store:false, encrypted reasoning
 * items carried back in order (reasoning item, then the message / function_call it led to, then the
 * function_call_output), nothing but opaque items replayed as thinking, deterministic bytes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '../../../contracts/index.js';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { backendConfigSchema } from '../../config.js';
import { runWithOwner } from '../../../owner-context.js';
import { createMemoryStore } from '../../../testing/store.js';
import { createOpenAIProvider } from '../provider.js';
import { createUserProvider, sealProviderKey } from '../user-providers.js';

interface Captured { path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown>; raw: string }

async function startServer(streams: Array<Array<Record<string, unknown>>>) {
  const calls: Captured[] = [];
  let served = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '';
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'test-model', context_window: 128000, max_output_tokens: 8192 }] }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (part: Buffer) => chunks.push(part));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      calls.push({ path: url, headers: request.headers, body: JSON.parse(raw || '{}'), raw });
      const events = streams[served] ?? streams[streams.length - 1] ?? [];
      served += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) response.write('event: ' + String(event['type']) + '\ndata: ' + JSON.stringify(event) + '\n\n');
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: 'http://127.0.0.1:' + String(address.port) + '/v1',
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 64 }, output_tokens_details: { reasoning_tokens: 4 } };
const completed = { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage } };

/** reasoning item (encrypted) then a function call, the shape a reasoning model answers a tool turn with. */
const reasoningThenToolCall: Array<Record<string, unknown>> = [
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'plan the lookup' }], encrypted_content: 'ENCRYPTED-BLOB' } },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell_run', arguments: '' } },
  { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"command":"echo hi"}' },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell_run', arguments: '{"command":"echo hi"}' } },
  completed,
];
const textAnswer: Array<Record<string, unknown>> = [
  { type: 'response.created', response: { id: 'resp_2', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
  { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'Done.' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] } },
  completed,
];

const config = (url: string) => backendConfigSchema.parse({
  MODEL_BASE_URL: url, MODEL_API_KEY: 'sk-secret-key', MODEL_ID: 'test-model', API_TOKEN: 'dev-token', OWNER_ID: 'user-1',
});

const shell: Tool = {
  name: 'shell.run', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } },
  replay: 'never', sideEffect: true, execute: async () => ({ content: [] }),
};
const signal = () => new AbortController().signal;
const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 1 });
const system: Message = { role: 'system', content: 'FROZEN-SYSTEM', timestamp: 0 };

describe('Responses wire', () => {
  it('sends store:false, the encrypted-reasoning include, the stable header and no temperature; returns the reasoning item as an opaque thinking block', async () => {
    const server = await startServer([reasoningThenToolCall]);
    try {
      const provider = createOpenAIProvider(config(server.url), { reasoningEffort: 'low' });
      const turn = await provider.call({ messages: [system, user('run it')], tools: [shell], signal: signal(), sessionKey: 'agt-1:cvn-1' });
      const call = server.calls[0]!;
      expect(call.path).toBe('/v1/responses');
      expect(call.body['store']).toBe(false);
      expect(call.body['include']).toEqual(['reasoning.encrypted_content']);
      expect(call.body['reasoning']).toMatchObject({ effort: 'low' });
      expect(call.body).not.toHaveProperty('temperature');
      expect(call.headers['session-id']).toMatch(/^juno-[0-9a-f]{32}$/);
      // The platform default keeps its measured routing: affinity headers only, no prompt_cache_key.
      expect(call.body).not.toHaveProperty('prompt_cache_key');
      const input = call.body['input'] as Array<Record<string, unknown>>;
      expect(input[0]).toMatchObject({ role: 'developer', content: 'FROZEN-SYSTEM' });
      expect((call.body['tools'] as Array<Record<string, unknown>>).map(t => t['name'])).toEqual(['shell_run']);
      expect(turn.toolCalls).toEqual([{ id: 'call_1|fc_1', name: 'shell.run', arguments: { command: 'echo hi' } }]);
      const stored = turn.message as AssistantMessage;
      expect(stored.api).toBe('openai-responses');
      const thinking = stored.content.find(block => block.type === 'thinking');
      expect(thinking && thinking.type === 'thinking' && JSON.parse(thinking.thinkingSignature ?? '{}')).toMatchObject({ type: 'reasoning', encrypted_content: 'ENCRYPTED-BLOB' });
    } finally {
      await server.close();
    }
  });

  it('replays reasoning item, function_call and function_call_output in order, drops foreign thinking, and rebuilds identical bytes', async () => {
    const server = await startServer([reasoningThenToolCall, textAnswer, textAnswer, textAnswer]);
    try {
      const provider = createOpenAIProvider(config(server.url), { reasoningEffort: 'low' });
      const first = await provider.call({ messages: [system, user('run it')], tools: [shell], signal: signal(), sessionKey: 'agt-1:cvn-1' });
      const assistant = first.message as AssistantMessage;
      const foreign: AssistantMessage = {
        role: 'assistant', api: 'openai-completions', provider: 'openai', model: 'opencode-go/longcat-2.5-preview-free', stopReason: 'stop', timestamp: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: 'thinking', thinking: 'FOREIGN-THOUGHT', thinkingSignature: 'reasoning_content' }, { type: 'text', text: 'Earlier answer.' }],
      };
      const result: Message = { role: 'toolResult', toolCallId: 'call_1|fc_1', toolName: 'shell.run', content: [{ type: 'text', text: 'hi' }], isError: false, timestamp: 3 };
      const history: Message[] = [system, user('first'), foreign, user('run it'), assistant, result, user('and now?')];
      await provider.call({ messages: history, tools: [shell], signal: signal(), sessionKey: 'agt-1:cvn-1' });
      await provider.call({ messages: history, tools: [shell], signal: signal(), sessionKey: 'agt-1:cvn-1' });
      const second = server.calls[1]!;
      const input = second.body['input'] as Array<Record<string, unknown>>;
      const shape = input.map(item => (item['type'] as string | undefined) ?? (item['role'] as string));
      expect(shape).toEqual(['developer', 'user', 'message', 'user', 'reasoning', 'function_call', 'function_call_output', 'user']);
      expect(input[4]).toMatchObject({ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENCRYPTED-BLOB' });
      expect(input[5]).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'shell_run' });
      expect(input[6]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
      expect(second.raw).not.toContain('FOREIGN-THOUGHT');
      // Two builds of the same history are the same bytes: no timestamps, ids or order drift.
      expect(server.calls[2]!.raw).toBe(second.raw);
    } finally {
      await server.close();
    }
  });
});

describe('owner provider on the Responses wire', () => {
  const OWNER = 'owner-alpha';
  const KEY = 'sk-user-key-zz9';
  beforeAll(() => {
    process.env['SECRETS_KEY'] = randomBytes(32).toString('base64');
    process.env['MCP_ALLOW_PRIVATE_HOSTS'] = '1';
  });
  afterAll(() => {
    delete process.env['MCP_ALLOW_PRIVATE_HOSTS'];
  });

  it('sends the hashed session id as prompt_cache_key and session-id, never the owner id, key or raw session key', async () => {
    const server = await startServer([textAnswer]);
    try {
      const store = createMemoryStore();
      const provider = await runWithOwner(OWNER, async () => {
        await store.put('modelProviders', {
          id: 'mprov-r', ownerId: OWNER, kind: 'custom', name: 'Responses endpoint', baseUrl: server.url, wire: 'openai-responses',
          apiKey: sealProviderKey(KEY), createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z',
        });
        return createUserProvider({
          store, binding: { providerId: 'mprov-r', modelId: 'test-model', baseUrl: server.url, wire: 'openai-responses', supportsImages: false },
          ownerId: () => OWNER,
        }, {});
      });
      await runWithOwner(OWNER, () => provider.call({ messages: [system, user('hi')], tools: [], signal: signal(), sessionKey: 'agt-1:cvn-1' }));
      const call = server.calls[0]!;
      const id = call.body['prompt_cache_key'];
      expect(id).toMatch(/^juno-[0-9a-f]{32}$/);
      expect(call.headers['session-id']).toBe(id);
      expect(call.headers['authorization']).toBe('Bearer ' + KEY);
      // The key is sent only as the bearer credential; the owner id and the raw session key never leave.
      for (const secret of [OWNER, 'agt-1', 'cvn-1']) {
        expect(call.raw).not.toContain(secret);
        expect(JSON.stringify(call.headers)).not.toContain(secret);
      }
      expect(call.raw).not.toContain(KEY);
    } finally {
      await server.close();
    }
  });
});

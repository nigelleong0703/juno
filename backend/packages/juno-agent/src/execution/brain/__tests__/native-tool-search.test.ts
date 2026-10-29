/**
 * Native deferred tool loading on the Responses wire (mode 'responses-tool-search'), through the real pi-ai adapter against a fake
 * endpoint: the request declares the provider's client-mode `tool_search` and every hidden tool as a deferred function, the
 * model's `tool_search_call` becomes an ordinary `tool_search` call, and on every later request that call and its result are
 * sent back as the two native items at the same place, so each request is a byte prefix of the next. The proxy mode twin checks
 * that a `tool_call` is unwrapped into the tool it reaches while the stored message keeps what the model said.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { Tool } from '../../../contracts/index.js';
import { backendConfigSchema } from '../../config.js';
import { toolMessage } from '../messages.js';
import { createOpenAIProvider } from '../provider.js';

interface Captured { raw: string; body: Record<string, unknown> }

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

async function startServer(streams: Array<Array<Record<string, unknown>>>) {
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
      const raw = Buffer.concat(chunks).toString('utf8');
      calls.push({ raw, body: JSON.parse(raw || '{}') });
      const events = streams[calls.length - 1] ?? streams[streams.length - 1] ?? [];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) response.write('event: ' + String(event['type']) + '\ndata: ' + JSON.stringify(event) + '\n\n');
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  servers.push(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  return { url: 'http://127.0.0.1:' + String(address.port) + '/v1', calls };
}

const completed = { type: 'response.completed', response: { id: 'resp', status: 'completed', usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } };
const searchCall: Array<Record<string, unknown>> = [
  { type: 'response.created', response: { id: 'resp', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'tool_search_call', id: 'ts_1', call_id: 'call_ts1', execution: 'client', status: 'in_progress' } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'tool_search_call', id: 'ts_1', call_id: 'call_ts1', execution: 'client', status: 'completed', arguments: { goal: 'weather in Paris' } } },
  completed,
];
const functionCall = (name: string, args: string): Array<Record<string, unknown>> => [
  { type: 'response.created', response: { id: 'resp', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name, arguments: '' } },
  { type: 'response.function_call_arguments.done', output_index: 0, arguments: args },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name, arguments: args } },
  completed,
];
const textAnswer: Array<Record<string, unknown>> = [
  { type: 'response.created', response: { id: 'resp', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Sunny.', annotations: [] }] } },
  completed,
];

const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name, description: name + ' description', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  replay: 'safe', sideEffect: false, execute: async () => ({ content: [] }), ...extra,
});
/** The list a run hands over: the shown tools (tool_search and tool_call among them) first, the hidden ones marked. */
const TOOLS: Tool[] = [
  tool('get_time'), tool('tool_search'), tool('tool_call'),
  tool('get_weather', { deferLoading: true }), tool('weather.alerts', { deferLoading: true }),
];

const config = (url: string) => backendConfigSchema.parse({ MODEL_BASE_URL: url, MODEL_API_KEY: 'sk-x', MODEL_ID: 'test-model', API_TOKEN: 'dev-token', OWNER_ID: 'user-1' });
const system: Message = { role: 'system', content: 'FROZEN-SYSTEM', timestamp: 0 };
const user: Message = { role: 'user', content: 'What is the weather in Paris?', timestamp: 1 };
const signal = () => new AbortController().signal;
const bodyTools = (call: Captured | undefined) => (call?.body['tools'] as Array<Record<string, unknown>>);
const bodyInput = (call: Captured | undefined) => (call?.body['input'] as Array<Record<string, unknown>>);

describe('native deferred tool loading (Responses wire)', () => {
  it('declares the native search and every hidden tool as deferred, runs the search as a tool_search call, and replays the pair in place', async () => {
    const server = await startServer([searchCall, functionCall('get_weather', '{"city":"Paris"}'), textAnswer]);
    const provider = createOpenAIProvider(config(server.url), { toolSearch: 'responses-tool-search' });

    // 1. The model searches.
    const first = await provider.call({ messages: [system, user], tools: TOOLS, signal: signal(), sessionKey: 'agt:cvn' });
    const tools = bodyTools(server.calls[0]);
    expect(tools.filter((entry) => entry['type'] === 'function' && entry['defer_loading'] !== true).map((entry) => entry['name'])).toEqual(['get_time']);
    expect(tools.find((entry) => entry['type'] === 'tool_search')).toMatchObject({ execution: 'client', parameters: { required: ['goal'] } });
    expect(tools.filter((entry) => entry['defer_loading'] === true).map((entry) => entry['name'])).toEqual(['get_weather', 'weather_alerts']);
    // Our own function of that name is reserved by the native tool, and the proxy is not offered; nothing is sent in the pi-ai forms Muse rejects.
    expect(tools.filter((entry) => entry['name'] === 'tool_search' || entry['name'] === 'tool_call')).toEqual([]);
    expect(server.calls[0]?.raw).not.toContain('additional_tools');
    expect(first.toolCalls).toEqual([{ id: 'call_ts1', name: 'tool_search', arguments: { query: 'weather in Paris' } }]);
    expect(first.stopReason).toBe('tool_calls');
    const searched = first.message as AssistantMessage;
    expect(searched.content).toContainEqual(expect.objectContaining({ type: 'toolCall', id: 'call_ts1', name: 'tool_search', nativeSearch: true, itemId: 'ts_1' }));

    // 2. We answer; the stored result lists what it loaded (the dotted name travels as its wire name).
    const searchResult = toolMessage('tool_search', 'call_ts1', { content: [{ type: 'text', text: 'Loaded 2 tools' }], details: { loadedTools: ['get_weather', 'weather.alerts'] } });
    const afterSearch: Message[] = [system, user, searched, searchResult];
    const second = await provider.call({ messages: afterSearch, tools: TOOLS, signal: signal(), sessionKey: 'agt:cvn' });
    const items = bodyInput(server.calls[1]);
    expect(items.slice(-2)).toEqual([
      { type: 'tool_search_call', id: 'ts_1', call_id: 'call_ts1', execution: 'client', status: 'completed', arguments: { goal: 'weather in Paris' } },
      expect.objectContaining({ type: 'tool_search_output', call_id: 'call_ts1', execution: 'client', status: 'completed' }),
    ]);
    const output = items[items.length - 1] as { tools: Array<Record<string, unknown>> };
    expect(output.tools.map((entry) => [entry['name'], entry['defer_loading']])).toEqual([['get_weather', true], ['weather_alerts', true]]);
    expect(items.some((entry) => entry['name'] === 'tool_search')).toBe(false);
    expect(JSON.stringify(bodyTools(server.calls[1]))).toBe(JSON.stringify(tools));
    // The model calls the real tool by its own name.
    expect(second.toolCalls).toEqual([{ id: 'call_1|fc_1', name: 'get_weather', arguments: { city: 'Paris' } }]);

    // 3. Later requests: the tools array and every earlier input item are byte-identical.
    const afterCall: Message[] = [...afterSearch, second.message as AssistantMessage, toolMessage('get_weather', 'call_1|fc_1', { content: [{ type: 'text', text: '21C, sunny' }] })];
    await provider.call({ messages: afterCall, tools: TOOLS, signal: signal(), sessionKey: 'agt:cvn' });
    const later = bodyInput(server.calls[2]);
    expect(JSON.stringify(later.slice(0, items.length))).toBe(JSON.stringify(items));
    expect(later.length).toBeGreaterThan(items.length);
    expect(JSON.stringify(bodyTools(server.calls[2]))).toBe(JSON.stringify(tools));
    expect(JSON.stringify(items.slice(0, bodyInput(server.calls[0]).length))).toBe(JSON.stringify(bodyInput(server.calls[0])));
  });

  it('leaves the proxy wire alone: hidden tools are not declared, tool_call stays, and a tool_call is unwrapped into the tool it reaches', async () => {
    const proxied = functionCall('tool_call', '{"name":"weather.alerts","arguments":{"city":"Paris"}}');
    const server = await startServer([proxied]);
    const provider = createOpenAIProvider(config(server.url), {});
    const turn = await provider.call({ messages: [system, user], tools: TOOLS, signal: signal(), sessionKey: 'agt:cvn' });
    expect(bodyTools(server.calls[0]).map((entry) => entry['name'])).toEqual(['get_time', 'tool_search', 'tool_call']);
    expect(server.calls[0]?.raw).not.toContain('defer_loading');
    // The harness sees the real tool and its own arguments; the stored message keeps the call as the model made it.
    expect(turn.toolCalls).toEqual([{ id: 'call_1|fc_1', name: 'weather.alerts', arguments: { city: 'Paris' }, wireName: 'tool_call' }]);
    const stored = turn.message as AssistantMessage;
    expect(stored.content).toContainEqual(expect.objectContaining({ type: 'toolCall', name: 'tool_call', arguments: { name: 'weather.alerts', arguments: { city: 'Paris' } } }));
  });

  it('keeps a stored search as an ordinary function call when no hidden tool is declared (aux calls, compaction without tools)', async () => {
    const server = await startServer([textAnswer]);
    const provider = createOpenAIProvider(config(server.url), { toolSearch: 'responses-tool-search' });
    const stored: AssistantMessage = {
      role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'test-model', stopReason: 'toolUse', timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      content: [{ type: 'toolCall', id: 'call_ts1', name: 'tool_search', arguments: { query: 'weather' }, nativeSearch: true, itemId: 'ts_1' } as AssistantMessage['content'][number]],
    };
    await provider.call({ messages: [system, user, stored, toolMessage('tool_search', 'call_ts1', { content: [{ type: 'text', text: 'Loaded' }], details: { loadedTools: [] } })], tools: [], signal: signal() });
    expect(server.calls[0]?.raw).not.toContain('tool_search_call');
    expect(bodyInput(server.calls[0]).map((entry) => entry['type'])).toContain('function_call');
  });
});

/**
 * The provider's own web search: the request carries its tool (and the run offers Juno's web_search never alongside it),
 * the searches and the pages they read come back out of the stream, and the choice is made from the model and the setting.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Api, Message, Model } from '@earendil-works/pi-ai';
import type { Tool } from '../../../contracts/index.js';
import { backendConfigSchema } from '../../config.js';
import { endpointHasNativeSearch, useNativeWebSearch, withoutJunoSearch } from '../native-web-search.js';
import { createModelProvider, createOpenAIProvider } from '../provider.js';

interface Captured { path: string; body: Record<string, unknown> }

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

async function startServer(events: Array<Record<string, unknown>>) {
  const calls: Captured[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'GET') {
      // The platform default probes its model limits first.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'gpt-test', context_window: 128000, max_output_tokens: 8192 }] }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (part: Buffer) => chunks.push(part));
    request.on('end', () => {
      calls.push({ path: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) response.write('event: ' + String(event['type']) + '\ndata: ' + JSON.stringify(event) + '\n\n');
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  servers.push(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  return { url: 'http://127.0.0.1:' + String(address.port), calls };
}

const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 1 });
const lookup: Tool = {
  name: 'web_fetch', description: 'Fetch', parameters: { type: 'object', properties: { url: { type: 'string' } } },
  replay: 'safe', sideEffect: false, execute: async () => ({ content: [] }),
};
const ours: Tool = { ...lookup, name: 'web_search', description: 'Juno search' };

const searchedAnswer: Array<Record<string, unknown>> = [
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'rust 2026 edition', sources: [{ type: 'url', url: 'https://blog.rust-lang.org/2026' }, { type: 'url', url: 'https://example.com/other' }] } } },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] } },
  { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_1', content_index: 0, delta: 'The 2026 edition shipped.' },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The 2026 edition shipped.', annotations: [{ type: 'url_citation', url: 'https://blog.rust-lang.org/2026', title: 'Rust 2026 edition', start_index: 0, end_index: 5 }, { type: 'url_citation', url: 'https://cited.example/page', title: 'Cited page', start_index: 6, end_index: 9 }] }] } },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
];

describe('OpenAI Responses native web search', () => {
  const config = (url: string) => backendConfigSchema.parse({ MODEL_BASE_URL: url + '/v1', MODEL_API_KEY: 'sk-x', MODEL_ID: 'gpt-test', API_TOKEN: 'dev-token', OWNER_ID: 'user-1' });

  it('adds the provider search tool, asks for its sources, and returns the search with the pages it read and the pages the reply cites', async () => {
    const server = await startServer(searchedAnswer);
    const provider = createOpenAIProvider(config(server.url), { nativeWebSearch: true });
    const turn = await provider.call({ messages: [user('what is new in rust?')], tools: [lookup], signal: new AbortController().signal });
    const body = server.calls[0]!.body;
    expect((body['tools'] as Array<Record<string, unknown>>).map((tool) => tool['type'] === 'web_search' ? 'native' : tool['name'])).toEqual(['web_fetch', 'native']);
    expect(body['include']).toContain('web_search_call.action.sources');
    expect(turn.text).toBe('The 2026 edition shipped.');
    expect(turn.toolCalls).toEqual([]);
    expect(turn.webSearches).toEqual([{
      query: 'rust 2026 edition',
      sources: [
        { title: 'Rust 2026 edition', url: 'https://blog.rust-lang.org/2026' },
        { title: 'example.com', url: 'https://example.com/other' },
        { title: 'Cited page', url: 'https://cited.example/page' },
      ],
    }]);
  });

  it('sends no search tool and reports no searches when the run did not choose it', async () => {
    const server = await startServer(searchedAnswer);
    const provider = createOpenAIProvider(config(server.url), {});
    const turn = await provider.call({ messages: [user('hi')], tools: [ours], signal: new AbortController().signal });
    expect((server.calls[0]!.body['tools'] as Array<Record<string, unknown>>).map((tool) => tool['name'])).toEqual(['web_search']);
    expect(turn.webSearches).toBeUndefined();
  });
});

describe('Anthropic native web search', () => {
  const sse = (type: string, rest: Record<string, unknown>): Record<string, unknown> => ({ type, ...rest });
  const stream: Array<Record<string, unknown>> = [
    sse('message_start', { message: { id: 'msg_1', model: 'claude-test', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } }),
    sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"anthr' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'opic news"}' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://anthropic.com/news', title: 'News', page_age: 'April 30, 2026' }, { type: 'web_search_result', url: 'https://example.org/a', title: 'Another' }] } }),
    sse('content_block_stop', { index: 1 }),
    sse('content_block_start', { index: 2, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 2, delta: { type: 'text_delta', text: 'Here is the news.' } }),
    sse('content_block_delta', { index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://anthropic.com/news', title: 'Anthropic News', cited_text: 'x' } } }),
    sse('content_block_stop', { index: 2 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }),
    sse('message_stop', {}),
  ];

  it('adds the server tool next to ours-minus-web_search and returns the search, its pages and the cited title', async () => {
    const server = await startServer(stream);
    const model: Model<Api> = {
      api: 'anthropic-messages', provider: 'anthropic', id: 'claude-test', name: 'claude-test', baseUrl: server.url, reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192,
    };
    const provider = createModelProvider({
      resolve: async () => ({ apiKey: 'sk-ant-test', buildModel: () => model }),
      limits: { getLimits: async () => ({ contextWindow: 200000, maxOutputTokens: 8192 }) },
      sessionIdBody: true,
      textOnlyHint: '',
    }, { nativeWebSearch: true });
    const turn = await provider.call({ messages: [user('news?')], tools: [lookup], signal: new AbortController().signal });
    const tools = server.calls[0]!.body['tools'] as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool['name'])).toEqual(['web_fetch', 'web_search']);
    expect(tools[1]).toMatchObject({ type: 'web_search_20250305' });
    expect(turn.text).toBe('Here is the news.');
    expect(turn.webSearches).toEqual([{
      query: 'anthropic news',
      sources: [{ title: 'Anthropic News', url: 'https://anthropic.com/news' }, { title: 'Another', url: 'https://example.org/a' }],
    }]);
  });
});

describe('choosing native or Juno search', () => {
  it('knows the vendors by their own host and the wire; a proxy is not assumed to forward the tool', () => {
    expect(endpointHasNativeSearch('openai-responses', 'https://api.openai.com/v1')).toBe(true);
    expect(endpointHasNativeSearch('anthropic-messages', 'https://api.anthropic.com')).toBe(true);
    expect(endpointHasNativeSearch('openai-completions', 'https://api.openai.com/v1')).toBe(false);
    expect(endpointHasNativeSearch('openai-responses', 'https://openrouter.ai/api/v1')).toBe(false);
    expect(endpointHasNativeSearch('openai-responses', 'not a url')).toBe(false);
  });

  it('auto uses the provider search when the model has one; juno never does; a model without it never does', () => {
    expect(useNativeWebSearch(undefined, true)).toBe(true);
    expect(useNativeWebSearch('auto', true)).toBe(true);
    expect(useNativeWebSearch('juno', true)).toBe(false);
    expect(useNativeWebSearch('auto', false)).toBe(false);
  });

  it('takes Juno web_search out of the run tools only when the provider search is offered', () => {
    expect(withoutJunoSearch([ours, lookup], true).map((tool) => tool.name)).toEqual(['web_fetch']);
    expect(withoutJunoSearch([ours, lookup], false).map((tool) => tool.name)).toEqual(['web_search', 'web_fetch']);
  });
});

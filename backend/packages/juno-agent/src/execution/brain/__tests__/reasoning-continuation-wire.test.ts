/**
 * Actual OpenAI-completions wire regression for the DeepSeek thinking-mode replay rule
 * (baseline: .data/ph-child-live-diagnostic.json, provider 400 "reasoning_content must be
 * passed back"): the flagged catalog id resends reasoning_content on every replayed assistant
 * turn, with an empty string on the tool turn that carried no thinking, and keeps a non-empty
 * provider signature verbatim; no reasoning request parameter is invented and unflagged routes
 * on ordinary models send no reasoning_content at all.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { Tool } from '../../../contracts/index.js';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { backendConfigSchema } from '../../config.js';
import { createOpenAIProvider } from '../provider.js';
import { assistantWireCompatFor } from '../provider-wire-compat.js';

interface ServerHandle {
  url: string;
  bodies: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startServer(streams: Array<Array<Record<string, unknown>>>): Promise<ServerHandle> {
  const bodies: Array<Record<string, unknown>> = [];
  let served = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? '';
    if (request.method === 'GET' && url.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [
        { id: 'test-model', context_window: 128000, max_output_tokens: 8192 },
        { id: 'opencode-go/deepseek-v4.1-flash', context_window: 128000, max_output_tokens: 8192 },
      ] }));
      return;
    }
    if (request.method !== 'POST' || !url.endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (part: Buffer) => chunks.push(part));
    request.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      const stream = streams[served] ?? [];
      served += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const payload of stream) response.write('data: ' + JSON.stringify(payload) + '\n\n');
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port');
  return {
    url: 'http://127.0.0.1:' + String(address.port) + '/v1',
    bodies,
    close: () => new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())),
  };
}

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
  choices: [{ index: 0, delta, ...extra }],
});

/** A turn that produced only a tool call: no reasoning delta reached the wire (child_wait shape). */
const toolCallStream = [
  chunk({ role: 'assistant', content: '' }),
  chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function',
    function: { name: 'shell_run', arguments: '{"command":"echo hi"}' } }] }),
  chunk({}, { finish_reason: 'tool_calls' }),
];

/** A turn where the reasoning_content stream produced a visible thought before the tool call. */
const thinkingToolCallStream = [
  chunk({ role: 'assistant', reasoning_content: 'walked the diff and picked the smallest change' }),
  chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function',
    function: { name: 'shell_run', arguments: '{"command":"echo hi"}' } }] }),
  chunk({}, { finish_reason: 'tool_calls' }),
];

const textStream = [chunk({ role: 'assistant', content: 'done' }), chunk({}, { finish_reason: 'stop' })];

const shellTool: Tool = {
  name: 'shell.run', description: "Run a shell command in this agent's sandbox",
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  replay: 'never', sideEffect: true, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
};

const userMessage: Message = { role: 'user', content: 'check the build', timestamp: 1 };

const toolResultMessage: Message = {
  role: 'toolResult', toolCallId: 'call_1', toolName: 'shell.run',
  content: [{ type: 'text', text: 'hi' }], isError: false, timestamp: 3,
};

const configFor = (url: string, modelId: string) => backendConfigSchema.parse({
  DATABASE_URL: 'postgres://localhost',
  AGENTD_PORT: 8787,
  API_TOKEN: 'dev-token', OWNER_ID: 'user-1', MODEL_BASE_URL: url, MODEL_WIRE_API: 'chat', MODEL_API_KEY: 'sk-secret-key',
  MODEL_ID: modelId, FAST_MODEL_ID: '', FAST_MODEL_BASE_URL: '', FAST_MODEL_API_KEY: '', SYSTEM_ONE_BASE_URL: '', SYSTEM_ONE_API_KEY: '', SYSTEM_ONE_MODEL_ID: '',
});

function wireAssistantTurns(body: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const messages = body?.['messages'];
  if (!Array.isArray(messages)) return [];
  return messages.filter((entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null && 'role' in entry && entry['role'] === 'assistant');
}

/** replays one real provider turn and returns the wire body of the follow-up continuation call */
async function continuationBody(
  server: ServerHandle,
  config: ReturnType<typeof backendConfigSchema.parse>,
): Promise<{ first: AssistantMessage | undefined; body: Record<string, unknown> }> {
  const provider = createOpenAIProvider(config);
  const options = { signal: AbortSignal.timeout(10_000), tools: [shellTool] };
  const firstTurn = await provider.call({ ...options, messages: [userMessage] });
  await provider.call({
    ...options, messages: [userMessage, ...(firstTurn.message ? [firstTurn.message] : []), toolResultMessage],
  });
  return { first: firstTurn.message, body: server.bodies[1] ?? {} };
}

describe('provider resolves the DeepSeek manifest identity', () => {
  it('pins the required replay field for the routed opencode-go DeepSeek model', () => {
    expect(assistantWireCompatFor('opencode-go/deepseek-v4.1-flash')).toEqual({
      requiresReasoningContentOnAssistantMessages: true,
    });
  });

  it('stays plain for ids outside the builtin manifest', () => {
    expect(assistantWireCompatFor('test-model')).toEqual({
      requiresReasoningContentOnAssistantMessages: false,
    });
  });
});

describe('provider resends the DeepSeek reasoning_content replay rule', () => {
  it('resends an empty reasoning_content on the tool turn that carried no thinking', async () => {
    const server = await startServer([toolCallStream, textStream]);
    try {
      const { body } = await continuationBody(server, configFor(server.url, 'opencode-go/deepseek-v4.1-flash'));
      expect(body['reasoning_effort']).toBeUndefined();
      expect(body['thinking']).toBeUndefined();
      const turns = wireAssistantTurns(body);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.['reasoning_content']).toBe('');
      expect(turns[0]?.['tool_calls']).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it('keeps a non-empty provider reasoning signature verbatim on replay', async () => {
    const server = await startServer([thinkingToolCallStream, textStream]);
    try {
      const { first, body } = await continuationBody(server, configFor(server.url, 'opencode-go/deepseek-v4.1-flash'));
      const thinkingBlock = first?.content.find(block => block.type === 'thinking');
      expect(thinkingBlock).toMatchObject({ thinking: 'walked the diff and picked the smallest change', thinkingSignature: 'reasoning_content' });
      const turns = wireAssistantTurns(body);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.['reasoning_content']).toBe('walked the diff and picked the smallest change');
    } finally {
      await server.close();
    }
  });

  it('leaves ordinary unflagged models without any reasoning_content replay field', async () => {
    const server = await startServer([toolCallStream, textStream]);
    try {
      const { body } = await continuationBody(server, configFor(server.url, 'test-model'));
      const turns = wireAssistantTurns(body);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.['reasoning_content']).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

/**
 * Drives the provider against a minimal OpenAI-completions SSE server so the alias boundary is proven
 * on the real wire shape: the request must carry valid protocol names, a streamed call must map back to
 * the internal name, and an error body must not leak the configured key.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { ModelCallStats, Tool } from '../../../contracts/index.js';
import type { Message } from '@earendil-works/pi-ai';
import { backendConfigSchema } from '../../config.js';
import { createOpenAIProvider } from '../provider.js';
import { ProviderFailureError } from '../model-failure.js';

interface ServerHandle {
  url: string;
  bodies: Array<Record<string, unknown>>;
  headers: Array<Record<string, string | string[] | undefined>>;
  close(): Promise<void>;
}

async function startServer(respond: (count: number, res: ServerResponse) => void): Promise<ServerHandle> {
  const bodies: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string | string[] | undefined>> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model', context_window: 128000, max_output_tokens: 8192 }] }));
      return;
    }
    if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      headers.push(req.headers);
      respond(bodies.length, res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    headers,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function sse(res: ServerResponse, payloads: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const payload of payloads) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.end('data: [DONE]\n\n');
}

const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
  choices: [{ index: 0, delta, ...extra }],
});

const configFor = (url: string) => backendConfigSchema.parse({
  DATABASE_URL: 'postgres://localhost',
  AGENTD_PORT: 8787,
  API_TOKEN: 'dev-token', OWNER_ID: 'user-1', MODEL_BASE_URL: url, MODEL_WIRE_API: 'chat', MODEL_API_KEY: 'sk-secret-key',
  MODEL_ID: 'test-model', FAST_MODEL_ID: '', FAST_MODEL_BASE_URL: '', FAST_MODEL_API_KEY: '', SYSTEM_ONE_BASE_URL: '', SYSTEM_ONE_API_KEY: '', SYSTEM_ONE_MODEL_ID: '',
});

const shellTool: Tool = {
  name: 'shell.run',
  description: "Run a shell command in this agent's sandbox",
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  replay: 'never',
  sideEffect: true,
  execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
};

const screenshotResult: Message = {
  role: 'toolResult', toolCallId: 'call-shot', toolName: 'computer.screenshot',
  content: [{ type: 'text', text: 'Captured screen (1280x800)' },
    { type: 'image', data: 'png-base64', mimeType: 'image/png' }],
  isError: false, timestamp: 1,
};

const userImage: Message = {
  role: 'user', content: [{ type: 'text', text: 'What does this say?' },
    { type: 'image', data: 'png-base64', mimeType: 'image/png' }], timestamp: 1,
};

describe('OpenAI provider protocol aliasing', () => {
  it('sends a valid protocol name, streams the call back, and journals the internal name', async () => {
    const server = await startServer((_count, res) => sse(res, [
      chunk({ role: 'assistant', content: '' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function',
        function: { name: 'shell_run', arguments: '{"command":"echo hi"}' } }] }),
      chunk({}, { finish_reason: 'tool_calls' }),
      { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'test-model',
        choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
    ]));
    try {
      const provider = createOpenAIProvider(configFor(server.url));
      const stats: ModelCallStats[] = [];
      const turn = await provider.call({
        signal: AbortSignal.timeout(10_000), tools: [shellTool],
        messages: [{ role: 'user', content: 'go', timestamp: Date.now() }],
        onStats: (measured) => stats.push(measured),
      });
      // One timing record per call: the response start and the first tool-call delta, within the total.
      expect(stats).toHaveLength(1);
      const [measured] = stats;
      expect(measured?.firstEventMs).toBeDefined();
      expect(measured?.firstTokenMs).toBeGreaterThanOrEqual(measured?.prepMs ?? 0);
      expect(measured?.totalMs).toBeGreaterThanOrEqual(measured?.firstTokenMs ?? 0);
      const sentTools = server.bodies[0]?.['tools'] as Array<{ function: { name: string } }>;
      expect(sentTools[0]?.function.name).toBe('shell_run');
      expect(turn.toolCalls[0]?.name).toBe('shell.run');
      const callBlock = turn.message?.content.find(block => block.type === 'toolCall');
      expect(callBlock).toMatchObject({ name: 'shell.run' });
      expect(turn.stopReason).toBe('tool_calls');
    } finally {
      await server.close();
    }
  });

  it('aliases the internal name inside replayed assistant/toolResult history', async () => {
    const server = await startServer((_count, res) => sse(res, [
      chunk({ role: 'assistant', content: 'done' }),
      chunk({}, { finish_reason: 'stop' }),
    ]));
    try {
      const provider = createOpenAIProvider(configFor(server.url));
      await provider.call({
        signal: AbortSignal.timeout(10_000), tools: [shellTool],
        messages: [
          { role: 'user', content: 'go', timestamp: 1 },
          { role: 'assistant', api: 'openai-completions', provider: 'openai', model: 'test-model',
            content: [{ type: 'toolCall', id: 'call_1', name: 'shell.run', arguments: { command: 'echo hi' } }],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'toolUse', timestamp: 2 },
          { role: 'toolResult', toolCallId: 'call_1', toolName: 'shell.run',
            content: [{ type: 'text', text: 'hi' }], isError: false, timestamp: 3 },
        ],
      });
      const messages = server.bodies[0]?.['messages'] as Array<{ role: string; tool_calls?: Array<{ function: { name: string } }>; name?: string }>;
      const assistant = messages.find(message => message.role === 'assistant');
      expect(assistant?.tool_calls?.[0]?.function.name).toBe('shell_run');
    } finally {
      await server.close();
    }
  });

  it('surfaces the provider error reason without leaking the configured key', async () => {
    const server = await startServer((_count, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream rejected key sk-secret-key', type: 'invalid_request_error' } }));
    });
    try {
      const provider = createOpenAIProvider(configFor(server.url));
      const error = await provider.call({
        signal: AbortSignal.timeout(10_000), tools: [],
        messages: [{ role: 'user', content: 'go', timestamp: Date.now() }],
      }).then(() => null, (thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : '';
      // A 400 is a classified, terminal invalid request with the provider's reason and no secret.
      expect(message).toContain('Model request rejected (400)');
      expect(message).not.toContain('sk-secret-key');
      expect(error instanceof ProviderFailureError && error.failure.kind).toBe('invalid_request');
    } finally {
      await server.close();
    }
  });

  it('refuses a tool screenshot for a text-only model instead of silently stripping it', async () => {
    const server = await startServer((_count, res) => sse(res, [chunk({}, { finish_reason: 'stop' })]));
    try {
      const provider = createOpenAIProvider(configFor(server.url));
      await expect(provider.call({
        signal: AbortSignal.timeout(10_000), tools: [], messages: [screenshotResult],
      })).rejects.toThrow(/Model capability error/);
      expect(server.bodies).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('refuses a user image for a text-only model', async () => {
    const server = await startServer((_count, res) => sse(res, [chunk({}, { finish_reason: 'stop' })]));
    try {
      const provider = createOpenAIProvider(configFor(server.url));
      await expect(provider.call({
        signal: AbortSignal.timeout(10_000), tools: [], messages: [userImage],
      })).rejects.toThrow(/configured text-only/);
      expect(server.bodies).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('sends the screenshot as an image_url when the model supports images', async () => {
    const server = await startServer((_count, res) => sse(res, [
      chunk({ role: 'assistant', content: 'Sandbox interaction acceptance' }),
      chunk({}, { finish_reason: 'stop' }),
    ]));
    try {
      const provider = createOpenAIProvider(configFor(server.url), { supportsImages: true });
      const turn = await provider.call({
        signal: AbortSignal.timeout(10_000), tools: [], messages: [screenshotResult],
      });
      const body = JSON.stringify(server.bodies[0]);
      expect(body).toContain('image_url');
      expect(body).toContain('data:image/png;base64,png-base64');
      expect(turn.text).toContain('Sandbox interaction acceptance');
    } finally {
      await server.close();
    }
  });
});

describe('prompt-cache affinity', () => {
  it('sends the same hashed session-id on every call of a session, and a different one for another session', async () => {
    const server = await startServer((_count, res) => sse(res, [chunk({ content: 'ok' }), chunk({}, { finish_reason: 'stop' })]));
    try {
      const provider = createOpenAIProvider(configFor(server.url));
      const call = (sessionKey: string) => provider.call({
        messages: [{ role: 'user', content: 'hi', timestamp: 1 }], tools: [], signal: AbortSignal.timeout(10_000), sessionKey,
      });
      await call('agt-1:cvn-1');
      await call('agt-1:cvn-1');
      await call('agt-2:cvn-9');
      const ids = server.headers.map(h => h['session-id']);
      expect(ids[0]).toMatch(/^juno-[0-9a-f]{32}$/);
      expect(ids[1]).toBe(ids[0]);
      expect(ids[2]).not.toBe(ids[0]);
      expect(server.headers[0]?.['thread-id']).toBe(ids[0]);
      expect(String(ids[0])).not.toContain('agt-1');
    } finally {
      await server.close();
    }
  });
});

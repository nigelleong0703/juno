/**
 * Wire proof for the frozen account runtime controls: a minimal OpenAI-completions server shows
 * exactly what the provider sends. A known model maximum caps the account request; an unknown
 * maximum is never guessed into a cap, and no reasoning field is sent when nothing was frozen.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { backendConfigSchema } from '../../config.js';
import { createOpenAIProvider, type OpenAIProviderOptions } from '../provider.js';

interface ServerHandle {
  url: string;
  bodies: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startServer(limits: Record<string, unknown>): Promise<ServerHandle> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model', ...limits }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
        id: 'c', object: 'chat.completion.chunk', created: 1, model: 'test-model',
        choices: [{ index: 0, delta, ...extra }],
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify(chunk({ role: 'assistant', content: 'ok' })) + '\n\n');
      res.write('data: ' + JSON.stringify(chunk({}, { finish_reason: 'stop' })) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port');
  return {
    url: 'http://127.0.0.1:' + String(address.port) + '/v1',
    bodies,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const messages = [{ role: 'user' as const, content: 'go', timestamp: 1 }];

/** Runs one capped call and returns the request body the provider actually sent. */
async function sentBody(limits: Record<string, unknown>, options: OpenAIProviderOptions) {
  const server = await startServer(limits);
  try {
    const config = backendConfigSchema.parse({ MODEL_WIRE_API: 'chat', MODEL_BASE_URL: server.url, MODEL_API_KEY: 'sk-secret', MODEL_ID: 'test-model' });
    await createOpenAIProvider(config, options).call({ signal: AbortSignal.timeout(10_000), tools: [], messages });
    const body = server.bodies[0] ?? {};
    return { body, maxTokens: body['max_tokens'] ?? body['max_completion_tokens'] };
  } finally {
    await server.close();
  }
}

describe('provider applies the frozen runtime controls', () => {
  it('sends reasoning_effort and temperature and clamps the request to the published maximum', async () => {
    const { body, maxTokens } = await sentBody(
      { context_window: 1000, max_output_tokens: 200 },
      { supportsImages: false, reasoningEffort: 'high', temperature: 0.25, maxOutputTokens: 5000 },
    );
    expect(body['reasoning_effort']).toBe('high');
    expect(body['temperature']).toBe(0.25);
    expect(maxTokens).toBe(200);
  });

  it('honours an account output request without inventing a cap when the maximum is unknown', async () => {
    const { maxTokens } = await sentBody({ context_window: 100_000 }, { supportsImages: false, maxOutputTokens: 1234 });
    expect(maxTokens).toBe(1234);
  });

  it('sends no reasoning field and no output cap when nothing was frozen', async () => {
    const { body, maxTokens } = await sentBody({}, { supportsImages: false });
    expect(body['reasoning_effort']).toBeUndefined();
    expect(maxTokens).toBeUndefined();
    // The adapter's legacy default temperature survives when the account sets none.
    expect(body['temperature']).toBe(0.7);
  });

  it('sends no output cap when only context capacity is known', async () => {
    const { body, maxTokens } = await sentBody({ context_window: 1048576 }, { supportsImages: false });
    expect(maxTokens).toBeUndefined();
    expect(body['reasoning_effort']).toBeUndefined();
  });

  it('clamps the owner output request to remaining context', async () => {
    const { maxTokens } = await sentBody({ context_window: 1000 }, { supportsImages: false, maxOutputTokens: 5000 });
    expect(maxTokens).toBeDefined();
    if (maxTokens === undefined) return;
    expect(typeof maxTokens).toBe('number');
    if (typeof maxTokens !== 'number') return;
    expect(maxTokens).toBeLessThan(1000);
    expect(maxTokens).toBeLessThan(5000);
  });
});

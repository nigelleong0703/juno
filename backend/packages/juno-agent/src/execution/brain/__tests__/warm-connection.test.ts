// A voice call's prepare opens the provider connection ahead of the turn: one credential-free GET of the model list through the call's own fetch.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { RunServices } from '../../harness/services/run-types.js';
import { prepareConversation } from '../../harness/services/prepare.js';
import { createGuardedFetch, createModelFetch, MCP_ALLOW_PRIVATE_HOSTS } from '../../../modules/tools/net/guardedFetch.js';
import { createModelProvider } from '../provider.js';
import { findBuiltinModel } from '../builtin-providers.js';

function museModel() {
  const found = findBuiltinModel('opencode-go', 'muse-spark-1.3-contributor');
  if (found === undefined) throw new Error('Muse is missing from the built-in catalog');
  return found;
}

function providerWith(fetchImpl: typeof fetch) {
  const model = museModel();
  return createModelProvider({
    resolve: async () => ({ apiKey: 'SECRET-KEY', buildModel: () => ({ ...model, baseUrl: 'https://models.example.test/v1/' }) }),
    limits: { getLimits: async () => ({ contextWindow: model.contextWindow }) },
    fetch: fetchImpl, sessionIdBody: true, textOnlyHint: '',
  });
}

const target = { ownerId: 'o', agentId: 'a', conversationId: 'c', sessionKey: 'a:c' };
const services = (provider: ReturnType<typeof providerWith>, forAgent: () => Promise<never[]>) =>
  ({ brain: { warmConnection: ({ signal }: { signal: AbortSignal }) => provider.warmConnection?.(signal) ?? Promise.resolve('skipped') }, toolRegistry: { forAgent } }) as unknown as RunServices;

describe('connection warm-up', () => {
  it('sends one GET of the model list through the provider\'s fetch, with no key, and swallows failures', async () => {
    const seen: Array<{ url: string; method?: string; headers: unknown }> = [];
    const ok: typeof fetch = async (input, init) => { seen.push({ url: String(input), headers: init?.headers, ...(init?.method === undefined ? {} : { method: init.method }) }); return new Response('{}'); };
    expect(await prepareConversation(services(providerWith(ok), async () => []), target, new AbortController().signal)).toBe('prepared');
    expect(seen).toEqual([{ url: 'https://models.example.test/v1/models', method: 'GET', headers: undefined }]);

    const down: typeof fetch = async () => { throw new TypeError('network down'); };
    // The warm-up failing does not fail the preparation while tool discovery works; both failing reports failed, never throws.
    expect(await prepareConversation(services(providerWith(down), async () => []), target, new AbortController().signal)).toBe('prepared');
    expect(await prepareConversation(services(providerWith(down), async () => { throw new Error('registry down'); }), target, new AbortController().signal)).toBe('failed');
  });
});

describe('the model client keeps its sockets', () => {
  async function connectionsFor(fetchImpl: typeof fetch): Promise<number> {
    let connections = 0;
    const server = http.createServer((_req, res) => res.end('ok'));
    server.on('connection', () => { connections += 1; });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port) + '/models';
      for (let i = 0; i < 2; i += 1) await (await fetchImpl(url)).arrayBuffer();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    return connections;
  }

  it('reuses the connection of the warm-up for the next request; the plain guarded client opens one each time', async () => {
    process.env[MCP_ALLOW_PRIVATE_HOSTS] = '1';
    try {
      expect(await connectionsFor(createGuardedFetch())).toBe(2);
      expect(await connectionsFor(createModelFetch())).toBe(1);
    } finally {
      delete process.env[MCP_ALLOW_PRIVATE_HOSTS];
    }
  });
});

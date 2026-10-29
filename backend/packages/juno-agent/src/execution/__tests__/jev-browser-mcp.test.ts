import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../../contracts/index.js';
import { createMemoryStore } from '../../testing/store.js';
import { loadConfig } from '../config.js';
import { handleJevRelay, isJevBrowserMcpEnabled, jevConnectionIdForOwner, jevMcpServerConfig } from '../jev-browser-mcp.js';
import { isJevConnectionId, isJevTool } from '../jev-browser-gate.js';

function scoped(): Store {
  const scoped = createMemoryStore().forOwner?.('owner-1');
  if (scoped === undefined) throw new Error('store requires forOwner');
  return scoped;
}

describe('jev browser mcp opt-in and private native relay', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it('enables only on the exact operator value and keeps owner-bound identities', () => {
    expect(isJevBrowserMcpEnabled({ JEV_BROWSER_MCP_ENABLED: '1' })).toBe(true);
    expect(isJevBrowserMcpEnabled({})).toBe(false);
    expect(isJevBrowserMcpEnabled({ JEV_BROWSER_MCP_ENABLED: '0' })).toBe(false);
    expect(isJevBrowserMcpEnabled({ JEV_BROWSER_MCP_ENABLED: 'true' })).toBe(false);
    const a = jevConnectionIdForOwner('owner-1');
    const b = jevConnectionIdForOwner('owner-2');
    expect(a).not.toBe(b);
    expect(isJevConnectionId(a)).toBe(true);
    expect(isJevTool({ name: 'x', origin: { connectionId: a } })).toBe(true);
    expect(isJevTool({ name: 'x', origin: { connectionId: 'other' } })).toBe(false);
    expect(jevMcpServerConfig().env['TYPESAFE_API_KEY']).not.toContain('sk-');
  });

  it('rejects injected relay fields and refuses fast-model or missing native', async () => {
    const store = scoped();
    const config = loadConfig({ JEV_BROWSER_MCP_ENABLED: '1' });
    await expect(handleJevRelay({ store, config, ownerId: 'owner-1' }, { state: {}, questions: {}, model: 'evil' })).rejects.toThrow(/only state/);
    await expect(handleJevRelay({ store, config, ownerId: 'owner-1' }, { state: 's', questions: { q: {} } })).rejects.toThrow(/no real native/);
  });

  it('injects the backend native key and model into the original request only', async () => {
    let seenBody: Record<string, unknown> | undefined;
    let seenAuthorization = '';
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => {
        seenBody = JSON.parse(body) as Record<string, unknown>;
        seenAuthorization = request.headers.authorization ?? '';
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers: { q: 1 } }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const baseUrl = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port);
    const config = loadConfig({
      JEV_BROWSER_MCP_ENABLED: '1',
      SYSTEM_ONE_BASE_URL: baseUrl,
      SYSTEM_ONE_API_KEY: 'backend-native-secret',
      SYSTEM_ONE_MODEL_ID: 'jev-live',
    });
    const outcome = await handleJevRelay(
      { store: scoped(), config, ownerId: 'owner-1' },
      { state: { page: 'checkout' }, questions: { proceed: { type: 'noul', instructions: 'Proceed?' } } },
    );
    expect(outcome).toEqual({ status: 200, body: { answers: { q: 1 } } });
    expect(seenAuthorization).toBe('Bearer backend-native-secret');
    expect(seenBody).toEqual({
      model: 'jev-live',
      state: { page: 'checkout' },
      questions: { proceed: { type: 'noul', instructions: 'Proceed?' } },
    });
  });
});

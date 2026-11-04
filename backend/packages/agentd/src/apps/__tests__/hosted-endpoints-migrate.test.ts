/**
 * Connections to the servers our gateway hosts were stored with a full URL; whichever origin it had (loopback, an sslip.io host), the rows
 * keep only the path, endpoint and OAuth `resource` both, the tokens untouched. Custom and third-party URLs stay as they are.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { migrateHostedEndpoints } from '../hosted-endpoints-migrate.js';

const sealed = (resource: string) => ({ issuer: 'https://accounts.google.com', clientId: 'c', resource, accessToken: 'enc:v1:x', refreshToken: 'enc:v1:y' });

describe('migrateHostedEndpoints', () => {
  it('rewrites hosted rows stored under any origin to the path, leaves custom URLs alone, and runs once', async () => {
    const store = createMemoryStore();
    const row = (id: string, endpoint: string, extra: object = {}) => store.put('connections', { id, kind: 'mcp', name: id, ownerId: 'o1', enabled: true, status: 'connected', transport: 'http', endpoint, ...extra } as never);
    await row('con-gmail', 'http://127.0.0.1:8787/mcp/google/gmail', { catalogId: 'gmail', auth: sealed('http://127.0.0.1:8787/mcp/google/gmail') });
    await row('con-drive', 'https://203-0-113-7.sslip.io/mcp/google/google-drive', { catalogId: 'google-drive', auth: sealed('https://203-0-113-7.sslip.io/mcp/google/google-drive') });
    await row('con-linear', 'https://mcp.linear.app/mcp', { catalogId: 'linear', auth: sealed('https://mcp.linear.app/mcp') });
    await row('con-custom', 'http://127.0.0.1:8787/mcp/google/gmail', { auth: sealed('http://127.0.0.1:8787/mcp/google/gmail') });

    expect(await migrateHostedEndpoints(store)).toEqual({ skipped: false, rewritten: 2 });
    const get = async (id: string) => (await store.get('connections', id))!;
    expect(await get('con-gmail')).toMatchObject({ endpoint: '/mcp/google/gmail', status: 'connected', auth: sealed('/mcp/google/gmail') });
    expect(await get('con-drive')).toMatchObject({ endpoint: '/mcp/google/google-drive', auth: sealed('/mcp/google/google-drive') });
    expect(await get('con-linear')).toMatchObject({ endpoint: 'https://mcp.linear.app/mcp', auth: sealed('https://mcp.linear.app/mcp') });
    expect(await get('con-custom')).toMatchObject({ endpoint: 'http://127.0.0.1:8787/mcp/google/gmail', auth: sealed('http://127.0.0.1:8787/mcp/google/gmail') });

    expect(await migrateHostedEndpoints(store)).toEqual({ skipped: true, rewritten: 0 });
  });

  it('is idempotent on rows already in path form, even without the marker', async () => {
    const store = createMemoryStore();
    await store.put('connections', { id: 'con-gmail', kind: 'mcp', name: 'g', ownerId: 'o1', enabled: true, status: 'connected', transport: 'http', endpoint: '/mcp/google/gmail', catalogId: 'gmail', auth: sealed('/mcp/google/gmail') } as never);
    expect(await migrateHostedEndpoints(store)).toEqual({ skipped: false, rewritten: 0 });
    expect(await store.get('connections', 'con-gmail')).toMatchObject({ endpoint: '/mcp/google/gmail', auth: sealed('/mcp/google/gmail') });
  });
});

/**
 * Hostile internal-auth coverage. The private agentd serves exactly one identity shape: the
 * service bearer plus a non-empty x-owner-id header. Everything else is 401, accounts stay 404,
 * and the header owner is authoritative (a spoofed owner never widens a read).
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import { createInternalAgentApp } from '../internal-app.js';
import { testChannels } from '../../../__tests__/test-app.js';

const TOKEN = 'internal-test-secret';

function build() {
  const store = createMemoryStore();
  const app = createInternalAgentApp({
    store,
    bus: store.eventBus,
    enqueuer: new NoopEnqueuer(),
    channels: testChannels,
    internalToken: TOKEN,
  });
  return { store, app };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The list endpoint answers { items, nextCursor }; fail loudly instead of reading into an unknown. */
function itemsOf(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error('not a list page');
  return value.items;
}

describe('createInternalAgentApp', () => {
  it('refuses a missing or empty service token', () => {
    const store = createMemoryStore();
    expect(() =>
      createInternalAgentApp({
        store,
        bus: store.eventBus,
        enqueuer: new NoopEnqueuer(),
        channels: testChannels,
        internalToken: '',
      }),
    ).toThrow();
  });

  it('rejects a missing, wrong or owner-less bearer with 401', async () => {
    const { app } = build();
    expect((await app.request('/v1/agents')).status).toBe(401);
    expect(
      (await app.request('/v1/agents', { headers: { authorization: 'Bearer dev-token', 'x-owner-id': 'alice' } }))
        .status,
    ).toBe(401);
    expect(
      (await app.request('/v1/agents', { headers: { authorization: 'Bearer ' + TOKEN } })).status,
    ).toBe(401);
  });

  it('serves the events cursor to the service identity only', async () => {
    const { store, app } = build();
    for (let i = 0; i < 3; i += 1) {
      await store.emit({ type: 'agent.deleted', agentId: 'agent-' + i });
    }
    const cursor = await app.request('/v1/events/cursor', {
      headers: { authorization: 'Bearer ' + TOKEN, 'x-owner-id': 'alice' },
    });
    expect(cursor.status).toBe(200);
    expect(await cursor.json()).toEqual({ after: 0 });
    expect((await app.request('/v1/events/cursor')).status).toBe(401);
    expect(
      (await app.request('/v1/events/cursor', { headers: { authorization: 'Bearer dev-token', 'x-owner-id': 'alice' } }))
        .status,
    ).toBe(401);
  });

  it('keeps the header owner authoritative and isolates owners', async () => {
    const store = createMemoryStore();
    const app = createInternalAgentApp({
      store,
      bus: store.eventBus,
      enqueuer: new NoopEnqueuer(),
      channels: testChannels,
      internalToken: TOKEN,
    });
    const as = (owner: string, path: string, body?: unknown) =>
      app.request(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: 'Bearer ' + TOKEN,
          'x-owner-id': owner,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const created = await as('alice', '/v1/agents', { name: 'Alice agent' });
    expect(created.status).toBe(201);
    const agent = await created.json();
    if (!isRecord(agent) || typeof agent.id !== 'string') throw new Error('agent response is not an object');
    expect(agent.createdBy).toBe('alice');
    expect(itemsOf(await (await as('alice', '/v1/agents')).json())).toHaveLength(1);
    expect(itemsOf(await (await as('bob', '/v1/agents')).json())).toHaveLength(0);
    expect((await as('bob', '/v1/agents/' + agent.id)).status).toBe(404);
  });

  it('serves no account surface', async () => {
    const { app } = build();
    expect((await app.request('/auth/info')).status).toBe(404);
    expect((await app.request('/auth/sign-in/email', { method: 'POST' })).status).toBe(404);
  });
});

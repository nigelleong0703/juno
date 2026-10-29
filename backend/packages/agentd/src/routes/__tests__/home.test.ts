/** BACKEND §5.5: the app's view of /juno (mirror reads, user-writable paths, new-agent seeding, one-time migration). */
import { beforeEach, describe, expect, it } from 'vitest';
import { type Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import type { Agent } from '@agent-desktop/public-contracts';
import { migrateHomeFiles } from 'juno-agent/modules/home/migrate';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';

const OWNER = 'owner-home';
const noop = { enqueue: async () => ({ accepted: true }), stopRun: async () => {}, resolveAwakeable: async () => {}, scheduleRoutine: async () => {} };

describe('home files over HTTP', () => {
  let store: Store;
  let app: Hono;
  const call = (path: string, method = 'GET', body?: unknown) => requestAs(app, OWNER, path, { method, body });

  beforeEach(() => {
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    app = createTestApp({ store, bus: mem.eventBus, enqueuer: noop });
  });

  it('writes USER.md to the mirror as pending without a computer, lists it, and detects a stale hash', async () => {
    const put = await call('/v1/home/USER.md', 'PUT', { content: 'I live in Lisbon.' });
    expect(put.status).toBe(200);
    const saved = await put.json() as { hash: string };
    expect(((await (await call('/v1/home?path=USER')).json()) as { files: Array<{ path: string; content: string }> }).files).toMatchObject([{ path: 'USER.md', content: 'I live in Lisbon.' }]);
    expect((await store.get('agentHome', OWNER + ':USER.md'))?.pendingWrite).toBe(true);
    expect((await call('/v1/home/USER.md', 'PUT', { content: 'x', expectedHash: 'stale' })).status).toBe(409);
    expect((await call('/v1/home/USER.md', 'PUT', { content: 'ok', expectedHash: saved.hash })).status).toBe(200);
  });

  it('refuses paths the app may not write, and agent files of agents the caller does not own', async () => {
    expect((await call('/v1/home/docs/memory.md', 'PUT', { content: 'x' })).status).toBe(403);
    expect((await call('/v1/home/memory/2026-10-14/agt-x.md', 'PUT', { content: 'x' })).status).toBe(403);
    expect((await call('/v1/home/..%2Fescape.md', 'PUT', { content: 'x' })).status).toBe(403);
    expect((await call('/v1/home/agents/agt-foreign/SOUL.md', 'PUT', { content: 'x' })).status).toBe(403);
  });

  it('seeds the initial texts of a new agent as pending files, and keeps another owner out', async () => {
    const created = await call('/v1/agents', 'POST', { name: 'Ada', personality: 'Dry.', instructions: 'Do it.', proactivePreferences: 'Rarely.' });
    const agent = await created.json() as Agent;
    expect(agent).not.toHaveProperty('personality');
    const files = ((await (await call('/v1/home?path=agents/' + agent.id)).json()) as { files: Array<{ path: string; content: string }> }).files;
    expect(files.map((file) => file.path).sort()).toEqual(['AGENTS.md', 'IDENTITY.md'].map((name) => `agents/${agent.id}/${name}`));
    expect(files.find((file) => file.path.endsWith('AGENTS.md'))?.content).toBe('Do it.\n\n## When to reach out\nRarely.');
    expect((await call('/v1/home/agents/' + agent.id + '/SOUL.md', 'PUT', { content: 'Brief.' })).status).toBe(200);
    const other = await requestAs(app, 'someone-else', '/v1/home');
    expect(((await other.json()) as { files: unknown[] }).files).toEqual([]);
  });

  it('migrates the old agent texts and aboutMe once, without overwriting', async () => {
    const mem = createMemoryStore();
    await mem.put('agents', { id: 'agt-old', ownerId: OWNER, personality: 'Old persona', instructions: 'Old work', proactivePreferences: 'Never' } as unknown as Agent);
    await mem.put('settings', { id: 'app-settings-' + OWNER, general: { aboutMe: 'Old about me' } } as never);
    expect(await migrateHomeFiles(mem)).toBe(3);
    expect(await migrateHomeFiles(mem)).toBe(0);
    expect((await mem.get('agentHome', OWNER + ':USER.md'))).toMatchObject({ content: 'Old about me', pendingWrite: true, writer: 'user' });
    expect((await mem.get('agentHome', OWNER + ':agents/agt-old/AGENTS.md'))?.content).toBe('Old work\n\n## When to reach out\nNever');
  });
});

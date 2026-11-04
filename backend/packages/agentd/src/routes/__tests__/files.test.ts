/** The owner's file-history routes (BACKEND 5.2d): the kept versions of a path, putting one back, and keeping another owner out. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import type { Agent, FileSnapshot, RestoredFile } from '@agent-desktop/public-contracts';
import type { ComputerClient } from 'juno-agent/computer';
import { keepPreviousVersion } from 'juno-agent/modules/files/history';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';

const OWNER = 'owner-files';
const STRANGER = 'owner-other';
const AT = '2026-11-01T00:00:00.000Z';
const PATH = '/workspace/plan.md';

const agent = (id: string, owner: string): Agent & { ownerId: string } => ({
  id, ownerId: owner, createdBy: owner, name: 'Agent ' + id, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'happy' }, title: 'QA', status: 'idle', section: 'Agents', pinned: false, lastActivity: 'idle', unreadCount: 0,
  model: { planner: { provider: 'fixture', model: 'fixture' }, computer: { provider: 'fixture', model: 'fixture' }, fast: { provider: 'fixture', model: 'fixture' } }, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdAt: AT, updatedAt: AT,
});

describe('file history over HTTP', () => {
  let app: Hono;
  let mem: ReturnType<typeof createMemoryStore>;
  let owned: Store;
  const blobs = createMemoryBlobStore();
  const disk = new Map<string, string>([[PATH, 'current text']]);
  const computer = {
    readFile: async (_agent: string, path: string) => ({ content: disk.get(path) ?? '', bytes: Buffer.byteLength(disk.get(path) ?? '') }),
    writeFile: async (_agent: string, input: { path: string; content: string }) => { disk.set(input.path, input.content); return { path: input.path, bytes: Buffer.byteLength(input.content) }; },
  } as unknown as ComputerClient;
  const call = (path: string, method = 'GET', body?: unknown, who = OWNER) => requestAs(app, who, path, { method, body });
  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;
  const keep = (store: Store, agentId: string, text: string, step: string) => keepPreviousVersion({ store, blobs }, { agentId, stepId: step, runId: 'run-1' }, { path: PATH, on: 'sandbox' }, 'files.write', text);

  beforeEach(async () => {
    mem = createMemoryStore();
    const store = withDefaultOwner(mem, OWNER);
    owned = store.forOwner?.(OWNER) ?? store;
    disk.set(PATH, 'current text');
    app = createTestApp({ store, bus: mem.eventBus, blobs, computer, enqueuer: { enqueue: async () => ({ accepted: true }), stopRun: async () => {}, resolveAwakeable: async () => {}, scheduleRoutine: async () => {} } });
    await store.put('agents', agent('agt-1', OWNER));
    const theirs = store.forOwner?.(STRANGER) ?? store;
    await theirs.put('agents', agent('agt-9', STRANGER));
  });

  it('lists the kept versions of a path newest first, without bytes or internal keys', async () => {
    await keep(owned, 'agt-1', 'first text', 's1');
    await keep(owned, 'agt-1', 'second text', 's2');
    const response = await call(`/v1/files/history?path=${encodeURIComponent(PATH)}&agentId=agt-1`);
    expect(response.status).toBe(200);
    const { items } = await json<{ items: FileSnapshot[] }>(response);
    expect(items.map((item) => item.sizeBytes)).toEqual([11, 10]);
    expect(JSON.stringify(items)).not.toMatch(/blobKey|parentId|first text/);
    expect((await call(`/v1/files/history?path=${encodeURIComponent(PATH)}`)).status).toBe(400);
  });

  it('restores a version, keeps what it replaced, and the restore can be undone', async () => {
    await keep(owned, 'agt-1', 'earlier text', 's1');
    const [snapshot] = (await json<{ items: FileSnapshot[] }>(await call(`/v1/files/history?path=${encodeURIComponent(PATH)}&agentId=agt-1`))).items;
    const restored = await call('/v1/files/restore', 'POST', { snapshotId: snapshot?.id });
    expect(restored.status).toBe(200);
    const body = await json<RestoredFile>(restored);
    expect(disk.get(PATH)).toBe('earlier text');
    expect(body).toMatchObject({ path: PATH, on: 'sandbox', bytes: 12, restored: { id: snapshot?.id }, undo: { tool: 'files.restore' } });
    expect((await call('/v1/files/restore', 'POST', { snapshotId: body.undo?.id })).status).toBe(200);
    expect(disk.get(PATH)).toBe('current text');
  });

  it('keeps another owner out: their agent has no history here and their snapshot cannot be restored', async () => {
    const theirs = mem.forOwner?.(STRANGER) ?? mem;
    await keep(theirs, 'agt-9', 'their text', 's9');
    expect((await call(`/v1/files/history?path=${encodeURIComponent(PATH)}&agentId=agt-9`)).status).toBe(404);
    const [snapshot] = (await json<{ items: FileSnapshot[] }>(await call(`/v1/files/history?path=${encodeURIComponent(PATH)}&agentId=agt-9`, 'GET', undefined, STRANGER))).items;
    expect((await call('/v1/files/restore', 'POST', { snapshotId: snapshot?.id })).status).toBe(404);
    expect(disk.get(PATH)).toBe('current text');
    expect((await call('/v1/files/restore', 'POST', { snapshotId: 'fsn_missing' })).status).toBe(404);
    expect((await call('/v1/files/restore', 'POST', {})).status).toBe(400);
  });

  it('says so when there is no computer to write on', async () => {
    const store = withDefaultOwner(mem, OWNER);
    const bare = createTestApp({ store, bus: mem.eventBus, blobs, enqueuer: { enqueue: async () => ({ accepted: true }), stopRun: async () => {}, resolveAwakeable: async () => {}, scheduleRoutine: async () => {} } });
    await keep(owned, 'agt-1', 'earlier text', 's1');
    const [snapshot] = (await json<{ items: FileSnapshot[] }>(await call(`/v1/files/history?path=${encodeURIComponent(PATH)}&agentId=agt-1`))).items;
    expect((await requestAs(bare, OWNER, '/v1/files/restore', { method: 'POST', body: { snapshotId: snapshot?.id } })).status).toBe(503);
  });
});

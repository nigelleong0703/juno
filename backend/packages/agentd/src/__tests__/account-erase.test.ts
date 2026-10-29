/**
 * Deleting an account (BACKEND §5.2c) on a real Postgres database (embedded) with two accounts: everything of the named account
 * goes, in the documented order, with the delete events; nothing of the other account does; a crash midway is finished by the next boot.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BlobStore, Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { createMemoryBlobStore, createStore, deleteOwnerRows, type DbStore } from '@agent-desktop/db';
import { startScratchPostgres, type ScratchPostgres } from '@agent-desktop/db/testing/scratch-postgres';
import { createAccountEraser, collectBlobKeys, type AccountEraser } from '../account/erase.js';
import type { ComputerdClient, OwnerErasure } from '../computerd.js';
import { currentOwnerId } from '../owner-scope.js';
import { createTestApp, ownerHeaders, testChannels } from './test-app.js';

const AT = '2026-10-22T00:00:00.000Z';
const A = 'owner-a';
const B = 'owner-b';
const KEY = (letter: string) => 'blobs/' + letter.repeat(64);
const usage = { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 };

/** No workflow behind any run, so stopping one finalizes its row inline. */
class OrphanEnqueuer implements Enqueuer {
  async enqueue(event: WakeEvent): Promise<{ accepted: boolean }> {
    void event;
    return { accepted: true };
  }
  async stopRun(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async runState(): Promise<'none'> {
    return 'none';
  }
}

let cluster: ScratchPostgres;
const stores: DbStore[] = [];
beforeAll(async () => {
  cluster = await startScratchPostgres();
}, 240_000);
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
});
afterAll(async () => {
  await cluster?.close();
});

function scoped(store: DbStore, owner: string): Store {
  if (store.forOwner === undefined || store.raw === undefined) throw new Error('the store has owner scopes and raw SQL');
  return store.forOwner(owner);
}

/** One account with two agents, a direct chat each, a group chat, uploads, an artifact file, a transcript image, a channel row and a sign-in. */
async function seed(store: DbStore, owner: string, blobs: BlobStore, keys: { own: string; shared: string }): Promise<void> {
  const rows = scoped(store, owner);
  const tag = owner.slice(-1);
  for (const agent of ['1', '2']) {
    await rows.put('agents', { id: `agt-${tag}${agent}`, name: `Agent ${agent}`, handle: agent, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Inbox', pinned: false, lastActivity: '', unreadCount: 0, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdBy: owner, createdAt: AT, updatedAt: AT } as never);
    await rows.put('conversations', { id: `conv-${tag}${agent}`, kind: 'direct', agentIds: [`agt-${tag}${agent}`], memberIds: [owner], unreadCount: 0, lastItemAt: AT, createdAt: AT });
    await rows.put('items', { id: `itm-${tag}${agent}`, conversationId: `conv-${tag}${agent}`, type: 'user_message', authorId: owner, text: 'private words', attachments: [], mentions: [], at: AT }, { conversationId: `conv-${tag}${agent}` });
    await rows.put('runs', { id: `run-${tag}${agent}`, agentId: `agt-${tag}${agent}`, conversationId: `conv-${tag}${agent}`, title: 't', status: 'completed', kind: 'chat', steps: [], usage, startedAt: AT, lastActivityAt: AT }, { agentId: `agt-${tag}${agent}`, conversationId: `conv-${tag}${agent}`, status: 'completed' });
    await rows.put('goals', { id: `goal-${tag}${agent}`, agentId: `agt-${tag}${agent}`, title: 'g' } as never);
  }
  await rows.put('conversations', { id: `group-${tag}`, kind: 'room', agentIds: [`agt-${tag}1`, `agt-${tag}2`], memberIds: [owner], unreadCount: 0, lastItemAt: AT, createdAt: AT });
  await rows.put('library', { id: `lib-${tag}`, blobKey: keys.own } as never);
  await rows.put('library', { id: `lib-${tag}-2`, blobKey: keys.shared } as never);
  await rows.put('artifactFiles', { id: `af-${tag}`, artifactId: 'x', version: 1, part: 'file', name: 'n', mimeType: 'text/plain', sizeBytes: 1, sha256: 's', blobKey: KEY(tag), createdAt: AT });
  await rows.put('transcripts', { id: `tx-${tag}`, sessionKey: `agt-${tag}1:conv-${tag}1`, seq: 0, compactionEpoch: 0, at: AT, message: { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: '', blobKey: KEY(tag === 'a' ? 'c' : 'd') }] } });
  await rows.put('channels', { id: `unknown:${tag}`, ownerId: owner, agentId: `agt-${tag}1`, kind: 'unknown', channelId: tag, secretHashHex: 'h', createdAt: AT, updatedAt: AT });
  await rows.put('settings', { id: `settings-${tag}` } as never);
  for (const key of [keys.own, keys.shared, KEY(tag), KEY(tag === 'a' ? 'c' : 'd')]) await blobs.put(key, Buffer.from(key), 'text/plain');
  const db = store.raw;
  if (db === undefined) throw new Error('raw SQL');
  await db.query('INSERT INTO auth_user (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)', [owner, owner, `${owner}@example.com`, 0, AT, AT]);
  await db.query('INSERT INTO auth_session (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, ?, ?)', [`s-${owner}`, AT, `t-${owner}`, AT, AT, owner]);
  await db.query('INSERT INTO auth_account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)', [`a-${owner}`, owner, 'credential', owner, 'hash', AT, AT]);
  await rows.emit({ type: 'goal.deleted', goalId: `old-${tag}` });
}

async function fixture(options: { computerd?: ComputerdClient['eraseOwner']; retryMs?: number; stopRuns?: boolean } = {}) {
  const store = await createStore(await cluster.newDatabase());
  stores.push(store);
  const db = store.raw;
  if (db === undefined) throw new Error('raw SQL');
  const blobs = createMemoryBlobStore();
  await seed(store, A, blobs, { own: KEY('1'), shared: KEY('2') });
  await seed(store, B, blobs, { own: KEY('3'), shared: KEY('2') });
  const erasedOwners: Array<string | undefined> = [];
  const forgotten: Array<{ exact: readonly string[]; prefixes: readonly string[] }> = [];
  const computerd: ComputerdClient = {
    eraseOwner: options.computerd ?? (async (): Promise<OwnerErasure> => { erasedOwners.push(currentOwnerId()); return { computers: 1, removed: ['volume v'], files: [], macRevoked: false }; }),
  } as ComputerdClient;
  const runner = { forget: async (keys: { exact: readonly string[]; prefixes: readonly string[] }) => { forgotten.push(keys); return 3; } };
  const make = (retryMs = options.retryMs ?? 5): AccountEraser => createAccountEraser({
    store, raw: db, bus: store.eventBus, enqueuer: new OrphanEnqueuer(), computerd, blobs, channels: testChannels,
    runner: runner as never, retryDelayMs: () => retryMs,
  });
  return { store, blobs, computerd, erasedOwners, forgotten, make, db };
}

const blobsLeft = async (blobs: BlobStore, keys: string[]) => (await Promise.all(keys.map(async (key) => ((await blobs.get(key)) === null ? null : key)))).filter((key) => key !== null);

describe('account deletion', () => {
  it('removes everything of one account in order and nothing of the other', async () => {
    const f = await fixture();
    const eraser = f.make();
    expect(await eraser.erase(A, 20_000)).toBe('deleted');

    // Nothing of A is left in any collection (the marker is gone too), and the sign-in is gone.
    expect(await deleteOwnerRows(f.db, A)).toEqual({});
    expect(await f.db.query('SELECT id FROM auth_user')).toEqual([{ id: B }]);
    expect(await f.db.query('SELECT id FROM auth_session')).toEqual([{ id: `s-${B}` }]);
    expect(await f.db.query('SELECT id FROM auth_account')).toEqual([{ id: `a-${B}` }]);
    // B is untouched, row for row.
    const b = scoped(f.store, B);
    expect((await b.list('agents')).items.map((row) => row.id).sort()).toEqual(['agt-b1', 'agt-b2']);
    expect((await b.list('conversations')).items).toHaveLength(3);
    expect((await b.list('items')).items).toHaveLength(2);
    expect((await b.list('library')).items).toHaveLength(2);
    expect((await b.list('channels')).items).toHaveLength(1);
    expect(await b.get('accountDeletions', B)).toBeNull();

    // Blobs: A's own bytes go, bytes B still names (the shared upload and B's own) stay.
    expect(await blobsLeft(f.blobs, [KEY('1'), KEY('2'), KEY('3'), KEY('a'), KEY('b'), KEY('c'), KEY('d')])).toEqual([KEY('2'), KEY('3'), KEY('b'), KEY('d')]);

    // The delete events every open device needs; A's other events are gone, B's are all still there.
    const kept = await f.db.query<{ owner_id: string; type: string }>('SELECT owner_id, type FROM events ORDER BY id');
    const typesOf = (owner: string) => kept.filter((row) => row.owner_id === owner).map((row) => row.type);
    expect(typesOf(A).sort()).toEqual(['agent.deleted', 'agent.deleted', 'conversation.deleted', 'conversation.deleted', 'conversation.deleted']);
    expect(typesOf(B)).toEqual(['goal.deleted']);

    // The computer was erased once, in A's scope; the durable runner forgot A's sessions and runs, never B's.
    expect(f.erasedOwners).toEqual([A]);
    expect(f.forgotten).toHaveLength(2);
    expect([...(f.forgotten[0]?.prefixes ?? [])].sort()).toEqual(['agt-a1:', 'agt-a2:']);
    expect(f.forgotten[0]?.exact).toEqual(expect.arrayContaining([A, 'run-a1', 'run-a2']));
    for (const keys of f.forgotten) expect([...keys.exact, ...keys.prefixes].some((key) => key.includes('b'))).toBe(false);
  });

  it('answers "deleting" while a step cannot finish, and a restart finishes it from the marker', async () => {
    let down = true;
    const f = await fixture({ computerd: async () => { if (down) throw new Error('computerd is down'); return { computers: 1, removed: [], files: [], macRevoked: false }; }, retryMs: 60_000 });
    const first = f.make();
    expect(await first.erase(A, 300)).toBe('deleting');
    first.stop();

    // The sign-in is already closed, the data before the computer step is gone, the rest waits in the marker.
    expect(await f.db.query('SELECT id FROM auth_session WHERE "userId" = ?', [A])).toEqual([]);
    const marker = await scoped(f.store, A).get('accountDeletions', A);
    expect(marker?.done).toEqual(['stop', 'forget', 'blobs', 'agents', 'conversations']);
    expect(marker?.attempts).toBeGreaterThanOrEqual(1);
    expect(marker?.lastError).toContain('computerd is down');
    expect((await scoped(f.store, A).list('agents')).items).toHaveLength(0);
    expect((await scoped(f.store, A).list('settings')).items).toHaveLength(1);
    expect(await f.db.query('SELECT id FROM auth_user WHERE id = ?', [A])).toHaveLength(1);

    // "Reboot": a new eraser reads the marker table and finishes; B is not part of it.
    down = false;
    const second = f.make();
    expect(await second.resume()).toBe(1);
    for (let waited = 0; waited < 200 && (await scoped(f.store, A).get('accountDeletions', A)) !== null; waited += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await deleteOwnerRows(f.db, A)).toEqual({});
    expect(await f.db.query('SELECT id FROM auth_user')).toEqual([{ id: B }]);
    expect((await scoped(f.store, B).list('settings')).items).toHaveLength(1);
    expect(await second.resume()).toBe(0);
  });

  it('is repeatable: deleting an already deleted account removes nothing else', async () => {
    const f = await fixture();
    const eraser = f.make();
    expect(await eraser.erase(A, 20_000)).toBe('deleted');
    expect(await eraser.erase(A, 20_000)).toBe('deleted');
    expect((await scoped(f.store, B).list('agents')).items).toHaveLength(2);
    expect(f.erasedOwners).toEqual([A, A]);
  });

  it('refuses a missing owner id before touching anything', async () => {
    const f = await fixture();
    await expect(f.make().erase('  ')).rejects.toThrow('an owner id');
    expect((await scoped(f.store, A).list('agents')).items).toHaveLength(2);
    expect((await scoped(f.store, B).list('agents')).items).toHaveLength(2);
  });
});

describe('DELETE /v1/account', () => {
  it('needs the confirmation, takes the owner from the service identity only, and answers 200 when done', async () => {
    const f = await fixture();
    const app = createTestApp({ store: f.store, bus: f.store.eventBus, enqueuer: new OrphanEnqueuer(), accountEraser: f.make() });
    const call = (owner: string, body: unknown) => app.request('/v1/account', { method: 'DELETE', headers: ownerHeaders(owner, true), body: JSON.stringify(body) });

    expect((await call(A, {})).status).toBe(400);
    expect((await call(A, { confirm: 'yes' })).status).toBe(400);
    expect((await app.request('/v1/account', { method: 'DELETE', headers: { 'x-owner-id': A } })).status).toBe(401);
    expect((await scoped(f.store, A).list('agents')).items).toHaveLength(2);
    expect(await scoped(f.store, A).get('accountDeletions', A)).toBeNull();

    // A body that names another owner changes nothing: the identity is the header.
    const response = await call(A, { confirm: true, ownerId: B });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect((await scoped(f.store, A).list('agents')).items).toHaveLength(0);
    expect((await scoped(f.store, B).list('agents')).items).toHaveLength(2);
  });

  it('answers 202 while the job is still running', async () => {
    const f = await fixture({ computerd: async () => { await new Promise((resolve) => setTimeout(resolve, 400)); return { computers: 0, removed: [], files: [], macRevoked: false }; } });
    const eraser = f.make();
    const app = createTestApp({ store: f.store, bus: f.store.eventBus, enqueuer: new OrphanEnqueuer(), accountEraser: { ...eraser, erase: (owner) => eraser.erase(owner, 50) } });
    const response = await app.request('/v1/account', { method: 'DELETE', headers: ownerHeaders(A, true), body: JSON.stringify({ confirm: true }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ deleting: true });
    for (let waited = 0; waited < 200 && (await scoped(f.store, A).get('accountDeletions', A)) !== null; waited += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await deleteOwnerRows(f.db, A)).toEqual({});
  });
});

describe('blob keys of a stored document', () => {
  it('finds a blobKey at any depth, and only blobs/ keys', () => {
    const found = new Set<string>();
    collectBlobKeys({ blobKey: KEY('a'), message: { content: [{ type: 'image', blobKey: KEY('b') }, { text: 'blobKey', other: { blobKey: 'elsewhere/x' } }] }, versions: [{ nested: [[{ blobKey: KEY('c') }]] }] }, found);
    expect([...found].sort()).toEqual([KEY('a'), KEY('b'), KEY('c')]);
  });
});

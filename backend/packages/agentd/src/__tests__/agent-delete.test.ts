/**
 * Deleting one agent (BACKEND §5.2c) on a real Postgres database (embedded): one account, two agents with one of every kind of row
 * (runs outside any chat, app toggles, tool-output artifacts, a published artifact with its file, drafts, a Space with its share link,
 * audit, transcripts). Deleting A leaves nothing of A, B untouched, A's bytes gone except the one B's artifact also names.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BlobStore, Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { createMemoryBlobStore, createStore, type DbStore } from '@agent-desktop/db';
import { startScratchPostgres, type ScratchPostgres } from '@agent-desktop/db/testing/scratch-postgres';
import { deleteAgentCascade } from '../routes/agents.js';
import type { AgentdDeps } from '../routes/index.js';
import { testChannels } from './test-app.js';

const AT = '2026-11-02T00:00:00.000Z';
const OWNER = 'owner-agent-delete';
const KEY = (letter: string) => 'blobs/' + letter.repeat(64);
const usage = { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 };

class IdleEnqueuer implements Enqueuer {
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

/** One of every row of agent `id`; `own` is a blob only this agent names, `shared` one both agents name. */
async function seed(rows: Store, id: string, own: string, shared: string): Promise<void> {
  await rows.put('agents', { id, name: id, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Inbox', pinned: false, lastActivity: '', unreadCount: 0, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdBy: OWNER, createdAt: AT, updatedAt: AT } as never);
  // A run in no chat at all (a background / routine run), with a step and the session transcript it wrote, which names an image.
  await rows.put('runs', { id: `run-${id}`, agentId: id, title: 't', status: 'completed', kind: 'background', steps: [], usage, startedAt: AT, lastActivityAt: AT } as never, { agentId: id, status: 'completed' });
  await rows.put('steps', { id: `step-${id}`, runId: `run-${id}` } as never, { runId: `run-${id}` });
  await rows.put('transcripts', { id: `tx-${id}`, sessionKey: `${id}:bg-1`, seq: 0, compactionEpoch: 0, at: AT, message: { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: '', blobKey: KEY(id.slice(-1) === 'a' ? 'c' : 'd') }] } });
  await rows.put('agentApps', { id: `app-${id}`, ownerId: OWNER, agentId: id, appId: 'gmail', enabled: true, actionsPolicy: 'ask', updatedAt: AT } as never);
  await rows.put('artifacts', { id: `out-${id}`, ownerId: OWNER, agentId: id, runId: `run-${id}`, stepId: 's', tool: 't', text: 'x', chars: 1, bytes: 1, originalChars: 1, sha256: 's', truncated: false, createdAt: AT, expiresAt: AT } as never);
  await rows.put('audit', { id: `audit-${id}`, at: AT, actor: 'agent', agentId: id, action: 'a', decision: 'approved', reason: 'r', initiator: { type: 'system' }, unattended: true } as never);
  // A published artifact (library row, version file, bytes) and a Space with its (revoked) share link.
  await rows.put('library', { id: `lib-${id}`, name: 'report.html', kind: 'file', mimeType: 'text/html', sizeBytes: 1, createdByAgentId: id, shared: 'private', source: 'agent', render: 'html', version: 1, versions: [{ version: 1, fileRef: `af-${id}`, previewRef: `af2-${id}`, sizeBytes: 1, mimeType: 'text/html', createdAt: AT }], tags: [], createdAt: AT, updatedAt: AT } as never);
  await rows.put('artifactFiles', { id: `af-${id}`, artifactId: `lib-${id}`, version: 1, part: 'file', name: 'report.html', mimeType: 'text/html', sizeBytes: 1, sha256: 's', blobKey: own, createdAt: AT });
  await rows.put('artifactFiles', { id: `af2-${id}`, artifactId: `lib-${id}`, version: 2, part: 'preview', name: 'p.pdf', mimeType: 'application/pdf', sizeBytes: 1, sha256: 's', blobKey: shared, createdAt: AT });
  await rows.put('library', { id: `lib2-${id}`, name: 'other.pdf', kind: 'file', mimeType: 'application/pdf', sizeBytes: 1, createdByAgentId: id, shared: 'private', source: 'agent', blobKey: shared, tags: [], createdAt: AT, updatedAt: AT } as never);
  await rows.put('spaces', { id: `space-${id}`, ownerId: OWNER, agentId: id, slug: id, title: 't', port: 3000, status: 'published', createdAt: AT, updatedAt: AT }, { agentId: id, status: 'published' });
  await rows.put('spaceHosted', { id: `space-${id}`, ownerId: OWNER, agentId: id, linkId: 'l', url: 'https://x', visibility: 'link', visitorWrites: false, version: 1, publishedAt: AT, updatedAt: AT, revokedAt: AT }, { agentId: id, status: 'revoked', parentId: `space-${id}` });
  await rows.put('documentDrafts', { id: `draft-${id}`, agentId: id, parentId: `person-doc`, blobKey: own } as never, { parentId: 'person-doc' });
}

const COLLECTIONS = ['runs', 'steps', 'transcripts', 'agentApps', 'artifacts', 'audit', 'library', 'artifactFiles', 'spaces', 'spaceHosted', 'documentDrafts'] as const;

/** How many rows of each collection name the agent (every row `seed` makes carries the agent id in its id or body). */
async function countsOf(rows: Store, agentId: string): Promise<Record<string, number>> {
  return Object.fromEntries(await Promise.all(COLLECTIONS.map(async (name) => [name, (await rows.list(name, { limit: 200 })).items.filter((row) => JSON.stringify(row).includes(agentId)).length] as const)));
}

describe('deleting an agent', () => {
  it('removes every row and byte of the agent and nothing of the other agent', async () => {
    const store = await createStore(await cluster.newDatabase());
    stores.push(store);
    if (store.forOwner === undefined || store.raw === undefined) throw new Error('the store has owner scopes and raw SQL');
    const rows = store.forOwner(OWNER);
    const blobs: BlobStore = createMemoryBlobStore();
    // `a` and `b` each name KEY('1') / KEY('2') alone and KEY('s') together; each transcript names its own image.
    await seed(rows, 'agt-a', KEY('1'), KEY('s'));
    await seed(rows, 'agt-b', KEY('2'), KEY('s'));
    for (const key of [KEY('1'), KEY('2'), KEY('s'), KEY('c'), KEY('d')]) await blobs.put(key, Buffer.from(key), 'text/plain');
    const before = await countsOf(rows, 'agt-b');
    const deps: AgentdDeps = { store: rows, bus: store.eventBus, enqueuer: new IdleEnqueuer(), channels: testChannels, blobs, raw: store.raw };

    expect(await deleteAgentCascade(deps, OWNER, 'agt-a')).toEqual({ ok: true });

    // Nothing of A is left in any of the collections, and the agent row is gone.
    expect(await rows.get('agents', 'agt-a')).toBeNull();
    expect(Object.values(await countsOf(rows, 'agt-a')).every((count) => count === 0)).toBe(true);
    // B is untouched: its agent and every one of its rows.
    expect(await rows.get('agents', 'agt-b')).not.toBeNull();
    expect(await countsOf(rows, 'agt-b')).toEqual(before);
    expect(Object.values(before).every((count) => count > 0)).toBe(true);
    // Bytes: A's own file and image are gone; the one B also names stays, and so does everything of B.
    const left = (await Promise.all([KEY('1'), KEY('2'), KEY('s'), KEY('c'), KEY('d')].map(async (key) => ((await blobs.get(key)) === null ? null : key)))).filter((key) => key !== null);
    expect(left).toEqual([KEY('2'), KEY('s'), KEY('d')]);
    // The agent.deleted event came last.
    const events = (await store.eventBus.since(0)).map((stored) => stored.event.type);
    expect(events.at(-1)).toBe('agent.deleted');
  });

  it('announces every goal, idea, feed post and chat it removes, once each, and none of the other agent', async () => {
    const store = await createStore(await cluster.newDatabase());
    stores.push(store);
    if (store.forOwner === undefined || store.eventBus.forOwner === undefined) throw new Error('the store has owner scopes');
    const rows = store.forOwner(OWNER);
    for (const id of ['agt-a', 'agt-b']) {
      await seed(rows, id, KEY('1'), KEY('s'));
      await rows.put('goals', { id: `goal-${id}`, agentId: id, kind: 'goal', title: 't', summary: '', status: 'active', createdAt: AT, updatedAt: AT } as never);
      await rows.put('ideas', { id: `idea-${id}`, agentId: id, text: 't', prompt: 'p', status: 'open', createdAt: AT, updatedAt: AT } as never);
      await rows.put('feedPosts', { id: `post-${id}`, agentId: id, title: 't', summary: 's', createdAt: AT } as never);
      await rows.put('conversations', { id: `chat-${id}`, kind: 'direct', agentIds: [id], createdAt: AT } as never);
      await rows.put('items', { id: `item-${id}`, conversationId: `chat-${id}`, type: 'user_message', text: 'hi', at: AT } as never, { conversationId: `chat-${id}` });
    }
    const blobs: BlobStore = createMemoryBlobStore();
    const deps: AgentdDeps = { store: rows, bus: store.eventBus, enqueuer: new IdleEnqueuer(), channels: testChannels, blobs, raw: store.raw };

    expect(await deleteAgentCascade(deps, OWNER, 'agt-a')).toEqual({ ok: true });

    // The owner's own event stream (what a phone replays) carries the deletions; a deleted chat is announced once as a whole, not item by item.
    const stream = (await store.eventBus.forOwner(OWNER).since(0)).map((stored) => stored.event);
    const deletions = stream.filter((event) => event.type.endsWith('.deleted'));
    expect(deletions).toEqual(expect.arrayContaining([
      { type: 'goal.deleted', goalId: 'goal-agt-a' },
      { type: 'idea.deleted', ideaId: 'idea-agt-a' },
      { type: 'feed.deleted', postId: 'post-agt-a' },
      { type: 'conversation.deleted', conversationId: 'chat-agt-a' },
    ]));
    expect(deletions.map((event) => event.type).sort()).toEqual(['agent.deleted', 'conversation.deleted', 'feed.deleted', 'goal.deleted', 'idea.deleted']);
    expect(JSON.stringify(deletions)).not.toContain('agt-b');
    expect(await rows.get('goals', 'goal-agt-b')).not.toBeNull();
    expect(await rows.get('feedPosts', 'post-agt-b')).not.toBeNull();
  });
});

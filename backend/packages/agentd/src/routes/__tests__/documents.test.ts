/** The owner's document routes: review (approve/decline) with the agent told once, the owner's own saves, isolation, and the document chat. */
import { beforeEach, describe, expect, it } from 'vitest';
import { type Hono } from 'hono';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import type { Store, WakeEvent } from '@agent-desktop/contracts';
import type { Agent, DocumentDraft } from '@agent-desktop/public-contracts';
import { createDocument, proposeDraft } from 'juno-agent/modules/documents/documents';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';

const OWNER = 'owner-docs';
const AT = '2026-10-29T00:00:00.000Z';

function agent(id: string, owner: string): Agent & { ownerId: string } {
  return { id, ownerId: owner, createdBy: owner, name: 'Agent ' + id, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'happy' }, title: 'QA', status: 'idle', section: 'Agents', pinned: false, lastActivity: 'idle', unreadCount: 0, model: { planner: { provider: 'fixture', model: 'fixture' }, computer: { provider: 'fixture', model: 'fixture' }, fast: { provider: 'fixture', model: 'fixture' } }, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdAt: AT, updatedAt: AT };
}

describe('documents over HTTP', () => {
  let store: Store;
  let app: Hono;
  let wakes: WakeEvent[];
  let mem: ReturnType<typeof createMemoryStore>;
  const blobs = createMemoryBlobStore();
  const call = (path: string, method = 'GET', body?: unknown, who = OWNER) => requestAs(app, who, path, { method, body });
  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

  /** A document the agent made and the owner approved (v1), plus an open agent proposal. */
  async function withProposal(): Promise<{ id: string; draft: DocumentDraft }> {
    const scoped = store.forOwner?.(OWNER) ?? store;
    const made = await createDocument({ store: scoped, blobs }, OWNER, { title: 'Plan', markdown: 'v1 text', author: { agentId: 'agt-1' }, conversationId: 'cvn-1', runId: 'run-1', idempotencyKey: 'run-1:s:a' });
    expect((await call(`/v1/documents/${made.document.id}/draft/approve`, 'POST', { draftId: made.draft.id, expectedRevision: 1 })).status).toBe(200);
    const proposal = await proposeDraft({ store: scoped, blobs }, OWNER, { documentId: made.document.id, baseVersion: 1, markdown: 'v2 text', summary: 'more', agentId: 'agt-1', conversationId: 'cvn-1', runId: 'run-2', idempotencyKey: 'run-2:s:b' });
    return { id: made.document.id, draft: proposal.draft };
  }

  beforeEach(async () => {
    mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    wakes = [];
    app = createTestApp({ store, bus: mem.eventBus, blobs, enqueuer: { enqueue: async (event: WakeEvent) => { wakes.push(event); return { accepted: true }; }, stopRun: async () => {}, resolveAwakeable: async () => {}, scheduleRoutine: async () => {} } });
    await store.put('agents', agent('agt-1', OWNER));
    await store.put('conversations', { id: 'cvn-1', kind: 'direct', agentIds: ['agt-1'], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT });
  });

  it('approve saves the next version once and wakes the proposing agent once, however often it is repeated', async () => {
    const { id, draft } = await withProposal();
    wakes.length = 0;
    const input = { draftId: draft.id, expectedRevision: 1 };
    const first = await json<{ draft: DocumentDraft; document: { version: number } }>(await call(`/v1/documents/${id}/draft/approve`, 'POST', input));
    const second = await json<{ draft: DocumentDraft }>(await call(`/v1/documents/${id}/draft/approve`, 'POST', input));
    expect(first.draft.savedVersion).toBe(2);
    expect(second.draft.savedVersion).toBe(2);
    expect(first.document.version).toBe(2);
    // Both calls offer the same wake (same id): the enqueuer dedupes, the retry only re-attempts a failed delivery.
    expect(new Set(wakes.map((wake) => wake.id)).size).toBe(1);
    expect(wakes[0]).toMatchObject({ kind: 'request_resolved', agentId: 'agt-1', conversationId: 'cvn-1' });
    expect(String(wakes[0]?.payload['text'])).toContain('version 2');
    expect(await json(await call(`/v1/documents/${id}/versions/2/content`))).toMatchObject({ markdown: 'v2 text' });
    expect(await json(await call(`/v1/documents/${id}/versions/1/content`))).toMatchObject({ markdown: 'v1 text' });
  });

  it('a stale revision is a 409 and nothing is written; decline tells the agent and keeps the document', async () => {
    const { id, draft } = await withProposal();
    wakes.length = 0;
    expect((await call(`/v1/documents/${id}/draft/approve`, 'POST', { draftId: draft.id, expectedRevision: 7 })).status).toBe(409);
    expect(wakes).toHaveLength(0);
    const declined = await call(`/v1/documents/${id}/draft/decline`, 'POST', { draftId: draft.id, expectedRevision: 1 });
    expect(declined.status).toBe(200);
    expect(String(wakes[0]?.payload['text'])).toContain('declined');
    expect((await json<{ document: { version: number }; draft?: unknown }>(await call(`/v1/documents/${id}`))).document.version).toBe(1);
    expect((await call(`/v1/documents/${id}/draft`)).status).toBe(404);
  });

  it('the owner\'s own edit: PUT is 409 when stale, a saved edit of an agent proposal is approved with the agent told about the edits', async () => {
    const { id, draft } = await withProposal();
    wakes.length = 0;
    expect((await call(`/v1/documents/${id}/draft`, 'PUT', { title: 'Plan', markdown: 'x', expectedRevision: 9 })).status).toBe(409);
    const saved = await json<{ draft: DocumentDraft; markdown: string }>(await call(`/v1/documents/${id}/draft`, 'PUT', { title: 'Plan', markdown: 'owner edit', expectedRevision: 1 }));
    expect(saved.draft).toMatchObject({ author: 'person', revision: 2 });
    expect((await call(`/v1/documents/${id}/draft/approve`, 'POST', { draftId: draft.id, expectedRevision: 1 })).status).toBe(409);
    const done = await call(`/v1/documents/${id}/draft/approve`, 'POST', { draftId: draft.id, expectedRevision: 2 });
    expect(done.status).toBe(200);
    expect(String(wakes[0]?.payload['text'])).toContain('own edits');
  });

  it('the owner starts a document, saves it, and a person draft wakes nobody', async () => {
    const made = await json<{ document: { id: string }; draft: DocumentDraft }>(await call('/v1/documents', 'POST', { title: 'Notes', markdown: 'hello' }));
    expect((await call(`/v1/documents/${made.document.id}/draft/approve`, 'POST', { draftId: made.draft.id, expectedRevision: 1 })).status).toBe(200);
    expect(wakes).toHaveLength(0);
    const saved = await json<{ draft: DocumentDraft }>(await call(`/v1/documents/${made.document.id}/draft`, 'PUT', { title: 'Notes', markdown: 'hello again', baseVersion: 1 }));
    expect(saved.draft.baseVersion).toBe(1);
    // With a draft open the revision is what counts (400 without it); once it is discarded, the base version is.
    expect((await call(`/v1/documents/${made.document.id}/draft`, 'PUT', { title: 'Notes', markdown: 'x', baseVersion: 1 })).status).toBe(400);
    expect((await call(`/v1/documents/${made.document.id}/draft/decline`, 'POST', { draftId: saved.draft.id, expectedRevision: 1 })).status).toBe(200);
    expect(wakes).toHaveLength(0);
    expect((await call(`/v1/documents/${made.document.id}/draft`, 'PUT', { title: 'Notes', markdown: 'x', baseVersion: 0 })).status).toBe(409);
  });

  it('another owner sees 404 on every document route; approving a document with an external target answers 501 and keeps the draft', async () => {
    const { id, draft } = await withProposal();
    for (const [method, path, body] of [['GET', `/v1/documents/${id}`], ['GET', `/v1/documents/${id}/draft`], ['GET', `/v1/documents/${id}/versions/1/content`], ['PUT', `/v1/documents/${id}/draft`, { title: 't', markdown: 'x', expectedRevision: 1 }], ['POST', `/v1/documents/${id}/draft/approve`, { draftId: draft.id, expectedRevision: 1 }], ['POST', `/v1/documents/${id}/conversations`, { agentId: 'agt-1' }]] as const) {
      expect((await call(path, method, body, 'owner-else')).status).toBe(404);
    }
    const row = await store.get('library', id);
    await store.put('library', { ...row!, target: { appId: 'google-docs', externalId: 'doc-1', url: 'https://docs.google.com/document/d/doc-1' } });
    const refused = await call(`/v1/documents/${id}/draft/approve`, 'POST', { draftId: draft.id, expectedRevision: 1 });
    expect(refused.status).toBe(501);
    expect(await json(refused)).toMatchObject({ error: { code: 'EXTERNAL_TARGET_UNAVAILABLE' } });
    expect((await json<{ draft?: DocumentDraft }>(await call(`/v1/documents/${id}`))).draft?.status).toBe('pending');
  });

  it('the document chat is made once per (document, agent) and carries the documentId', async () => {
    const { id } = await withProposal();
    const first = await call(`/v1/documents/${id}/conversations`, 'POST', { agentId: 'agt-1' });
    const again = await call(`/v1/documents/${id}/conversations`, 'POST', { agentId: 'agt-1' });
    expect(first.status).toBe(201);
    const a = await json<{ id: string; documentId: string }>(first);
    const b = await json<{ id: string }>(again);
    expect(a.documentId).toBe(id);
    expect(b.id).toBe(a.id);
    expect((await call(`/v1/documents/${id}/conversations`, 'POST', { agentId: 'agt-missing' })).status).toBeGreaterThanOrEqual(400);
  });
});

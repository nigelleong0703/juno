import { describe, expect, it } from 'vitest';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store } from '../../../contracts/index.js';
import { approveDraft, createDocument, declineDraft, deleteDocumentDrafts, DocumentError, getDocumentView, proposeDraft, readOpenDraft, readVersion, savePersonDraft, type DocumentsDeps } from '../documents.js';

const OWNER = 'owner-1';
const BODY = 'Quarterly plan\n\nSECRET-BODY-TEXT that must live in the blob store only.';

function setup(): { deps: DocumentsDeps; raw: Store; other: DocumentsDeps } {
  const raw = createMemoryStore();
  const blobs = createMemoryBlobStore();
  return { raw, deps: { store: raw.forOwner?.(OWNER) ?? raw, blobs }, other: { store: raw.forOwner?.('owner-2') ?? raw, blobs } };
}

const propose = (deps: DocumentsDeps, documentId: string, over: Partial<Parameters<typeof proposeDraft>[2]> = {}) =>
  proposeDraft(deps, OWNER, { documentId, baseVersion: 1, markdown: 'v2 text', agentId: 'agent-a', conversationId: 'conv-1', runId: 'run-1', idempotencyKey: 'run-1:step-1:aaa', ...over });

async function savedDocument(deps: DocumentsDeps): Promise<string> {
  const made = await createDocument(deps, OWNER, { title: 'Plan', markdown: BODY, author: { agentId: 'agent-a' }, conversationId: 'conv-1', runId: 'run-0', idempotencyKey: 'run-0:s:h' });
  await approveDraft(deps, made.document.id, { draftId: made.draft.id, expectedRevision: 1 });
  return made.document.id;
}

async function refusal(promise: Promise<unknown>): Promise<DocumentError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DocumentError) return error;
    throw error;
  }
  throw new Error('expected a DocumentError');
}

describe('documents', () => {
  it('keeps the body in the blob store only: no row of any collection holds it', async () => {
    const { deps, raw } = setup();
    const id = await savedDocument(deps);
    await propose(deps, id, { markdown: 'SECOND-SECRET-BODY' });
    for (const collection of ['library', 'artifactFiles', 'documentDrafts', 'items'] as const) {
      const page = await raw.list(collection, { limit: 50 });
      expect(page.items.length).toBeGreaterThan(0);
      expect(JSON.stringify(page.items)).not.toContain('SECRET-BODY');
    }
  });

  it('a repeated create (same key) returns the first document and makes no second one', async () => {
    const { deps, raw } = setup();
    const args = { title: 'Plan', markdown: BODY, author: { agentId: 'agent-a' }, conversationId: 'conv-1', runId: 'r', idempotencyKey: 'r:s:h' };
    const first = await createDocument(deps, OWNER, args);
    const again = await createDocument(deps, OWNER, args);
    expect(again.created).toBe(false);
    expect(again.document.id).toBe(first.document.id);
    expect(again.draft.id).toBe(first.draft.id);
    expect((await raw.list('library', { limit: 10 })).items).toHaveLength(1);
    expect((await raw.list('items', { limit: 10 })).items).toHaveLength(1);
  });

  it('the same proposal key returns the same draft; the same call with other text is a conflict', async () => {
    const { deps, raw } = setup();
    const id = await savedDocument(deps);
    const first = await propose(deps, id);
    const again = await propose(deps, id);
    expect(again.deduped).toBe(true);
    expect(again.draft.id).toBe(first.draft.id);
    expect((await raw.list('documentDrafts', { where: { parentId: id }, limit: 20 })).items.filter((row) => row.status === 'pending')).toHaveLength(1);
    // Asking again for the same change in a later step is the same open draft, not a replacement of itself.
    expect((await propose(deps, id, { idempotencyKey: 'run-9:step-9:aaa', runId: 'run-9' })).draft.id).toBe(first.draft.id);
    const changed = await refusal(propose(deps, id, { markdown: 'other text', idempotencyKey: 'run-1:step-1:bbb' }));
    expect(changed).toMatchObject({ code: 'CONTENT_CHANGED', status: 409 });
  });

  it('refuses a stale base with a hint to read the latest', async () => {
    const { deps } = setup();
    const id = await savedDocument(deps);
    const error = await refusal(propose(deps, id, { baseVersion: 0 }));
    expect(error).toMatchObject({ code: 'STALE_BASE', status: 409 });
    expect(error.message).toContain('document_read');
  });

  it('a new agent proposal replaces the earlier open one; the owner\'s own open draft blocks agents', async () => {
    const { deps } = setup();
    const id = await savedDocument(deps);
    const first = await propose(deps, id);
    const second = await propose(deps, id, { idempotencyKey: 'run-2:step-1:ccc', runId: 'run-2', markdown: 'v2 again' });
    expect(second.supersededId).toBe(first.draft.id);
    expect((await getDocumentView(deps, id)).draft?.id).toBe(second.draft.id);
    // The owner edits the agent's open draft: it is theirs now.
    const edited = await savePersonDraft(deps, id, { title: 'Plan', markdown: 'owner text', expectedRevision: 1 });
    expect(edited.draft).toMatchObject({ author: 'person', revision: 2 });
    expect(await refusal(propose(deps, id, { idempotencyKey: 'run-3:s:ddd', runId: 'run-3' }))).toMatchObject({ code: 'PERSON_EDITING' });
  });

  it('approving twice makes one version and returns the same savedVersion', async () => {
    const { deps, raw } = setup();
    const made = await createDocument(deps, OWNER, { title: 'Plan', markdown: BODY, author: { agentId: 'agent-a' }, conversationId: 'conv-1' });
    const input = { draftId: made.draft.id, expectedRevision: 1 };
    const first = await approveDraft(deps, made.document.id, input);
    const second = await approveDraft(deps, made.document.id, input);
    expect(first.draft.savedVersion).toBe(1);
    expect(second).toMatchObject({ changed: false, draft: { savedVersion: 1, status: 'approved' } });
    expect((await raw.list('artifactFiles', { where: { parentId: made.document.id }, limit: 10 })).items).toHaveLength(1);
    expect((await getDocumentView(deps, made.document.id)).document).toMatchObject({ version: 1, name: 'Plan' });
    expect(await readVersion(deps, made.document.id, 1)).toMatchObject({ markdown: BODY });
  });

  it('refuses to approve a stale revision, a closed draft, or a document with an external target (nothing is written)', async () => {
    const { deps, raw } = setup();
    const id = await savedDocument(deps);
    const drafted = await propose(deps, id);
    expect(await refusal(approveDraft(deps, id, { draftId: drafted.draft.id, expectedRevision: 9 }))).toMatchObject({ code: 'STALE_REVISION' });
    await declineDraft(deps, id, { draftId: drafted.draft.id, expectedRevision: 1 });
    expect(await refusal(approveDraft(deps, id, { draftId: drafted.draft.id, expectedRevision: 1 }))).toMatchObject({ code: 'DRAFT_CLOSED' });

    const row = await raw.get('library', id);
    await raw.put('library', { ...row!, target: { appId: 'google-docs', externalId: 'x', url: 'https://docs.google.com/document/d/x' } });
    const next = await propose(deps, id, { idempotencyKey: 'run-4:s:eee', runId: 'run-4' });
    expect(await refusal(approveDraft(deps, id, { draftId: next.draft.id, expectedRevision: 1 }))).toMatchObject({ code: 'EXTERNAL_TARGET_UNAVAILABLE', status: 501 });
    expect((await getDocumentView(deps, id)).document.version).toBe(1);
    expect((await getDocumentView(deps, id)).draft?.status).toBe('pending');
  });

  it('the owner\'s save: a stale draft revision or base version is a 409; a saved person draft approves into the next version', async () => {
    const { deps } = setup();
    const id = await savedDocument(deps);
    expect(await refusal(savePersonDraft(deps, id, { title: 'Plan', markdown: 'x', baseVersion: 0 }))).toMatchObject({ code: 'STALE_BASE' });
    const saved = await savePersonDraft(deps, id, { title: 'Plan 2', markdown: 'owner v2', baseVersion: 1 });
    expect(saved.draft).toMatchObject({ author: 'person', revision: 1, baseVersion: 1 });
    expect(await refusal(savePersonDraft(deps, id, { title: 'Plan 2', markdown: 'x', expectedRevision: 5 }))).toMatchObject({ code: 'STALE_REVISION' });
    const again = await savePersonDraft(deps, id, { title: 'Plan 2', markdown: 'owner v2b', expectedRevision: 1 });
    expect((await readOpenDraft(deps, id))?.markdown).toBe('owner v2b');
    const done = await approveDraft(deps, id, { draftId: again.draft.id, expectedRevision: 2 });
    expect(done.draft.savedVersion).toBe(2);
    expect((await readVersion(deps, id, 1)).markdown).toBe(BODY);
    expect((await readVersion(deps, id, 2)).markdown).toBe('owner v2b');
  });

  it('another owner\'s document answers like a missing one; deleting a document\'s drafts leaves none', async () => {
    const { deps, other, raw } = setup();
    const id = await savedDocument(deps);
    expect(await refusal(getDocumentView(other, id))).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(await refusal(propose(other, id))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await refusal(readVersion(other, id, 1))).toMatchObject({ code: 'NOT_FOUND' });
    await deps.store.tx((tx) => deleteDocumentDrafts(tx, id));
    expect((await raw.list('documentDrafts', { where: { parentId: id }, limit: 10 })).items).toHaveLength(0);
  });

  it('refuses a body over the limit', async () => {
    const { deps } = setup();
    expect(await refusal(createDocument(deps, OWNER, { title: 'Big', markdown: 'x'.repeat(100_001), author: 'person' }))).toMatchObject({ code: 'TOO_LARGE' });
  });
});

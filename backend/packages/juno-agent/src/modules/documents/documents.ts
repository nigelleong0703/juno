/**
 * Documents (BACKEND 5.11a): a Library row with `render: 'doc'` whose saved versions are `artifactFiles` rows, and `documentDrafts`, the
 * proposed changes the owner reviews. Everything that changes a document goes through here, for the agent tools and the agentd routes alike,
 * so the rules (one open draft, revision lock, stale base, idempotent retries, idempotent approve) have one home. Bodies live in the blob
 * store; no row holds Markdown. Every write that touches the document runs under the library row's lock, in one transaction with its events.
 *
 * The retry rules are OpenDots' (CopilotKit/OpenDots@8091324, src/server/pages.ts L156-L238): a repeated call returns what the first one made,
 * the same call with different content is a conflict, and an edit made against an old revision is refused with "read the latest first".
 */
import { createHash } from 'node:crypto';
import { artifactSchema, documentDraftSchema, MAX_DOCUMENT_CHARS, type Artifact, type DocumentDraft, type DocumentDraftAuthor } from '@agent-desktop/public-contracts';
import { loadBlob, saveBlob, type BlobStore, type DocumentDraftRow, type LibraryDocument, type Store } from '../../contracts/index.js';
import { emitItemAdded } from '../../execution/conversation-activity.js';
import { newId, nowIso } from '../tools/util.js';

export const DOCUMENT_MIME = 'text/markdown';

export type DocumentErrorCode =
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'STALE_BASE'
  | 'STALE_REVISION'
  | 'REVISION_REQUIRED'
  | 'PERSON_EDITING'
  | 'CONTENT_CHANGED'
  | 'DRAFT_CLOSED'
  | 'EXTERNAL_TARGET_UNAVAILABLE'
  | 'CONTENT_UNAVAILABLE';

const STATUS: Record<DocumentErrorCode, 400 | 404 | 409 | 501 | 500> = {
  NOT_FOUND: 404,
  TOO_LARGE: 400,
  STALE_BASE: 409,
  STALE_REVISION: 409,
  REVISION_REQUIRED: 400,
  PERSON_EDITING: 409,
  CONTENT_CHANGED: 409,
  DRAFT_CLOSED: 409,
  EXTERNAL_TARGET_UNAVAILABLE: 501,
  CONTENT_UNAVAILABLE: 500,
};

/** A refusal the caller can show as it is: a stable `code`, the HTTP `status` a route answers with, and text written for the agent or the owner. */
export class DocumentError extends Error {
  readonly status: 400 | 404 | 409 | 501 | 500;
  constructor(readonly code: DocumentErrorCode, message: string) {
    super(message);
    this.status = STATUS[code];
  }
}

/** What the document functions need: the owner-scoped store (every row they touch belongs to that owner) and the blob store. */
export interface DocumentsDeps {
  store: Store;
  blobs: BlobStore;
}

export interface DraftWithMarkdown {
  draft: DocumentDraft;
  markdown: string;
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A stable id from a retry key, scoped to the owner so two owners' keys can never meet. */
function keyedId(prefix: string, ownerId: string, key: string): string {
  return prefix + '_' + digest(ownerId + '\u0000' + key).slice(0, 20);
}

function checkSize(markdown: string): void {
  if (markdown.length > MAX_DOCUMENT_CHARS) throw new DocumentError('TOO_LARGE', 'The document is ' + String(markdown.length) + ' characters; the limit is ' + String(MAX_DOCUMENT_CHARS) + '. Split it into parts.');
}

const publicDraft = (row: DocumentDraftRow): DocumentDraft => documentDraftSchema.parse(row);

export const headVersionOf = (doc: Pick<LibraryDocument, 'version'>): number => doc.version ?? 0;

async function ownDocument(store: Store, id: string, lock: boolean): Promise<LibraryDocument> {
  const row = lock ? await (store.getForUpdate?.('library', id) ?? store.get('library', id)) : await store.get('library', id);
  if (row === null || row.render !== 'doc') throw new DocumentError('NOT_FOUND', 'No document with this id.');
  return row;
}

/** The document and its open draft, for reading. */
export async function getDocumentView(deps: DocumentsDeps, id: string): Promise<{ document: Artifact; draft?: DocumentDraft }> {
  const doc = await ownDocument(deps.store, id, false);
  const open = await openDraftOf(deps.store, id);
  return { document: artifactSchema.parse(doc), ...(open === null ? {} : { draft: publicDraft(open) }) };
}

/** The one pending draft of a document, or null. */
export async function openDraftOf(store: Store, documentId: string): Promise<DocumentDraftRow | null> {
  const page = await store.list('documentDrafts', { where: { parentId: documentId, status: 'pending' }, limit: 5, orderBy: 'at', order: 'desc' });
  return page.items[0] ?? null;
}

async function emitDraft(tx: Store, row: DocumentDraftRow): Promise<void> {
  await tx.emit({ type: 'document.draft.updated', draft: publicDraft(row) });
}

async function putDraft(tx: Store, row: DocumentDraftRow): Promise<void> {
  await tx.put('documentDrafts', row, {
    parentId: row.documentId,
    status: row.status,
    ...(row.conversationId === undefined ? {} : { conversationId: row.conversationId }),
    ...(row.runId === undefined ? {} : { runId: row.runId }),
    ...(row.agentId === undefined ? {} : { agentId: row.agentId }),
  });
}

async function readBody(blobs: BlobStore, ref: { blobKey: string; sizeBytes: number; sha256: string }): Promise<string> {
  const read = await loadBlob(blobs, ref);
  if (!read.ok) throw new DocumentError('CONTENT_UNAVAILABLE', 'The stored text is unavailable: ' + read.reason);
  return read.bytes.toString('utf8');
}

/** The open draft with its Markdown. */
export async function readOpenDraft(deps: DocumentsDeps, documentId: string): Promise<DraftWithMarkdown | null> {
  await ownDocument(deps.store, documentId, false);
  const open = await openDraftOf(deps.store, documentId);
  return open === null ? null : { draft: publicDraft(open), markdown: await readBody(deps.blobs, open) };
}

/** One saved version's Markdown. */
export async function readVersion(deps: DocumentsDeps, documentId: string, version: number): Promise<{ version: number; markdown: string; sha256: string }> {
  const doc = await ownDocument(deps.store, documentId, false);
  const found = doc.versions?.find((candidate) => candidate.version === version);
  const file = found === undefined ? null : await deps.store.get('artifactFiles', found.fileRef);
  if (found === undefined || file === null || file.artifactId !== documentId) throw new DocumentError('NOT_FOUND', 'The document has no version ' + String(version) + '.');
  return { version, markdown: await readBody(deps.blobs, file), sha256: file.sha256 };
}

export interface CreateDocumentArgs {
  title: string;
  markdown: string;
  author: DocumentDraftAuthor;
  conversationId?: string;
  runId?: string;
  /** Agent calls: `runId:stepId:sha256`. The same key returns the document the first call made. */
  idempotencyKey?: string;
  summary?: string;
}

/** A new document with its first draft (base 0). Approving the draft makes version 1. Not seen by anyone else before that. */
export async function createDocument(deps: DocumentsDeps, ownerId: string, args: CreateDocumentArgs): Promise<{ document: Artifact; draft: DocumentDraft; created: boolean }> {
  checkSize(args.markdown);
  const keyed = args.idempotencyKey !== undefined;
  const documentId = keyed ? keyedId('lib', ownerId, args.idempotencyKey ?? '') : newId('lib');
  const draftId = keyed ? keyedId('drf', ownerId, args.idempotencyKey ?? '') : newId('drf');
  const earlier = keyed ? await deps.store.get('library', documentId) : null;
  if (earlier !== null) {
    const row = await deps.store.get('documentDrafts', draftId);
    if (earlier.render !== 'doc' || row === null) throw new DocumentError('NOT_FOUND', 'No document with this id.');
    return { document: artifactSchema.parse(earlier), draft: publicDraft(row), created: false };
  }
  const stored = await saveBlob(deps.blobs, Buffer.from(args.markdown, 'utf8'), DOCUMENT_MIME);
  const at = nowIso();
  const agentId = typeof args.author === 'object' ? args.author.agentId : undefined;
  const doc: LibraryDocument = {
    id: documentId,
    name: args.title,
    kind: 'document',
    mimeType: DOCUMENT_MIME,
    sizeBytes: 0,
    ...(agentId === undefined ? {} : { createdByAgentId: agentId }),
    ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
    ...(args.runId === undefined ? {} : { runId: args.runId }),
    shared: 'private',
    source: agentId === undefined ? 'upload' : 'agent',
    tags: [],
    createdAt: at,
    updatedAt: at,
    pinned: false,
    render: 'doc',
    versions: [],
  };
  const draft: DocumentDraftRow = {
    id: draftId,
    documentId,
    baseVersion: 0,
    revision: 1,
    title: args.title,
    ...(args.summary === undefined ? {} : { summary: args.summary }),
    author: args.author,
    ...(agentId === undefined ? {} : { agentId }),
    ...(args.conversationId === undefined ? {} : { conversationId: args.conversationId }),
    ...(args.runId === undefined ? {} : { runId: args.runId }),
    sizeBytes: stored.sizeBytes,
    sha256: stored.sha256,
    status: 'pending',
    createdAt: at,
    updatedAt: at,
    blobKey: stored.blobKey,
    ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
  };
  await deps.store.tx(async (tx) => {
    await tx.put('library', doc, { conversationId: args.conversationId ?? null });
    await putDraft(tx, draft);
    await tx.emit({ type: 'artifact.updated', artifact: artifactSchema.parse(doc) });
    await emitDraft(tx, draft);
    // The card in the chat that asked for it: "waiting for your review". Later changes update it in place.
    if (args.conversationId !== undefined) {
      const item = { id: newId('itm'), conversationId: args.conversationId, type: 'artifact' as const, artifactId: documentId, at };
      await tx.put('items', item, { conversationId: args.conversationId });
      await emitItemAdded(tx, args.conversationId, item);
    }
  });
  return { document: artifactSchema.parse(doc), draft: publicDraft(draft), created: true };
}

export interface ProposeArgs {
  documentId: string;
  baseVersion: number;
  markdown: string;
  summary?: string;
  agentId: string;
  conversationId: string;
  runId: string;
  /** `runId:stepId:sha256`. */
  idempotencyKey: string;
}

/** An agent's proposed new text. Returns the draft it made, or the one an identical earlier call made (`deduped`). */
export async function proposeDraft(deps: DocumentsDeps, ownerId: string, args: ProposeArgs): Promise<{ draft: DocumentDraft; deduped: boolean; supersededId?: string }> {
  checkSize(args.markdown);
  const stored = await saveBlob(deps.blobs, Buffer.from(args.markdown, 'utf8'), DOCUMENT_MIME);
  const draftId = keyedId('drf', ownerId, args.idempotencyKey);
  // The call is `runId:stepId`; the key adds the content hash. A replay of the same call with other text is not a retry.
  const callKey = args.idempotencyKey.slice(0, args.idempotencyKey.lastIndexOf(':') + 1);
  return deps.store.tx(async (tx) => {
    const doc = await ownDocument(tx, args.documentId, true);
    const same = await tx.get('documentDrafts', draftId);
    if (same !== null) {
      if (same.documentId !== args.documentId) throw new DocumentError('CONTENT_CHANGED', 'This call already proposed a change to another document.');
      return { draft: publicDraft(same), deduped: true };
    }
    const calls = await tx.list('documentDrafts', { where: { parentId: args.documentId, runId: args.runId }, limit: 100 });
    if (calls.items.some((row) => row.idempotencyKey?.startsWith(callKey) === true)) {
      throw new DocumentError('CONTENT_CHANGED', 'This call already proposed different text, which is waiting for review. Treat a changed text as a new proposal: read the document again and call document_propose in a new step.');
    }
    const head = headVersionOf(doc);
    if (args.baseVersion !== head) {
      throw new DocumentError('STALE_BASE', 'The document is at version ' + String(head) + ', not ' + String(args.baseVersion) + '. Call document_read for the latest text and propose again on top of it.');
    }
    const open = await openDraftOf(tx, args.documentId);
    if (open !== null && open.author === 'person') {
      throw new DocumentError('PERSON_EDITING', 'The owner is editing this document right now (their unsaved changes are the open draft). Do not overwrite them: ask them in chat first, or wait until they save or discard.');
    }
    // The model asking twice for the very same change (a new step, so a new key) is one proposal, not a replacement of itself.
    if (open !== null && open.agentId === args.agentId && open.sha256 === stored.sha256 && open.baseVersion === head) return { draft: publicDraft(open), deduped: true };
    const at = nowIso();
    let supersededId: string | undefined;
    if (open !== null) {
      const closed: DocumentDraftRow = { ...open, status: 'superseded', decidedAt: at, updatedAt: at };
      await putDraft(tx, closed);
      await emitDraft(tx, closed);
      supersededId = open.id;
    }
    const draft: DocumentDraftRow = {
      id: draftId,
      documentId: args.documentId,
      baseVersion: head,
      revision: 1,
      title: doc.name,
      ...(args.summary === undefined ? {} : { summary: args.summary }),
      author: { agentId: args.agentId },
      agentId: args.agentId,
      conversationId: args.conversationId,
      runId: args.runId,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      status: 'pending',
      createdAt: at,
      updatedAt: at,
      blobKey: stored.blobKey,
      idempotencyKey: args.idempotencyKey,
    };
    await putDraft(tx, draft);
    await emitDraft(tx, draft);
    return { draft: publicDraft(draft), deduped: false, ...(supersededId === undefined ? {} : { supersededId }) };
  });
}

export interface SavePersonDraftArgs {
  title: string;
  markdown: string;
  /** With an open draft: the revision the editor loaded. */
  expectedRevision?: number;
  /** Without one: the saved version the editor started from. */
  baseVersion?: number;
}

/** The owner's own text. Edits the open draft (an agent's draft becomes theirs), or starts one on the saved head. */
export async function savePersonDraft(deps: DocumentsDeps, documentId: string, args: SavePersonDraftArgs): Promise<DraftWithMarkdown> {
  checkSize(args.markdown);
  const stored = await saveBlob(deps.blobs, Buffer.from(args.markdown, 'utf8'), DOCUMENT_MIME);
  const row = await deps.store.tx(async (tx) => {
    const doc = await ownDocument(tx, documentId, true);
    const open = await openDraftOf(tx, documentId);
    const at = nowIso();
    const text = { title: args.title, sizeBytes: stored.sizeBytes, sha256: stored.sha256, blobKey: stored.blobKey, updatedAt: at };
    let next: DocumentDraftRow;
    if (open !== null) {
      if (args.expectedRevision === undefined) throw new DocumentError('REVISION_REQUIRED', 'expectedRevision is required while a draft is open.');
      if (args.expectedRevision !== open.revision) throw new DocumentError('STALE_REVISION', 'The draft changed (now revision ' + String(open.revision) + '). Reload it before saving.');
      const { idempotencyKey: _dropped, summary: _summary, ...rest } = open;
      next = { ...rest, ...text, author: 'person', revision: open.revision + 1 };
    } else {
      const head = headVersionOf(doc);
      if (args.baseVersion === undefined) throw new DocumentError('REVISION_REQUIRED', 'baseVersion is required when no draft is open.');
      if (args.baseVersion !== head) throw new DocumentError('STALE_BASE', 'The document is now at version ' + String(head) + '. Reload it before saving.');
      next = { id: newId('drf'), documentId, baseVersion: head, revision: 1, author: 'person', status: 'pending', createdAt: at, ...text };
    }
    await putDraft(tx, next);
    await emitDraft(tx, next);
    return next;
  });
  return { draft: publicDraft(row), markdown: args.markdown };
}

export interface Decision {
  document: Artifact;
  draft: DocumentDraft;
  /** The row that was just decided now, false when this call only repeated an earlier decision. */
  changed: boolean;
}

const fileNameOf = (title: string): string => (title.replace(/[\\/\0:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'document') + '.md';

/**
 * Save the draft as the next version. Repeating it for an approved draft returns the same version. A document with an external `target` is
 * refused before anything is written (the write to the other app is the connectors batch, BACKEND 5.11a).
 */
export async function approveDraft(deps: DocumentsDeps, documentId: string, input: { draftId: string; expectedRevision: number }): Promise<Decision> {
  return deps.store.tx(async (tx) => {
    const doc = await ownDocument(tx, documentId, true);
    const row = await tx.get('documentDrafts', input.draftId);
    if (row === null || row.documentId !== documentId) throw new DocumentError('NOT_FOUND', 'No draft with this id on this document.');
    if (row.status === 'approved' && row.revision === input.expectedRevision) return { document: artifactSchema.parse(doc), draft: publicDraft(row), changed: false };
    if (row.status !== 'pending') throw new DocumentError('DRAFT_CLOSED', 'This draft is already ' + row.status + '.');
    if (row.revision !== input.expectedRevision) throw new DocumentError('STALE_REVISION', 'The draft changed (now revision ' + String(row.revision) + '). Review it again.');
    const head = headVersionOf(doc);
    if (row.baseVersion !== head) throw new DocumentError('STALE_BASE', 'The document moved to version ' + String(head) + ' after this draft was written.');
    if (doc.target !== undefined) throw new DocumentError('EXTERNAL_TARGET_UNAVAILABLE', 'Writing to ' + doc.target.appId + ' is not available yet. The draft stays open.');
    const at = nowIso();
    const version = head + 1;
    const file = { id: newId('af'), artifactId: documentId, version, part: 'file' as const, name: fileNameOf(row.title), mimeType: DOCUMENT_MIME, sizeBytes: row.sizeBytes, sha256: row.sha256, blobKey: row.blobKey, createdAt: at };
    await tx.put('artifactFiles', file, { parentId: documentId, ...(doc.conversationId === undefined ? {} : { conversationId: doc.conversationId }) });
    const next: LibraryDocument = {
      ...doc,
      name: row.title,
      sizeBytes: row.sizeBytes,
      updatedAt: at,
      version,
      versions: [...(doc.versions ?? []), { version, fileRef: file.id, sizeBytes: row.sizeBytes, mimeType: DOCUMENT_MIME, sha256: row.sha256, createdAt: at }],
    };
    await tx.put('library', next, { conversationId: doc.conversationId ?? null });
    const decided: DocumentDraftRow = { ...row, status: 'approved', savedVersion: version, decidedAt: at, updatedAt: at };
    await putDraft(tx, decided);
    await tx.emit({ type: 'artifact.updated', artifact: artifactSchema.parse(next) });
    await emitDraft(tx, decided);
    return { document: artifactSchema.parse(next), draft: publicDraft(decided), changed: true };
  });
}

/** Drop the draft; the document stays as it was. Repeating it is harmless. */
export async function declineDraft(deps: DocumentsDeps, documentId: string, input: { draftId: string; expectedRevision: number }): Promise<Decision> {
  return deps.store.tx(async (tx) => {
    const doc = await ownDocument(tx, documentId, true);
    const row = await tx.get('documentDrafts', input.draftId);
    if (row === null || row.documentId !== documentId) throw new DocumentError('NOT_FOUND', 'No draft with this id on this document.');
    if (row.status === 'declined' && row.revision === input.expectedRevision) return { document: artifactSchema.parse(doc), draft: publicDraft(row), changed: false };
    if (row.status !== 'pending') throw new DocumentError('DRAFT_CLOSED', 'This draft is already ' + row.status + '.');
    if (row.revision !== input.expectedRevision) throw new DocumentError('STALE_REVISION', 'The draft changed (now revision ' + String(row.revision) + '). Review it again.');
    const at = nowIso();
    const decided: DocumentDraftRow = { ...row, status: 'declined', decidedAt: at, updatedAt: at };
    await putDraft(tx, decided);
    await emitDraft(tx, decided);
    return { document: artifactSchema.parse(doc), draft: publicDraft(decided), changed: true };
  });
}

/** Deleting a document deletes its drafts with it (their bodies are content-addressed blobs the account erase and orphan sweeps handle). */
export async function deleteDocumentDrafts(tx: Store, documentId: string): Promise<void> {
  for (;;) {
    const page = await tx.list('documentDrafts', { where: { parentId: documentId }, limit: 100 });
    if (page.items.length === 0) return;
    for (const row of page.items) await tx.delete('documentDrafts', row.id);
  }
}

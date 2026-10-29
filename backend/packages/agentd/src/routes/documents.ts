/**
 * Documents (BACKEND 5.11a): the owner's side of the draft -> review -> approve loop. The rules (one open draft, revision lock, idempotent
 * approve, stale base) are in juno-agent's modules/documents/documents.ts, which the agent tools use too; this file maps them to HTTP,
 * tells the proposing agent how a review ended, and records approved agent work in memory.
 *
 * Telling the agent: after a draft is decided, the proposing agent gets a `request_resolved` wake in the chat it proposed from, with a system
 * note as its text. No run waits for it, so the agent's turn ended when it proposed. The wake id is derived from the draft and its outcome, so a
 * retried approve/decline re-attempts the delivery without waking twice, and a delivery failure is reported (502) while the decision stays.
 */
import { type Context, type Hono } from 'hono';
import { sessionKey, wakeEventSchema } from '@agent-desktop/contracts';
import type { Store, WakeEvent } from '@agent-desktop/contracts';
import {
  createDocumentInputSchema,
  decideDocumentDraftInputSchema,
  documentConversationInputSchema,
  saveDocumentDraftInputSchema,
  type Conversation,
  type DocumentDraft,
} from '@agent-desktop/public-contracts';
import {
  approveDraft,
  createDocument,
  declineDraft,
  DocumentError,
  getDocumentView,
  readOpenDraft,
  readVersion,
  savePersonDraft,
  type Decision,
  type DocumentsDeps,
} from 'juno-agent/modules/documents/documents';
import { recordPublishedArtifact } from 'juno-agent/modules/memory/artifact-note';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { idempotentConversationId, withKeyLock } from './message-admission.js';
import { isRelationshipError, resolveConversationMembers } from './relationships.js';

const body = async (c: Context): Promise<unknown> => c.req.json().catch(() => undefined);
const invalid = (c: Context, message: string) => c.json({ error: { code: 'INVALID_BODY', message } }, 400);

/** What the agent is told: who decided, and what it means for the next move. */
function decisionNote(draft: DocumentDraft, title: string): string {
  const edited = draft.author === 'person' ? ' with their own edits' : '';
  if (draft.status === 'approved') {
    return `[system note, from the owner's review] The owner approved your proposal for the document "${title}"${edited}; it is now version ${String(draft.savedVersion)}. Read it again before changing it further.`;
  }
  return `[system note, from the owner's review] The owner declined your proposal for the document "${title}". It was not saved. Do not propose it again; ask what they want changed if it matters.`;
}

export function registerDocuments(app: Hono, deps: AgentdDeps) {
  /** The owner-scoped documents view for this request, or the refusal. */
  const scoped = (c: Context): { ok: true; docs: DocumentsDeps; ownerId: string } | { ok: false; response: Response } => {
    const ownerId = getOwnerId(c);
    const store: Store | undefined = deps.store.forOwner?.(ownerId);
    if (deps.blobs === undefined || store === undefined) {
      return { ok: false, response: c.json({ error: { code: 'DOCUMENTS_UNAVAILABLE', message: 'documents need the blob store and an owner-scoped database' } }, 503) };
    }
    return { ok: true, docs: { store, blobs: deps.blobs }, ownerId };
  };

  /** Run one documents call; a refusal of the rules becomes its status and code. */
  const guarded = async (c: Context, fn: (docs: DocumentsDeps, ownerId: string) => Promise<Response>): Promise<Response> => {
    const made = scoped(c);
    if (!made.ok) return made.response;
    try {
      return await fn(made.docs, made.ownerId);
    } catch (error) {
      if (error instanceof DocumentError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
      throw error;
    }
  };

  /** Tell the proposing agent, and remember approved work. Only a draft that came from an agent's chat has anyone to tell. */
  const afterDecision = async (docs: DocumentsDeps, ownerId: string, decision: Decision, row: { agentId?: string; conversationId?: string }): Promise<{ error: string } | undefined> => {
    const { draft, document } = decision;
    if (row.agentId === undefined || row.conversationId === undefined || (draft.status !== 'approved' && draft.status !== 'declined')) return undefined;
    if (decision.changed && draft.status === 'approved' && deps.memory !== undefined) {
      // Best effort: the version is saved, a memory failure never undoes it.
      try {
        await recordPublishedArtifact(deps.store, deps.memory, { ownerId, agentId: row.agentId, conversationId: row.conversationId, artifactId: document.id, title: document.name, version: draft.savedVersion ?? 1, verb: 'Saved the document', at: draft.decidedAt ?? new Date().toISOString() }, deps.computerd?.home);
      } catch {
        // see above
      }
    }
    const wake: Omit<WakeEvent, 'status'> = {
      id: `wk-doc-${draft.id}-${draft.status}`,
      ownerId,
      agentId: row.agentId,
      sessionKey: sessionKey(row.agentId, row.conversationId),
      conversationId: row.conversationId,
      kind: 'request_resolved',
      origin: { type: 'user' },
      trusted: true,
      priority: 'user',
      payload: { text: decisionNote(draft, document.name), documentId: document.id, draftId: draft.id, status: draft.status },
      at: new Date().toISOString(),
    };
    const result = await deps.enqueuer.enqueue(wakeEventSchema.parse(wake));
    return result.accepted ? undefined : { error: result.reason ?? 'wake delivery rejected' };
  };

  const decide = (verb: typeof approveDraft) => async (c: Context): Promise<Response> => {
    const input = decideDocumentDraftInputSchema.safeParse(await body(c));
    if (!input.success) return invalid(c, 'draftId and expectedRevision are required');
    return guarded(c, async (docs, ownerId) => {
      const documentId = c.req.param('id') ?? '';
      const decision = await verb(docs, documentId, input.data);
      const row = await docs.store.get('documentDrafts', decision.draft.id);
      const failed = await afterDecision(docs, ownerId, decision, row ?? {});
      if (failed !== undefined) return c.json({ error: { code: 'WAKE_DELIVERY_FAILED', message: failed.error } }, 502);
      return c.json({ document: decision.document, draft: decision.draft });
    });
  };

  app.post('/v1/documents', async (c) => {
    const input = createDocumentInputSchema.safeParse(await body(c));
    if (!input.success) return invalid(c, 'title and markdown are required');
    return guarded(c, async (docs, ownerId) => {
      const created = await createDocument(docs, ownerId, { title: input.data.title, markdown: input.data.markdown, author: 'person', ...(input.data.idempotencyKey === undefined ? {} : { idempotencyKey: input.data.idempotencyKey }) });
      return c.json({ document: created.document, draft: created.draft }, created.created ? 201 : 200);
    });
  });

  app.get('/v1/documents/:id', (c) => guarded(c, async (docs) => c.json(await getDocumentView(docs, c.req.param('id')))));

  app.get('/v1/documents/:id/versions/:v/content', (c) =>
    guarded(c, async (docs) => {
      const version = Number(c.req.param('v'));
      if (!Number.isInteger(version) || version < 1) return c.json({ error: { code: 'NOT_FOUND', message: 'No such version.' } }, 404);
      return c.json(await readVersion(docs, c.req.param('id'), version));
    }),
  );

  app.get('/v1/documents/:id/draft', (c) =>
    guarded(c, async (docs) => {
      const open = await readOpenDraft(docs, c.req.param('id'));
      return open === null ? c.json({ error: { code: 'NO_DRAFT', message: 'No draft is open on this document.' } }, 404) : c.json(open);
    }),
  );

  app.put('/v1/documents/:id/draft', async (c) => {
    const input = saveDocumentDraftInputSchema.safeParse(await body(c));
    if (!input.success) return invalid(c, 'title and markdown are required');
    return guarded(c, async (docs) => {
      const { title, markdown, expectedRevision, baseVersion } = input.data;
      return c.json(await savePersonDraft(docs, c.req.param('id'), { title, markdown, ...(expectedRevision === undefined ? {} : { expectedRevision }), ...(baseVersion === undefined ? {} : { baseVersion }) }));
    });
  });

  app.post('/v1/documents/:id/draft/approve', decide(approveDraft));
  app.post('/v1/documents/:id/draft/decline', decide(declineDraft));

  // The chat about one document with one agent: the same chat every time for the pair.
  app.post('/v1/documents/:id/conversations', async (c) => {
    const input = documentConversationInputSchema.safeParse(await body(c));
    if (!input.success) return invalid(c, 'agentId is required');
    return guarded(c, async (docs, ownerId) => {
      const documentId = c.req.param('id') ?? '';
      const { document } = await getDocumentView(docs, documentId);
      const members = await resolveConversationMembers(deps.store, ownerId, [input.data.agentId]);
      if (isRelationshipError(members)) return c.json({ error: { code: members.code, message: members.message } }, members.status);
      const id = idempotentConversationId(ownerId, 'doc-' + documentId + '-' + input.data.agentId);
      return withKeyLock('document-conversation:' + id, async () => {
        const existing = await deps.store.get('conversations', id);
        if (existing !== null) return c.json(existing);
        const now = new Date().toISOString();
        const conversation: Conversation & { ownerId: string } = { id, kind: 'direct', title: document.name, agentIds: members.memberAgentIds, memberIds: [ownerId], documentId, unreadCount: 0, lastItemAt: now, createdAt: now, ownerId };
        const created = await deps.store.put('conversations', conversation);
        await deps.store.emit({ type: 'conversation.created', conversation: created });
        return c.json(created, 201);
      });
    });
  });
}

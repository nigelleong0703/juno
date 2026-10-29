import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';
import { artifactSchema } from './artifact.js';

/** Longest document body (characters) a draft or a save may carry; the agent tools and the routes use the same limit. */
export const MAX_DOCUMENT_CHARS = 100_000;

/** A draft waits for the owner (`pending`), became a saved version (`approved`), was turned down (`declined`), or was replaced by a newer draft before anyone decided (`superseded`). */
export const documentDraftStatusSchema = z.enum(['pending', 'approved', 'declined', 'superseded']);
export type DocumentDraftStatus = z.infer<typeof documentDraftStatusSchema>;

/** Who wrote a draft: an agent, or the owner editing in the app (their own save is an approval). */
export const documentDraftAuthorSchema = z.union([z.object({ agentId: idSchema }), z.literal('person')]);
export type DocumentDraftAuthor = z.infer<typeof documentDraftAuthorSchema>;

/**
 * One proposed change to a document (BACKEND 5.11a). The Markdown body is never in this object: `GET /v1/documents/:id/draft` returns it
 * next to the metadata. `revision` rises with every save of the same draft and is the lock for `PUT …/draft` and `approve`.
 */
export const documentDraftSchema = z.object({
  id: idSchema,
  documentId: idSchema,
  /** The saved version this draft was written against (0 = the document has no saved version yet). */
  baseVersion: z.number().int().min(0),
  revision: z.number().int().min(1),
  title: z.string().min(1).max(200),
  /** Agent drafts: one line on what changed. */
  summary: z.string().max(500).optional(),
  author: documentDraftAuthorSchema,
  conversationId: idSchema.optional(),
  runId: idSchema.optional(),
  sizeBytes: z.number().int().min(0),
  sha256: z.string().min(1),
  status: documentDraftStatusSchema,
  /** `approved` only: the version this draft became. */
  savedVersion: z.number().int().min(1).optional(),
  decidedAt: isoDateTimeSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type DocumentDraft = z.infer<typeof documentDraftSchema>;

/** A draft with its Markdown body (`GET /v1/documents/:id/draft`). */
export const documentDraftContentSchema = z.object({ draft: documentDraftSchema, markdown: z.string().max(MAX_DOCUMENT_CHARS) });
export type DocumentDraftContent = z.infer<typeof documentDraftContentSchema>;

/** A document and its open draft, if any (`GET /v1/documents/:id`). `document.version` is the saved head; absent until the first approval. */
export const documentViewSchema = z.object({
  document: artifactSchema,
  draft: documentDraftSchema.optional(),
});
export type DocumentView = z.infer<typeof documentViewSchema>;

export const createDocumentInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  markdown: z.string().max(MAX_DOCUMENT_CHARS),
  /** Makes the call safe to repeat: the same key returns the same document. */
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type CreateDocumentInput = z.infer<typeof createDocumentInputSchema>;

export const saveDocumentDraftInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  markdown: z.string().max(MAX_DOCUMENT_CHARS),
  /** While a draft is open: the revision the editor loaded (409 when it is stale). */
  expectedRevision: z.number().int().min(1).optional(),
  /** While none is open: the saved version the editor started from (409 when the document moved). */
  baseVersion: z.number().int().min(0).optional(),
});
export type SaveDocumentDraftInput = z.infer<typeof saveDocumentDraftInputSchema>;

export const decideDocumentDraftInputSchema = z.object({ draftId: idSchema, expectedRevision: z.number().int().min(1) });
export type DecideDocumentDraftInput = z.infer<typeof decideDocumentDraftInputSchema>;

export const documentConversationInputSchema = z.object({ agentId: idSchema });
export type DocumentConversationInput = z.infer<typeof documentConversationInputSchema>;

/** Plain-text bytes of one saved version (`GET /v1/documents/:id/versions/:v/content`). */
export const documentContentSchema = z.object({ version: z.number().int().min(1), markdown: z.string(), sha256: z.string() });
export type DocumentContent = z.infer<typeof documentContentSchema>;

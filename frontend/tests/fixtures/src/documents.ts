/**
 * Mock `/v1/documents*`: the same rules and error codes as the backend routes (BACKEND.md 5.11a). Bodies live in memory next
 * to the Library row; one draft is open per document; the owner's save needs the revision it loaded.
 */
import type { ApiClient, Conversation, DocumentDraft, LibraryItem } from '@agent-desktop/client';
import { apiError } from './util.js';

export interface DocumentsMockDeps {
  library: () => LibraryItem[];
  delay: () => Promise<void>;
  newId: () => string;
  now: () => Date;
  openConversation: (agentId: string) => Promise<Conversation>;
}

interface DocumentRecord {
  versions: Map<number, string>;
  draft?: { draft: DocumentDraft; markdown: string };
}

const iso = (date: Date) => date.toISOString();

export function createDocumentsMock(deps: DocumentsMockDeps): ApiClient['documents'] {
  const records = new Map<string, DocumentRecord>();
  const record = (id: string): DocumentRecord => {
    const found = records.get(id);
    if (!found || !deps.library().some((item) => item.id === id)) throw apiError(404, 'NOT_FOUND', 'document not found');
    return found;
  };
  const row = (id: string): LibraryItem => {
    const { pinned: _pinned, folder: _folder, ...item } = deps.library().find((entry) => entry.id === id) as LibraryItem;
    return item as LibraryItem;
  };
  const view = (id: string) => {
    const open = records.get(id)?.draft;
    return { document: row(id), ...(open && open.draft.status === 'pending' ? { draft: { ...open.draft } } : {}) };
  };
  const head = (id: string) => Math.max(0, ...record(id).versions.keys());
  const newDraft = (documentId: string, title: string, markdown: string, author: DocumentDraft['author'], baseVersion: number): { draft: DocumentDraft; markdown: string } => {
    const at = iso(deps.now());
    return {
      draft: { id: deps.newId(), documentId, baseVersion, revision: 1, title, author, sizeBytes: markdown.length, sha256: `sha-${markdown.length}`, status: 'pending', createdAt: at, updatedAt: at },
      markdown,
    };
  };
  const saveVersion = (id: string, markdown: string): number => {
    const next = head(id) + 1;
    record(id).versions.set(next, markdown);
    const item = deps.library().find((entry) => entry.id === id) as LibraryItem;
    const at = iso(deps.now());
    item.version = next;
    item.updatedAt = at;
    item.versions = [...(item.versions ?? []), { version: next, name: item.name, mimeType: 'text/markdown', sizeBytes: markdown.length, createdAt: at }] as LibraryItem['versions'];
    return next;
  };
  const decide = (id: string, input: { draftId: string; expectedRevision: number }, status: 'approved' | 'declined') => {
    const open = record(id).draft;
    if (!open || open.draft.id !== input.draftId) throw apiError(404, 'NOT_FOUND', 'draft not found');
    if (open.draft.status === status) return open;
    if (open.draft.status !== 'pending' || open.draft.revision !== input.expectedRevision) throw apiError(409, 'DOCUMENT_DRAFT_CHANGED', 'The draft changed; reload it.');
    if (status === 'approved') open.draft.savedVersion = saveVersion(id, open.markdown);
    open.draft.status = status;
    open.draft.decidedAt = iso(deps.now());
    return open;
  };

  return {
    async create(input) {
      await deps.delay();
      const id = deps.newId();
      const at = iso(deps.now());
      const item: LibraryItem = { id, name: input.title, kind: 'document', render: 'doc', mimeType: 'text/markdown', sizeBytes: 0, shared: 'private', source: 'agent', tags: [], pinned: false, createdAt: at, updatedAt: at };
      deps.library().unshift(item);
      const entry: DocumentRecord = { versions: new Map() };
      records.set(id, entry);
      entry.draft = newDraft(id, input.title, input.markdown, 'person', 0);
      return view(id);
    },
    async get(id) {
      await deps.delay();
      record(id);
      return view(id);
    },
    async version(id, version) {
      await deps.delay();
      const markdown = record(id).versions.get(version);
      if (markdown === undefined) throw apiError(404, 'NOT_FOUND', 'version not found');
      return { version, markdown, sha256: `sha-${markdown.length}` };
    },
    async draft(id) {
      await deps.delay();
      const open = record(id).draft;
      if (!open || open.draft.status !== 'pending') throw apiError(404, 'NOT_FOUND', 'no open draft');
      return { draft: { ...open.draft }, markdown: open.markdown };
    },
    async saveDraft(id, input) {
      await deps.delay();
      const entry = record(id);
      const open = entry.draft?.draft.status === 'pending' ? entry.draft : undefined;
      if (open) {
        if (input.expectedRevision === undefined) throw apiError(400, 'VALIDATION', 'expectedRevision is required while a draft is open');
        if (open.draft.revision !== input.expectedRevision) throw apiError(409, 'DOCUMENT_DRAFT_CHANGED', 'The draft changed elsewhere.');
        open.draft = { ...open.draft, title: input.title, author: 'person', revision: open.draft.revision + 1, sizeBytes: input.markdown.length, updatedAt: iso(deps.now()) };
        open.markdown = input.markdown;
        return { draft: { ...open.draft }, markdown: open.markdown };
      }
      if (input.baseVersion === undefined || input.baseVersion !== head(id)) throw apiError(409, 'DOCUMENT_BASE_CHANGED', 'The document moved on.');
      entry.draft = newDraft(id, input.title, input.markdown, 'person', input.baseVersion);
      return { draft: { ...entry.draft.draft }, markdown: input.markdown };
    },
    async approve(id, input) {
      await deps.delay();
      decide(id, input, 'approved');
      return view(id);
    },
    async decline(id, input) {
      await deps.delay();
      decide(id, input, 'declined');
      return view(id);
    },
    async conversation(id, input) {
      await deps.delay();
      record(id);
      const conversation = await deps.openConversation(input.agentId);
      return { ...conversation, documentId: id };
    },
  };
}

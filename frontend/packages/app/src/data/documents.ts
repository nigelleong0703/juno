import type { Conversation, DocumentDraft, DocumentView } from "@agent-desktop/client";
import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";
import { qk } from "./keys";

/** A document and its open draft; the Markdown comes from `useDocumentDraft` / `useDocumentVersion`. */
export function useDocument(id: string, enabled = true) {
  const client = useClient();
  return useQuery({ queryKey: qk.document(id), queryFn: () => client.documents.get(id), enabled, retry: false });
}

/** The open draft's Markdown. Only asked for while the document has a pending draft. */
export function useDocumentDraft(id: string, enabled: boolean) {
  const client = useClient();
  return useQuery({ queryKey: qk.documentDraft(id), queryFn: () => client.documents.draft(id), enabled, retry: false, staleTime: Infinity });
}

/** The Markdown of one saved version (0 = the document has none yet, so there is nothing to ask for). */
export function useDocumentVersion(id: string, version: number, enabled = true) {
  const client = useClient();
  return useQuery({
    queryKey: qk.documentVersion(id, version),
    queryFn: () => client.documents.version(id, version),
    enabled: enabled && version >= 1,
    retry: false,
    staleTime: Infinity,
  });
}

/** `POST /v1/documents/:id/conversations`: the chat about this document with one agent. */
export function useDocumentConversation(id: string) {
  const client = useClient();
  return useMutation<Conversation, Error, string>({ mutationFn: (agentId) => client.documents.conversation(id, { agentId }) });
}

/** Whether a draft still waits for a decision. */
export function isOpenDraft(draft: DocumentDraft | undefined): draft is DocumentDraft {
  return draft?.status === "pending";
}

/**
 * `document.draft.updated`: replace the cached draft by id. A pending draft becomes the document's open draft; one that was
 * approved, declined or replaced closes it. A change of the draft also makes the cached Markdown stale.
 */
export function applyDocumentDraftEvent(qc: QueryClient, draft: DocumentDraft): void {
  qc.setQueryData<DocumentView>(qk.document(draft.documentId), (old) => {
    if (!old) return old;
    if (draft.status === "pending") return { ...old, draft };
    if (old.draft && old.draft.id !== draft.id) return old;
    const { draft: _closed, ...rest } = old;
    return rest;
  });
  void qc.invalidateQueries({ queryKey: qk.documentDraft(draft.documentId) });
}

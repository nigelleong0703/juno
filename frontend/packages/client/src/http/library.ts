import type { AuditApi, AuditListParams, LibraryApi, LibraryListParams } from '../contracts.js';
import type { Id, UploadInput } from '../contracts.js';
import { attachmentSchema, auditEntrySchema, fileDownloadSchema, libraryItemSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** Files in the library, plus the audit trail. */
/** The audit trail: the server filters by agent (`agentId`), run and action; paging as for every list. */
export function createAuditApi(http: HttpTransport): AuditApi {
  /** The filters the list and the CSV export share; paging only applies to the list. */
  const filters = (params?: Pick<AuditListParams, 'agentId' | 'initiator' | 'unattended'>): URLSearchParams => {
    const q = new URLSearchParams();
    if (params?.agentId) q.set('agentId', params.agentId);
    if (params?.initiator) q.set('initiator', params.initiator);
    if (params?.unattended !== undefined) q.set('unattended', String(params.unattended));
    return q;
  };
  return {
    async list(params?: AuditListParams) {
      const q = filters(params);
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      return http.list(`/v1/audit?${q.toString()}`, auditEntrySchema);
    },
    exportCsv(params) {
      return http.text(`/v1/audit/export.csv?${filters(params).toString()}`);
    },
  };
}

export function createLibraryApi(http: HttpTransport): LibraryApi {
  return {
    async list(params?: LibraryListParams) {
      const q = new URLSearchParams();
      if (params?.kind) q.set('kind', params.kind);
      if (params?.agentId) q.set('agentId', params.agentId);
      if (params?.conversationId) q.set('conversationId', params.conversationId);
      if (params?.shared) q.set('shared', params.shared);
      if (params?.source) q.set('source', params.source);
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      return http.list(`/v1/library?${q.toString()}`, libraryItemSchema);
    },

    async get(id: Id) {
      const data = await http.request(`/v1/library/${id}`, 'GET');
      return http.parse(libraryItemSchema, data);
    },

    async setPinned(id: Id, pinned: boolean) {
      const data = await http.request(`/v1/library/${id}/pinned`, 'POST', { pinned });
      return http.parse(libraryItemSchema, data);
    },

    async delete(id: Id): Promise<void> {
      await http.request(`/v1/library/${id}`, 'DELETE');
    },

    async download(id: Id) {
      const data = await http.request(`/v1/library/${id}/download`, 'GET');
      return http.parse(fileDownloadSchema, data);
    },

    async upload(input: UploadInput) {
      const data = await http.request('/v1/uploads', 'POST', input);
      return http.parse(attachmentSchema, data);
    },
  };
}


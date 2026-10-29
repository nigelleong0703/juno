import type { DocumentsApi, Id } from '../contracts.js';
import { conversationSchema, documentContentSchema, documentDraftContentSchema, documentViewSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** Documents (BACKEND 5.11a, contracts 0.70): an agent's draft waits for the owner's approval; the owner's own save is an approval. */
export function createDocumentsApi(http: HttpTransport): DocumentsApi {
  const base = (id: Id) => `/v1/documents/${encodeURIComponent(id)}`;
  return {
    async create(input) {
      return http.parse(documentViewSchema, await http.request('/v1/documents', 'POST', input));
    },

    async get(id) {
      return http.parse(documentViewSchema, await http.request(base(id), 'GET'));
    },

    async version(id, version) {
      return http.parse(documentContentSchema, await http.request(`${base(id)}/versions/${version}/content`, 'GET'));
    },

    async draft(id) {
      return http.parse(documentDraftContentSchema, await http.request(`${base(id)}/draft`, 'GET'));
    },

    async saveDraft(id, input) {
      return http.parse(documentDraftContentSchema, await http.request(`${base(id)}/draft`, 'PUT', input));
    },

    async approve(id, input) {
      return http.parse(documentViewSchema, await http.request(`${base(id)}/draft/approve`, 'POST', input));
    },

    async decline(id, input) {
      return http.parse(documentViewSchema, await http.request(`${base(id)}/draft/decline`, 'POST', input));
    },

    async conversation(id, input) {
      return http.parse(conversationSchema, await http.request(`${base(id)}/conversations`, 'POST', input));
    },
  };
}

import { z } from 'zod';
import type { MemoryItemsApi, PeopleApi } from '../contracts.js';
import {
  confirmRelationResultSchema,
  memoryItemViewSchema,
  memoryTopicViewSchema,
  personViewSchema,
  possibleMatchSchema,
} from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** The query string for a list call: only the parameters the caller set, in a stable order. */
function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) q.set(key, String(value));
  }
  const text = q.toString();
  return text ? `?${text}` : '';
}

const reviewSchema = z.object({ items: z.array(memoryItemViewSchema) });
const topicsSchema = z.object({ items: z.array(memoryTopicViewSchema) });

export function createPeopleApi(http: HttpTransport): PeopleApi {
  return {
    list(params) {
      return http.list(`/v1/people${query({ limit: params?.limit, cursor: params?.cursor })}`, personViewSchema);
    },

    possibleMatches(params) {
      return http.list(`/v1/people/possible-matches${query({ cursor: params?.cursor })}`, possibleMatchSchema);
    },

    async link(personId, accountId) {
      await http.request(`/v1/people/${encodeURIComponent(personId)}/link`, 'POST', { accountId });
    },

    async unlinkAccount(accountId) {
      await http.request(`/v1/accounts/${encodeURIComponent(accountId)}/unlink`, 'POST');
    },

    async rename(personId, name) {
      await http.request(`/v1/people/${encodeURIComponent(personId)}`, 'PATCH', { name });
    },

    async confirmRelation(relationId) {
      return http.parse(confirmRelationResultSchema, await http.request(`/v1/relations/${encodeURIComponent(relationId)}/confirm`, 'POST'));
    },

    async deleteRelation(relationId) {
      await http.request(`/v1/relations/${encodeURIComponent(relationId)}`, 'DELETE');
    },
  };
}

export function createMemoryItemsApi(http: HttpTransport): MemoryItemsApi {
  return {
    list(params) {
      return http.list(
        `/v1/memory/items${query({ about: params?.about, status: params?.status, topic: params?.topic, cursor: params?.cursor, limit: params?.limit })}`,
        memoryItemViewSchema,
      );
    },

    async topics() {
      return http.parse(topicsSchema, await http.request('/v1/memory/topics', 'GET'));
    },

    async review() {
      return http.parse(reviewSchema, await http.request('/v1/memory/review', 'GET'));
    },

    async update(id, patch) {
      await http.request(`/v1/memory/items/${encodeURIComponent(id)}`, 'PATCH', patch);
    },

    async delete(id) {
      await http.request(`/v1/memory/items/${encodeURIComponent(id)}`, 'DELETE');
    },

    async resolveReview(id, input) {
      await http.request(`/v1/memory/review/${encodeURIComponent(id)}`, 'POST', input);
    },
  };
}

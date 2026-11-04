import { z } from 'zod';
import type { OutboxApi } from '../contracts.js';
import { idSchema, outboxFreezeSchema, outboxListSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

const retriedSchema = z.object({ id: idSchema });

/** The outbox (BACKEND 5.7.11): deliveries to platform chats and phones, the owner's switch to pause them, and a retry for a dropped one. */
export function createOutboxApi(http: HttpTransport): OutboxApi {
  return {
    async list(query) {
      const q = new URLSearchParams();
      if (query?.status) q.set('status', query.status);
      if (query?.conversationId) q.set('conversationId', query.conversationId);
      if (query?.cursor) q.set('cursor', query.cursor);
      if (query?.limit) q.set('limit', String(query.limit));
      const qs = q.toString();
      return http.parse(outboxListSchema, await http.request(`/v1/outbox${qs ? `?${qs}` : ''}`, 'GET'));
    },

    async retry(id) {
      return http.parse(retriedSchema, await http.request(`/v1/outbox/${encodeURIComponent(id)}/retry`, 'POST'));
    },

    async freeze(input) {
      return http.parse(outboxFreezeSchema, await http.request('/v1/outbox/freeze', 'POST', input));
    },
  };
}

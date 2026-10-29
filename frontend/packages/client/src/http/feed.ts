import type { FeedApi, FeedListParams, InspirationApi } from '../contracts.js';
import type { FeedbackInput, Id } from '../contracts.js';
import { feedPostSchema, feedbackInputSchema, likeFeedPostInputSchema, todaySchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** The owner's feed: posts (filled by routines), feedback and the Today summary. */
export function createFeedApi(http: HttpTransport): FeedApi {
  return {
    async list(params?: FeedListParams) {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      if (params?.agentId) q.set('agentId', params.agentId);
      return http.list(`/v1/feed?${q.toString()}`, feedPostSchema);
    },

    async like(id: Id, liked: boolean) {
      const body = likeFeedPostInputSchema.parse({ liked });
      const data = await http.request(`/v1/feed/${id}/like`, 'POST', body);
      return http.parse(feedPostSchema, data);
    },

    async feedback(id: Id, input: FeedbackInput) {
      const body = feedbackInputSchema.parse(input);
      const data = await http.request(`/v1/feed/${id}/feedback`, 'POST', body);
      return http.parse(feedPostSchema, data);
    },

    async today() {
      const data = await http.request('/v1/today', 'GET');
      return http.parse(todaySchema, data);
    },
  };
}

/** Inspiration cards on Today and the Ideas tab: dismissing one keeps it from coming back. */
export function createInspirationApi(http: HttpTransport): InspirationApi {
  return {
    async dismiss(id: Id): Promise<void> {
      await http.request(`/v1/inspiration/${id}/dismiss`, 'POST', {});
    },
  };
}

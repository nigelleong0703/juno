import type { Id, SpaceHostedUpdate, SpacePublishHosted, SpacesApi } from '../contracts.js';
import { spaceHostedSchema, spaceOpenUrlSchema, spaceSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';
import { z } from 'zod';

const spaceListSchema = z.object({ items: z.array(spaceSchema) });

/**
 * Spaces (BACKEND §5.12): agent-built apps. `get` and `list` report status without waking the computer; `openUrl` signs a link.
 * Hosted sharing (option B): publish, change access, revoke; `hostedOpenUrl` signs the owner's own link into a hosted copy.
 */
export function createSpacesApi(http: HttpTransport): SpacesApi {
  return {
    async list() {
      return http.parse(spaceListSchema, await http.request('/v1/spaces', 'GET'));
    },

    async get(id: Id) {
      return http.parse(spaceSchema, await http.request(`/v1/spaces/${id}`, 'GET'));
    },

    async openUrl(id: Id) {
      return http.parse(spaceOpenUrlSchema, await http.request(`/v1/spaces/${id}/open-url`, 'POST'));
    },

    async publishHosted(id: Id, body?: SpacePublishHosted) {
      return http.parse(spaceHostedSchema, await http.request(`/v1/spaces/${id}/publish-hosted`, 'POST', body ?? {}));
    },

    async updateHosted(id: Id, body: SpaceHostedUpdate) {
      return http.parse(spaceHostedSchema, await http.request(`/v1/spaces/${id}/hosted`, 'PATCH', body));
    },

    async revokeHosted(id: Id) {
      await http.request(`/v1/spaces/${id}/hosted`, 'DELETE');
    },

    async hostedOpenUrl(id: Id) {
      return http.parse(spaceOpenUrlSchema, await http.request(`/v1/spaces/${id}/hosted/open-url`, 'POST'));
    },
  };
}

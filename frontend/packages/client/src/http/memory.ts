import type { MemoryApi } from '../contracts.js';
import { forgetMemoryResultSchema, memoryClaimsResultSchema, memorySearchResultSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** What the agents learned about the user: claims with evidence, forgetting, search. The memory files themselves go through the home API. */
export function createMemoryApi(http: HttpTransport): MemoryApi {
  return {
    async claims(params) {
      const q = params?.status === undefined ? '' : `?status=${params.status}`;
      return http.request(`/v1/memory/claims${q}`, 'GET', undefined, memoryClaimsResultSchema);
    },

    async forget(input) {
      return http.request('/v1/memory/forget', 'POST', input, forgetMemoryResultSchema);
    },

    async search(query) {
      return http.request(`/v1/memory/search?q=${encodeURIComponent(query)}`, 'GET', undefined, memorySearchResultSchema);
    },
  };
}

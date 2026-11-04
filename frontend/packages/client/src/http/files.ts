import type { FilesApi } from '../contracts.js';
import { fileHistorySchema, restoredFileSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** File history (BACKEND 5.2d): the kept earlier versions of a file an agent overwrote, and putting one back. */
export function createFilesApi(http: HttpTransport): FilesApi {
  return {
    async history(query) {
      const q = new URLSearchParams({ path: query.path, agentId: query.agentId });
      if (query.on) q.set('on', query.on);
      return http.parse(fileHistorySchema, await http.request(`/v1/files/history?${q.toString()}`, 'GET'));
    },

    async restore(input) {
      return http.parse(restoredFileSchema, await http.request('/v1/files/restore', 'POST', input));
    },
  };
}

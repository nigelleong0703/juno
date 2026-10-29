import { z } from 'zod';
import type { HomeApi } from '../contracts.js';
import { agentHomeFileSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

const homeListSchema = z.object({ files: z.array(agentHomeFileSchema) });

/** Encode a home path for a URL, keeping its slashes. */
const homeUrl = (path: string) => `/v1/home/${path.split('/').map(encodeURIComponent).join('/')}`;

/** The user's `/juno` home files (agent persona files, USER.md, ...). */
export function createHomeApi(http: HttpTransport): HomeApi {
  return {
    async list(prefix?: string) {
      const q = prefix === undefined ? '' : `?path=${encodeURIComponent(prefix)}`;
      return http.request(`/v1/home${q}`, 'GET', undefined, homeListSchema);
    },

    async write(path, input) {
      return http.request(homeUrl(path), 'PUT', input, agentHomeFileSchema);
    },

    async delete(path): Promise<void> {
      await http.request(homeUrl(path), 'DELETE');
    },
  };
}

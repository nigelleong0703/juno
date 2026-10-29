import { z } from 'zod';

import type { AppsApi } from '../contracts.js';
import {
  agentAppSchema,
  appDetailSchema,
  appSchema,
  appWorkspaceAgentSchema,
  installAppResponseSchema,
  probeCustomAppResponseSchema,
  reviewAppToolsResponseSchema,
} from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** The Apps page and the per-agent app switches: one install per account or workspace, then on or off per agent. */
export function createAppsApi(http: HttpTransport): AppsApi {
  const app = (id: string) => `/v1/apps/${encodeURIComponent(id)}`;
  return {
    // The route answers `{items}`; the page works with the plain list. An app this version cannot read (a value a newer server added) is left out, not the whole page.
    list: async () => (await http.list('/v1/apps', appSchema)).items,
    get: (id) => http.request(app(id), 'GET', undefined, appDetailSchema),
    install: (id, input) => http.request(`${app(id)}/install`, 'POST', input ?? {}, installAppResponseSchema),
    probeCustom: (url) => http.request('/v1/apps/custom/probe', 'POST', { url }, probeCustomAppResponseSchema),
    async removeInstallation(id, installationId) {
      await http.request(`${app(id)}/installations/${encodeURIComponent(installationId)}`, 'DELETE');
    },
    reviewTools: (id, input) => http.request(`${app(id)}/tools/review`, 'POST', input ?? {}, reviewAppToolsResponseSchema),
    setAgentApp: (agentId, appId, input) =>
      http.request(`/v1/agents/${encodeURIComponent(agentId)}/apps/${encodeURIComponent(appId)}`, 'PUT', input, agentAppSchema),
    // The route answers the workspace's agents as `{items}`.
    setWorkspaceAgent: async (id, installationId, agentId, input) =>
      (
        await http.request(
          `${app(id)}/installations/${encodeURIComponent(installationId)}/agents/${encodeURIComponent(agentId)}`,
          'PUT',
          input,
          z.object({ items: z.array(appWorkspaceAgentSchema) }),
        )
      ).items,
  };
}

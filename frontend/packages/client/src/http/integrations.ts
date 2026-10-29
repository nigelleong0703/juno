import { z } from 'zod';

import type { Id, ListResult, Plugin, PluginsApi, PluginsListParams, SecretMetadata, SetToolPermissionInput } from '../contracts.js';
import { pluginSchema, secretSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** Plugins (metadata and tool permissions), over the API-owned routes. Connectors and connections are apps now (`apps.ts`). */
export function createPluginsApi(http: HttpTransport): PluginsApi {
  return {
    async list(params?: PluginsListParams): Promise<ListResult<Plugin>> {
      const q = new URLSearchParams();
      if (params?.category) q.set('category', params.category);
      if (params?.installed !== undefined) q.set('installed', String(params.installed));
      if (params?.limit !== undefined) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      return http.list(`/v1/plugins?${q.toString()}`, pluginSchema);
    },
    async get(id: Id): Promise<Plugin> {
      const data = await http.request(`/v1/plugins/${id}`, 'GET');
      return http.parse(pluginSchema, data);
    },
    async install(id: Id): Promise<Plugin> {
      const data = await http.request(`/v1/plugins/${id}/install`, 'POST');
      return http.parse(pluginSchema, data);
    },
    async uninstall(id: Id): Promise<Plugin> {
      const data = await http.request(`/v1/plugins/${id}/uninstall`, 'POST');
      return http.parse(pluginSchema, data);
    },
    async setToolPermission(input: SetToolPermissionInput): Promise<Plugin> {
      const data = await http.request('/v1/plugins/tool-permission', 'POST', input);
      return http.parse(pluginSchema, data);
    },
    async secrets(): Promise<SecretMetadata[]> {
      const data = await http.request('/v1/plugins/secrets', 'GET');
      return http.parse(z.array(secretSchema), data);
    },
  };
}

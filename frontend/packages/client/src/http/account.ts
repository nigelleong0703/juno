import type { SettingsApi, UsageApi, UsageLedgerParams } from '../contracts.js';
import type { UpdateSettingsInput } from '../contracts.js';
import {
  appSettingsResponseSchema,
  modelCatalogSchema,
  usageLedgerSchema,
  usageSchema,
} from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** App settings, model catalog and usage. */
export function createSettingsApi(http: HttpTransport): SettingsApi {
  return {
    async get() {
      const data = await http.request(`/v1/settings`, 'GET');
      return http.parse(appSettingsResponseSchema, data);
    },

    async update(patch: UpdateSettingsInput) {
      const data = await http.request(`/v1/settings`, 'PATCH', patch);
      return http.parse(appSettingsResponseSchema, data);
    },

    async models() {
      const data = await http.request(`/v1/models`, 'GET');
      return http.parse(modelCatalogSchema, data);
    },
  };
}

export function createUsageApi(http: HttpTransport): UsageApi {
  return {
    async get() {
      const data = await http.request(`/v1/usage`, 'GET');
      return http.parse(usageSchema, data);
    },

    async ledger(params?: UsageLedgerParams) {
      const q = new URLSearchParams();
      if (params?.agentId) q.set('agentId', params.agentId);
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      const data = await http.request(`/v1/usage/ledger?${q.toString()}`, 'GET');
      return http.parse(usageLedgerSchema, data);
    },
  };
}

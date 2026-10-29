import type { RequestsApi, RequestsListParams, RunsApi, RunsListParams, TasksApi, TasksListParams } from '../contracts.js';
import type { Id, ListParams, ResolveRequestInput, SecureVaultKeys, SubmitSecureInput } from '../contracts.js';
import {
  agentTaskSchema,
  requestSchema,
  runSchema,
  secureInputResultSchema,
  secureVaultKeysSchema,
  stepSchema,
  taskTreeSchema,
} from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** Cursor pagination shared by every list endpoint. */
function setPagination(q: URLSearchParams, params?: ListParams): void {
  if (params?.limit) q.set('limit', String(params.limit));
  if (params?.cursor) q.set('cursor', params.cursor);
}

/** Agent runs and the requests (questions/approvals) that suspend them. */
export function createRunsApi(http: HttpTransport): RunsApi {
  return {
    async list(params?: RunsListParams) {
      const q = new URLSearchParams();
      setPagination(q, params);
      if (params?.status) q.set('status', params.status);
      if (params?.agentId) q.set('agentId', params.agentId);
      if (params?.conversationId) q.set('conversationId', params.conversationId);
      if (params?.kind) q.set('kind', params.kind);
      return http.list(`/v1/runs?${q.toString()}`, runSchema);
    },

    async get(id: Id) {
      const data = await http.request(`/v1/runs/${id}`, 'GET');
      return http.parse(runSchema, data);
    },

    async stop(id: Id) {
      const data = await http.request(`/v1/runs/${id}/stop`, 'POST');
      return http.parse(runSchema, data);
    },

    async markSeen(id: Id) {
      const data = await http.request(`/v1/runs/${id}/seen`, 'POST', {});
      return http.parse(runSchema, data);
    },

    async steps(id: Id, params?: ListParams) {
      const q = new URLSearchParams();
      setPagination(q, params);
      return http.list(`/v1/runs/${id}/steps?${q.toString()}`, stepSchema);
    },
  };
}

export function createRequestsApi(http: HttpTransport): RequestsApi {
  return {
    async list(params?: RequestsListParams) {
      const q = new URLSearchParams();
      setPagination(q, params);
      if (params?.status) q.set('status', params.status);
      if (params?.kind) q.set('kind', params.kind);
      if (params?.agentId) q.set('agentId', params.agentId);
      if (params?.category) q.set('category', params.category);
      if (params?.outcome) q.set('outcome', params.outcome);
      return http.list(`/v1/requests?${q.toString()}`, requestSchema);
    },

    async get(id: Id) {
      const data = await http.request(`/v1/requests/${id}`, 'GET');
      return http.parse(requestSchema, data);
    },

    async resolve(id: Id, decision: ResolveRequestInput) {
      const data = await http.request(`/v1/requests/${id}/resolve`, 'POST', decision);
      return http.parse(requestSchema, data);
    },

    async submitSecureInput(id: Id, input: SubmitSecureInput) {
      const data = await http.request(`/v1/requests/${id}/secure-input`, 'POST', input);
      return http.parse(secureInputResultSchema, data);
    },

    async secureVaultKeys() {
      return http.parse(secureVaultKeysSchema, await http.request('/v1/secure-vault/keys', 'GET'));
    },

    async setSecureVaultKeys(input: SecureVaultKeys) {
      return http.parse(secureVaultKeysSchema, await http.request('/v1/secure-vault/keys', 'PUT', input));
    },
  };
}

export function createTasksApi(http: HttpTransport): TasksApi {
  return {
    async list(params?: TasksListParams) {
      const q = new URLSearchParams();
      setPagination(q, params);
      for (const key of ['agentId', 'conversationId', 'kind', 'routineId', 'rootRunId', 'status'] as const) {
        const value = params?.[key];
        if (value) q.set(key, value);
      }
      return http.list(`/v1/tasks?${q.toString()}`, agentTaskSchema);
    },

    async tree(id: Id) {
      return http.parse(taskTreeSchema, await http.request(`/v1/tasks/${id}/tree`, 'GET'));
    },

    async stop(id: Id) {
      return http.parse(agentTaskSchema, await http.request(`/v1/tasks/${id}/stop`, 'POST'));
    },
  };
}

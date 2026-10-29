import { z } from 'zod';
import type { AgentsApi, AgentsListParams } from '../contracts.js';
import type {
  CreateAgentInput,
  Id,
  ListResult,
  PlanItem,
  UpdateAgentInput,
} from '../contracts.js';
import { agentSchema, agentTaskSchema, planItemSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** Agents resource. */
export function createAgentsApi(http: HttpTransport): AgentsApi {
  return {
    async list(params?: AgentsListParams) {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      return http.list(`/v1/agents?${q.toString()}`, agentSchema);
    },

    async get(id: Id) {
      const data = await http.request(`/v1/agents/${id}`, 'GET');
      return http.parse(agentSchema, data);
    },

    async tasks(id: Id) {
      return http.list(`/v1/agents/${id}/tasks`, agentTaskSchema);
    },

    async plans(id: Id): Promise<ListResult<PlanItem>> {
      return http.list(`/v1/agents/${id}/plans`, planItemSchema);
    },

    async create(input: CreateAgentInput) {
      const data = await http.request(`/v1/agents`, 'POST', input);
      return http.parse(agentSchema, data);
    },

    async update(id: Id, patch: UpdateAgentInput) {
      const data = await http.request(`/v1/agents/${id}`, 'PATCH', patch);
      return http.parse(agentSchema, data);
    },

    async delete(id: Id): Promise<void> {
      await http.request(`/v1/agents/${id}`, 'DELETE');
    },

    async pause(id: Id) {
      return http.parse(agentSchema, await http.request(`/v1/agents/${id}/pause`, 'POST'));
    },

    async resume(id: Id) {
      return http.parse(agentSchema, await http.request(`/v1/agents/${id}/resume`, 'POST'));
    },

    async stop(id: Id) {
      return http.parse(z.object({ stopped: z.number().int().min(0) }), await http.request(`/v1/agents/${id}/stop`, 'POST'));
    },

    async acceptRoleSuggestion(id: Id) {
      return http.parse(agentSchema, await http.request(`/v1/agents/${id}/role-suggestion/accept`, 'POST'));
    },

    async dismissRoleSuggestion(id: Id) {
      return http.parse(agentSchema, await http.request(`/v1/agents/${id}/role-suggestion/dismiss`, 'POST'));
    },
  };
}

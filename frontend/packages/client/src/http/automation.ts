import { z } from 'zod';
import type { AgentCalendarApi, AgentCalendarListParams, DelegationsApi, RoutinesApiWithWebhook, RoutinesListParams, RulesApi, RulesListParams } from '../contracts.js';
import type {
  UpdateAgentCalendarItem,
  CreateDelegationInput,
  CreateRoutineInput,
  CreateRuleInput,
  Id,
  ListParams,
  UpdateDelegationInput,
  UpdateRoutineInput,
  UpdateRuleInput,
} from '../contracts.js';
import { agentCalendarItemSchema, routineSchema, routineRunSchema, ruleSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

const calendarListSchema = z.object({ items: z.array(agentCalendarItemSchema) });
const routineWebhookSecretSchema = z.object({ url: z.string().min(1), secret: z.string().min(1) });

/** What the agents put in their own calendars: follow-ups, meetings and one-off tasks. */
export function createAgentCalendarApi(http: HttpTransport): AgentCalendarApi {
  return {
    async list(params?: AgentCalendarListParams) {
      const q = new URLSearchParams();
      if (params?.from) q.set('from', params.from);
      if (params?.to) q.set('to', params.to);
      if (params?.agentId) q.set('agentId', params.agentId);
      const data = await http.request(`/v1/calendar?${q.toString()}`, 'GET');
      return http.parse(calendarListSchema, data);
    },

    async update(id: Id, input: UpdateAgentCalendarItem) {
      const data = await http.request(`/v1/calendar/${id}`, 'PATCH', input);
      return http.parse(agentCalendarItemSchema, data);
    },

    async cancel(id: Id) {
      const data = await http.request(`/v1/calendar/${id}`, 'DELETE');
      return http.parse(agentCalendarItemSchema, data);
    },
  };
}

/** Schedules (routines) and the rules that guide agent behaviour. */
export function createRoutinesApi(http: HttpTransport): RoutinesApiWithWebhook {
  return {
    async list(params?: RoutinesListParams) {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      return http.list(`/v1/routines?${q.toString()}`, routineSchema);
    },

    async get(id: Id) {
      const data = await http.request(`/v1/routines/${id}`, 'GET');
      return http.parse(routineSchema, data);
    },

    async create(input: CreateRoutineInput) {
      const data = await http.request(`/v1/routines`, 'POST', input);
      return http.parse(routineSchema, data);
    },

    async update(id: Id, patch: UpdateRoutineInput) {
      const data = await http.request(`/v1/routines/${id}`, 'PATCH', patch);
      return http.parse(routineSchema, data);
    },

    async toggle(id: Id, enabled?: boolean) {
      const data = await http.request(`/v1/routines/${id}/toggle`, 'POST', { enabled });
      return http.parse(routineSchema, data);
    },

    async rotateWebhook(id: Id) {
      const data = await http.request(`/v1/routines/${id}/webhook`, 'POST');
      return http.parse(routineWebhookSecretSchema, data);
    },

    async delete(id: Id): Promise<void> {
      await http.request(`/v1/routines/${id}`, 'DELETE');
    },

    async runs(id: Id, params?: ListParams) {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      return http.list(`/v1/routines/${id}/runs?${q.toString()}`, routineRunSchema);
    },
  };
}

export function createRulesApi(http: HttpTransport): RulesApi {
  return {
    async list(params?: RulesListParams) {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      if (params?.agentId) q.set('agentId', params.agentId);
      if (params?.scope) q.set('scope', params.scope);
      if (params?.source) q.set('source', params.source);
      if (params?.enabled !== undefined) q.set('enabled', String(params.enabled));
      return http.list(`/v1/rules?${q.toString()}`, ruleSchema);
    },

    async create(input: CreateRuleInput) {
      const data = await http.request(`/v1/rules`, 'POST', input);
      return http.parse(ruleSchema, data);
    },

    async update(id: Id, patch: UpdateRuleInput) {
      const data = await http.request(`/v1/rules/${id}`, 'PATCH', patch);
      return http.parse(ruleSchema, data);
    },

    async delete(id: Id): Promise<void> {
      await http.request(`/v1/rules/${id}`, 'DELETE');
    },

    async acceptDraft(id: Id) {
      const data = await http.request(`/v1/rules/${id}/accept`, 'POST');
      return http.parse(ruleSchema, data);
    },

    async rejectDraft(id: Id): Promise<void> {
      await http.request(`/v1/rules/${id}/reject`, 'POST');
    },
  };
}

/** What an agent may decide alone (`/v1/delegations`): `Rule`s with `scope: 'delegation'`, created with limits. */
export function createDelegationsApi(http: HttpTransport): DelegationsApi {
  return {
    async list(params?: ListParams & { agentId?: Id }) {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      if (params?.agentId) q.set('agentId', params.agentId);
      return http.list(`/v1/delegations?${q.toString()}`, ruleSchema);
    },

    async create(input: CreateDelegationInput) {
      return http.parse(ruleSchema, await http.request(`/v1/delegations`, 'POST', input));
    },

    async update(id: Id, patch: UpdateDelegationInput) {
      return http.parse(ruleSchema, await http.request(`/v1/delegations/${id}`, 'PATCH', patch));
    },

    async revoke(id: Id): Promise<void> {
      await http.request(`/v1/delegations/${id}`, 'DELETE');
    },
  };
}

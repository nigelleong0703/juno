import { z } from 'zod';
import type { GoalsApi, GoalsListParams, IdeasApi, IdeasListParams, MealsApi, MealsListParams, ProactiveApi } from '../contracts.js';
import type { CreateGoalInput, Id, ProactiveFeedbackInput, UpdateGoalInput } from '../contracts.js';
import { goalSchema, ideaSchema, mealSchema, proactiveFeedbackResultSchema, proactiveRuleSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** Goals the agents keep for the user, and the ideas they offer. */
export function createGoalsApi(http: HttpTransport): GoalsApi {
  return {
    async list(params?: GoalsListParams) {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      if (params?.agentId) q.set('agentId', params.agentId);
      if (params?.status) q.set('status', params.status);
      return http.list(`/v1/goals?${q.toString()}`, goalSchema);
    },

    async get(id: Id) {
      const data = await http.request(`/v1/goals/${id}`, 'GET');
      return http.parse(goalSchema, data);
    },

    async create(input: CreateGoalInput) {
      const data = await http.request('/v1/goals', 'POST', input);
      return http.parse(goalSchema, data);
    },

    async update(id: Id, patch: UpdateGoalInput) {
      const data = await http.request(`/v1/goals/${id}`, 'PATCH', patch);
      return http.parse(goalSchema, data);
    },

    async check(id: Id) {
      const data = await http.request(`/v1/goals/${id}/check`, 'POST');
      return http.parse(z.object({ queued: z.boolean() }), data);
    },

    async delete(id: Id): Promise<void> {
      await http.request(`/v1/goals/${id}`, 'DELETE');
    },
  };
}

export function createIdeasApi(http: HttpTransport): IdeasApi {
  return {
    async list(params?: IdeasListParams) {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      if (params?.agentId) q.set('agentId', params.agentId);
      if (params?.status) q.set('status', params.status);
      return http.list(`/v1/ideas?${q.toString()}`, ideaSchema);
    },

    async accept(id: Id) {
      const data = await http.request(`/v1/ideas/${id}/accept`, 'POST');
      return http.parse(ideaSchema, data);
    },

    async dismiss(id: Id) {
      const data = await http.request(`/v1/ideas/${id}/dismiss`, 'POST');
      return http.parse(ideaSchema, data);
    },
  };
}

/** What the agents may message about unprompted: button feedback and the owner's rules. */
export function createProactiveApi(http: HttpTransport): ProactiveApi {
  return {
    async feedback(input: ProactiveFeedbackInput) {
      const data = await http.request('/v1/proactive/feedback', 'POST', input);
      return http.parse(proactiveFeedbackResultSchema, data);
    },

    async listRules() {
      const data = await http.request('/v1/proactive/rules', 'GET');
      return http.parse(z.object({ items: z.array(proactiveRuleSchema) }), data);
    },

    async deleteRule(id: Id) {
      await http.request(`/v1/proactive/rules/${id}`, 'DELETE');
      return {};
    },

    async keepRule(id: Id) {
      const data = await http.request(`/v1/proactive/rules/${id}`, 'PATCH', { keep: true });
      return http.parse(proactiveRuleSchema, data);
    },
  };
}

/** The food diary the agent keeps, newest meal first. */
export function createMealsApi(http: HttpTransport): MealsApi {
  return {
    async list(params?: MealsListParams) {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      if (params?.from) q.set('from', params.from);
      if (params?.to) q.set('to', params.to);
      return http.list(`/v1/meals?${q.toString()}`, mealSchema);
    },
  };
}

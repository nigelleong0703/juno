import { z } from 'zod';
import type { SkillsApi, SkillsListParams } from '../contracts.js';
import type { CreateSkillInput, Id, UpdateSkillInput } from '../contracts.js';
import { skillSchema, skillVersionSchema } from '../contracts.js';
import type { HttpTransport } from './transport.js';

const versionsSchema = z.object({ items: z.array(z.unknown()) });

/** Reusable skills. Every content change is a new version; activate and rollback only move the active pointer. */
export function createSkillsApi(http: HttpTransport): SkillsApi {
  return {
    async list(params?: SkillsListParams) {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      return http.list(`/v1/skills?${q.toString()}`, skillSchema);
    },

    async get(id: Id) {
      const data = await http.request(`/v1/skills/${id}`, 'GET');
      return http.parse(skillSchema, data);
    },

    async create(input: CreateSkillInput) {
      const data = await http.request(`/v1/skills`, 'POST', input);
      return http.parse(skillSchema, data);
    },

    async update(id: Id, input: UpdateSkillInput) {
      const data = await http.request(`/v1/skills/${id}`, 'PUT', input);
      return http.parse(skillSchema, data);
    },

    /** Newest first, as the server returns them. */
    async versions(id: Id) {
      const data = await http.request(`/v1/skills/${id}/versions`, 'GET', undefined, versionsSchema);
      return data.items.map((item) => http.parse(skillVersionSchema, item));
    },

    async activate(id: Id, version: number) {
      const data = await http.request(`/v1/skills/${id}/versions/${version}/activate`, 'POST');
      return http.parse(skillSchema, data);
    },

    async rollback(id: Id) {
      const data = await http.request(`/v1/skills/${id}/rollback`, 'POST');
      return http.parse(skillSchema, data);
    },
  };
}


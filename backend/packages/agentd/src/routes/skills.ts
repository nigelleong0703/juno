/**
 * Versioned skills (memory-graph design §7.2). A skill is a definition with an active version; an edit is a new version; activate and
 * rollback move the pointer. Refusals carry the skill store's stable code and map to a 4xx. Without Postgres there is no skill store, and
 * these routes answer 503 rather than pretend.
 */
import { type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Context } from 'hono';
import type { Skill, SkillVersion } from '@agent-desktop/public-contracts';
import { createSkillInputSchema, updateSkillInputSchema } from '@agent-desktop/public-contracts';
import { SkillError, type SkillView, type SkillVersion as StoredVersion, type SkillsService } from '@agent-desktop/memory-graph/skills';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { docOwnerId } from './relationships.js';

export function toSkill(view: SkillView): Skill {
  return {
    id: view.def.id,
    scope: view.def.scope,
    agentId: view.def.agentId,
    active: view.active === null ? null : toVersion(view.active),
    createdAt: view.def.createdAt,
  };
}

export function toVersion(version: StoredVersion): SkillVersion {
  return {
    id: version.id,
    skillId: version.skillId,
    version: version.version,
    status: version.status,
    name: version.name,
    description: version.description,
    instructions: version.instructions,
    deps: version.deps,
    origin: version.origin,
    used: version.used,
    helpful: version.helpful,
    harmful: version.harmful,
    lastUsedAt: version.lastUsedAt,
    createdAt: version.createdAt,
  };
}

const STATUS: Record<string, number> = {
  SKILL_NOT_FOUND: 404,
  SKILL_VERSION_NOT_FOUND: 404,
  SKILL_NO_PREVIOUS_VERSION: 409,
  SKILL_INVALID: 422,
};

/** A skill store refusal as the wire error: its code and message, with the status it maps to. */
function refusal(c: Context, error: unknown) {
  if (!(error instanceof SkillError)) throw error;
  return c.json({ error: { code: error.code, message: error.message } }, (STATUS[error.code] ?? 400) as 400);
}

const versionParams = z.object({ v: z.coerce.number().int().min(1) });

export function registerSkills(app: Hono, deps: AgentdDeps) {
  /** The skill store, or the 503 answer when this process has no Postgres. */
  const store = (c: Context): SkillsService | Response => {
    if (deps.skills === undefined) return c.json({ error: { code: 'SKILLS_UNAVAILABLE', message: 'Skills need Postgres' } }, 503);
    return deps.skills;
  };

  app.get('/v1/skills', async (c) => {
    const skills = store(c);
    if (!('list' in skills)) return skills;
    const items = (await skills.list(getOwnerId(c))).map(toSkill);
    return c.json({ items });
  });

  app.get('/v1/skills/:id', async (c) => {
    const skills = store(c);
    if (!('list' in skills)) return skills;
    const view = await skills.get(getOwnerId(c), c.req.param('id'));
    if (view === null) return c.json({ error: { code: 'SKILL_NOT_FOUND', message: 'No skill ' + c.req.param('id') + '.' } }, 404);
    return c.json(toSkill(view));
  });

  app.post('/v1/skills', zValidator('json', createSkillInputSchema), async (c) => {
    const skills = store(c);
    if (!('list' in skills)) return skills;
    const input = c.req.valid('json');
    const ownerId = getOwnerId(c);
    if (input.agentId !== undefined) {
      const agent = await deps.store.get('agents', input.agentId);
      // Another owner's agent is indistinguishable from a missing one.
      if (agent === null || docOwnerId(agent) !== ownerId) return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'No agent ' + input.agentId + '.' } }, 404);
    }
    try {
      return c.json(toSkill(await skills.create(ownerId, input)), 201);
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.put('/v1/skills/:id', zValidator('json', updateSkillInputSchema), async (c) => {
    const skills = store(c);
    if (!('list' in skills)) return skills;
    try {
      return c.json(toSkill(await skills.edit(getOwnerId(c), c.req.param('id'), c.req.valid('json'))));
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.get('/v1/skills/:id/versions', async (c) => {
    const skills = store(c);
    if (!('list' in skills)) return skills;
    try {
      return c.json({ items: (await skills.versions(getOwnerId(c), c.req.param('id'))).map(toVersion) });
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.post('/v1/skills/:id/versions/:v/activate', async (c) => {
    const skills = store(c);
    if (!('list' in skills)) return skills;
    const parsed = versionParams.safeParse({ v: c.req.param('v') });
    if (!parsed.success) return c.json({ error: { code: 'SKILL_INVALID', message: 'The version must be a positive number.' } }, 422);
    try {
      return c.json(toSkill(await skills.activate(getOwnerId(c), c.req.param('id'), parsed.data.v)));
    } catch (error) {
      return refusal(c, error);
    }
  });

  app.post('/v1/skills/:id/rollback', async (c) => {
    const skills = store(c);
    if (!('list' in skills)) return skills;
    try {
      return c.json(toSkill(await skills.rollback(getOwnerId(c), c.req.param('id'))));
    } catch (error) {
      return refusal(c, error);
    }
  });
}

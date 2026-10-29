import { randomUUID } from 'node:crypto';
import { type Context, type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Agent, CreateAgentInput } from '@agent-desktop/public-contracts';
import { createAgentInputSchema, updateAgentInputSchema } from '@agent-desktop/public-contracts';
import { createLogger } from '@agent-desktop/log';
import { seedAgentFiles } from 'juno-agent/modules/home/service';
import { onboardNewAgent } from 'juno-agent/modules/onboarding';
import { emitAgentStatus, withLiveStatus } from 'juno-agent/execution/agent-status';
import { meaningfulRole } from 'juno-agent/execution/brain/social-format';
import { reconcileOwner } from 'juno-agent/modules/tasks/routines/capability-gate';
import { agentNameTaken, agentNameTakenMessage, freshAgentName } from 'juno-agent/modules/tools/tools/relationPolicy';
import type { SkillsService } from '@agent-desktop/memory-graph/skills';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { detachAgentFromComputer } from './computer-projection.js';
import { deleteConversationCascade } from './conversation-delete.js';
import { stopAgentRuns } from './runs.js';
import { gateDeps } from './routines.js';
import { canMutateAgent, docOwnerId, isAgentVisible, listAll, paginateFiltered } from './relationships.js';

/** Transactional mutation outcome: success carries the saved agent, rejection carries the error. */
type AgentMutationOutcome =
  | { status: 200; agent: Agent }
  | { status: 404; code: string; message: string };

/** Every selected skill must be one of the owner's skill definitions (any version state); returns the first offender. Without a skill store none is. */
async function unavailableSkill(skills: SkillsService | undefined, ownerId: string, skillIds: string[]): Promise<string | null> {
  for (const skillId of skillIds) {
    if (skills === undefined || !(await skills.exists(ownerId, skillId))) return skillId;
  }
  return null;
}

function skillUnavailable(skillId: string): { error: { code: string; message: string } } {
  return { error: { code: 'SKILL_NOT_AVAILABLE', message: 'Skill ' + skillId + ' is not available' } };
}

const log = createLogger({ service: 'agentd' });

/**
 * The one way an agent is created (the route and the new-account default agent): the saved agent, or the refusal with its status.
 * The new agent is woken once to speak first in its direct chat with the owner (BACKEND §8.7); `account` is the sign-up's first agent,
 * which also gets the once-per-account onboarding skill.
 */
export async function createAgent(
  deps: AgentdDeps, ownerId: string, input: CreateAgentInput, onboarding: { account: boolean } = { account: false },
): Promise<{ agent: Agent } | { error: { code: string; message: string }; status: 400 | 403 | 404 | 409 }> {
  const skillIds = [...new Set(input.skillIds ?? [])];
  const badSkill = await unavailableSkill(deps.skills, ownerId, skillIds);
  if (badSkill !== null) return { ...skillUnavailable(badSkill), status: 400 as const };
  // No name given (a blank new agent): the owner's first unused name from the short list. A given name that is taken is refused.
  if (input.name !== undefined && (await agentNameTaken(deps.store, ownerId, input.name))) return { error: { code: 'AGENT_NAME_TAKEN', message: agentNameTakenMessage(input.name) }, status: 409 };
  const name = input.name ?? (await freshAgentName(deps.store, ownerId));
  const now = new Date().toISOString();
  const agent: Agent & { ownerId: string } = {
    // Random, not a timestamp: two agents created in the same millisecond must not share an id.
    id: 'agt-' + randomUUID(),
    name,
    handle: input.handle || name.toLowerCase().replace(/\s+/g, '-'),
    avatar: input.avatar || { shape: 'circle', color: 1, eyes: 'dot' },
    title: input.title || 'New agent',
    ...(input.maxSubTasks === undefined ? {} : { maxSubTasks: input.maxSubTasks }),
    ...(input.permissionTiers === undefined ? {} : { permissionTiers: input.permissionTiers }),
    status: 'idle',
    section: input.section || 'Inbox',
    pinned: false,
    lastActivity: 'Just created',
    unreadCount: 0,
    channels: [{ kind: 'chat', status: 'connected', detail: 'In-app chat', audience: 'You' }],
    // Only after the owner paired a Mac and turned it on for this agent.
    macAccess: false,
    skillIds,
    pluginIds: input.pluginIds || [],
    sharing: { publishedToTeam: false },
    createdBy: ownerId,
    ownerId,
    createdAt: now,
    updatedAt: now,
  };
  const created = await deps.store.put('agents', agent);
  // The initial texts become the agent's home files (BACKEND §5.4); they reach the computer on the next sync.
  await seedAgentFiles(deps.store, ownerId, created.id, input);
  await deps.store.emit({ type: 'agent.created', agent: created });
  // The user now has something to remember from: start their hidden memory schedule (a no-op when it already runs).
  void deps.enqueuer.scheduleMemoryJobs?.(ownerId);
  // The greeting never undoes the creation: the agent exists either way and the owner can open its chat.
  await onboardNewAgent(deps, ownerId, created, onboarding).catch((error: unknown) => log.warn({ err: error, agentId: created.id }, 'onboarding wake failed'));
  return { agent: created };
}

export function registerAgents(app: Hono, deps: AgentdDeps) {
  /** The agent when the requester owns it; another owner's agent is indistinguishable from a missing one. */
  async function ownedAgent(c: Context): Promise<Agent | null> {
    const agent = await deps.store.get('agents', c.req.param('id') ?? '');
    return agent && canMutateAgent(agent, getOwnerId(c)) ? agent : null;
  }

  function notFound(c: Context) {
    return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent ' + c.req.param('id') + ' not found' } }, 404);
  }

  async function setPaused(c: Context, paused: boolean) {
    const agent = await ownedAgent(c);
    if (!agent) return notFound(c);
    const now = new Date().toISOString();
    const saved = await deps.store.tx(async (store) => {
      const next: Agent = { ...agent, updatedAt: now };
      if (paused) next.pausedAt = agent.pausedAt ?? now;
      else delete next.pausedAt;
      const stored = await store.put('agents', next);
      await store.emit({ type: 'agent.updated', agent: await withLiveStatus(store, stored) });
      await emitAgentStatus(store, stored.id);
      return stored;
    });
    return c.json(await withLiveStatus(deps.store, saved));
  }

  app.get('/v1/agents', async (c) => {
    const ownerId = getOwnerId(c);
    const query = c.req.query();
    const loaded = await listAll(deps.store, 'agents');
    if (loaded.truncated) {
      return c.json({ error: { code: 'LIST_TRUNCATED', message: 'Agent list truncated; retry later' } }, 500);
    }
    const visible: Agent[] = [];
    for (const agent of loaded.items) {
      if (isAgentVisible(agent, ownerId)) visible.push(agent);
    }
    // Creation order, explicitly: ids are random now, so id order is no longer creation order.
    visible.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const page = paginateFiltered(visible, query['limit'], query['cursor']);
    const items = await Promise.all(page.items.map((agent) => withLiveStatus(deps.store, agent)));
    return c.json({ items, nextCursor: page.nextCursor ?? null });
  });

  app.get('/v1/agents/:id', async (c) => {
    const ownerId = getOwnerId(c);
    const agent = await deps.store.get('agents', c.req.param('id'));
    if (!agent) {
      return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent ' + c.req.param('id') + ' not found' } }, 404);
    }
    if (!isAgentVisible(agent, ownerId)) {
      return c.json({ error: { code: 'AGENT_FORBIDDEN', message: 'Agent not shared with you' } }, 403);
    }
    return c.json(await withLiveStatus(deps.store, agent));
  });

  app.post(
    '/v1/agents',
    zValidator('json', createAgentInputSchema),
    async (c) => {
      const result = await createAgent(deps, getOwnerId(c), c.req.valid('json'));
      if ('error' in result) return c.json({ error: result.error }, result.status);
      return c.json(result.agent, 201);
    }
  );

  app.patch(
    '/v1/agents/:id',
    zValidator('json', updateAgentInputSchema.optional()),
    async (c) => {
      const ownerId = getOwnerId(c);
      const existing = await deps.store.get('agents', c.req.param('id'));
      if (!existing) {
        return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent ' + c.req.param('id') + ' not found' } }, 404);
      }
      if (!canMutateAgent(existing, ownerId)) {
        return c.json({ error: { code: 'AGENT_FORBIDDEN', message: 'Only the owning user may edit this agent' } }, 403);
      }
      const patch = c.req.valid('json') || {};
      const agentId = c.req.param('id');
      // Per-agent model/engine selection is removed: every Run resolves the
      // shared pi engine and models come from the account selection. Legacy
      // keys are rejected honestly instead of silently ignored.
      if (Object.hasOwn(patch, 'model') || Object.hasOwn(patch, 'engine')) {
        return c.json(
          { error: { code: 'AGENT_CONFIG_REMOVED', message: 'Per-agent model/engine selection is removed' } },
          400,
        );
      }
      // Turning on Mac access needs a paired Mac (My Mac); turning it off never does.
      if (patch.macAccess === true && existing.macAccess !== true) {
        const mac = await deps.computerd?.macStatus(new AbortController().signal).catch(() => undefined);
        if (mac?.paired !== true) {
          return c.json({ error: { code: 'MAC_NOT_PAIRED', message: 'Pair your Mac in the Juno desktop app (Settings > My Mac) first' } }, 409);
        }
      }
      if (patch.skillIds !== undefined) {
        const badSkill = await unavailableSkill(deps.skills, ownerId, [...new Set(patch.skillIds)]);
        if (badSkill !== null) return c.json(skillUnavailable(badSkill), 400);
      }
      if (patch.name !== undefined && (await agentNameTaken(deps.store, ownerId, patch.name, agentId))) {
        return c.json({ error: { code: 'AGENT_NAME_TAKEN', message: agentNameTakenMessage(patch.name) } }, 409);
      }
      const outcome: AgentMutationOutcome = await deps.store.tx(async (store): Promise<AgentMutationOutcome> => {
        const current = await store.get('agents', agentId);
        if (!current) {
          return { status: 404, code: 'AGENT_NOT_FOUND', message: 'Agent ' + agentId + ' not found' };
        }
        const now = new Date().toISOString();
        const merged: Agent = {
          ...current,
          ...patch,
          ...(patch.permissionTiers === undefined ? {} : { permissionTiers: { ...current.permissionTiers, ...patch.permissionTiers } }),
          // Legacy per-agent config rows stay readable: the spread above keeps the stored
          // model/engine values as-is (patches never carry them) and the runtime ignores them.
          sharing: {
            publishedToTeam: patch.sharing?.publishedToTeam ?? current.sharing.publishedToTeam,
            templateSlug: patch.sharing?.templateSlug ?? current.sharing.templateSlug,
          },
          updatedAt: now,
        };
        // A dismissal lasts until a real role falls back to the default (BACKEND §10.11); other edits keep it.
        if (meaningfulRole(current.title) !== undefined && meaningfulRole(merged.title) === undefined) delete merged.roleSuggestionDismissedAt;
        // A role the user sets by hand supersedes a pending suggestion.
        if (patch.title !== undefined && meaningfulRole(merged.title) !== undefined) delete merged.roleSuggestion;
        const saved = await store.put('agents', merged);
        // The event and the response carry the derived status, not the stored one.
        const live = await withLiveStatus(store, saved);
        await store.emit({ type: 'agent.updated', agent: live });
        return { status: 200, agent: live };
      });
      if (outcome.status !== 200) {
        return c.json({ error: { code: outcome.code, message: outcome.message } }, outcome.status);
      }
      // Allowing the Mac may be exactly what a Connect card in the agent's chat was waiting for.
      if (patch.macAccess === true) await reconcileOwner(gateDeps(deps), getOwnerId(c)).catch(() => undefined);
      return c.json(outcome.agent, 200);
    }
  );

  /** Pause: no automation-origin run starts while paused (the Session admission drops those wakes). */
  app.post('/v1/agents/:id/pause', (c) => setPaused(c, true));
  app.post('/v1/agents/:id/resume', (c) => setPaused(c, false));

  /**
   * Accept the suggested role (BACKEND §10.11): the suggestion's title becomes the agent title, its
   * description fills an empty description only, and the suggestion is cleared.
   */
  app.post('/v1/agents/:id/role-suggestion/accept', async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return notFound(c);
    if (!agent.roleSuggestion) {
      return c.json({ error: { code: 'ROLE_SUGGESTION_NOT_FOUND', message: 'Agent ' + agent.id + ' has no role suggestion' } }, 404);
    }
    const outcome = await deps.store.tx(async (store): Promise<AgentMutationOutcome> => {
      const current = await store.get('agents', agent.id);
      if (!current || !current.roleSuggestion) {
        return { status: 404, code: 'ROLE_SUGGESTION_NOT_FOUND', message: 'Agent ' + agent.id + ' has no role suggestion' };
      }
      const { roleSuggestion } = current;
      const next: Agent = {
        ...current,
        title: roleSuggestion.title,
        ...(current.description ? {} : { description: roleSuggestion.description }),
        updatedAt: new Date().toISOString(),
      };
      delete next.roleSuggestion;
      const stored = await store.put('agents', next);
      const live = await withLiveStatus(store, stored);
      await store.emit({ type: 'agent.updated', agent: live });
      return { status: 200, agent: live };
    });
    if (outcome.status !== 200) return c.json({ error: { code: outcome.code, message: outcome.message } }, outcome.status);
    return c.json(outcome.agent);
  });

  /** Dismiss the suggested role: clears it and never suggests again while the title stays unset. Idempotent. */
  app.post('/v1/agents/:id/role-suggestion/dismiss', async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return notFound(c);
    const saved = await deps.store.tx(async (store) => {
      const current = await store.get('agents', agent.id);
      if (!current) return null;
      const now = new Date().toISOString();
      const next: Agent = { ...current, roleSuggestionDismissedAt: current.roleSuggestionDismissedAt ?? now, updatedAt: now };
      delete next.roleSuggestion;
      const stored = await store.put('agents', next);
      const live = await withLiveStatus(store, stored);
      await store.emit({ type: 'agent.updated', agent: live });
      return live;
    });
    if (saved === null) return notFound(c);
    return c.json(saved);
  });

  /** Stop every active run of the agent (children included) through the per-run stop path. */
  app.post('/v1/agents/:id/stop', async (c) => {
    const agent = await ownedAgent(c);
    if (!agent) return notFound(c);
    return c.json({ stopped: await stopAgentRuns(deps, agent.id) });
  });

  app.delete('/v1/agents/:id', async (c) => {
    const deleted = await deleteAgentCascade(deps, getOwnerId(c), c.req.param('id'));
    if (!deleted.ok) return c.json({ error: { code: deleted.code, message: deleted.message } }, deleted.status);
    return c.json({});
  });
}

export type AgentDeleteResult =
  | { ok: true }
  | { ok: false; status: 403 | 404 | 409 | 500 | 502; code: string; message: string };

/**
 * Delete one agent for its owner: its direct chat (live runs stopped first), goals, ideas, calendar, feed posts, routines and
 * home mirror, then the agent, then `agent.deleted` so every open device drops it. The route and account deletion both come here.
 */
export async function deleteAgentCascade(deps: AgentdDeps, ownerId: string, agentId: string): Promise<AgentDeleteResult> {
  const existing = await deps.store.get('agents', agentId);
  if (!existing) {
    return { ok: false, status: 404, code: 'AGENT_NOT_FOUND', message: 'Agent ' + agentId + ' not found' };
  }
  if (!canMutateAgent(existing, ownerId)) {
    return { ok: false, status: 403, code: 'AGENT_FORBIDDEN', message: 'Only the owning user may delete this agent' };
  }
  const loaded = await listAll(deps.store, 'conversations');
  if (loaded.truncated) {
    return { ok: false, status: 500, code: 'LIST_TRUNCATED', message: 'Conversation list truncated; retry later' };
  }
  for (const conv of loaded.items) {
    if (conv.kind !== 'direct') continue;
    if (conv.agentIds.length !== 1 || conv.agentIds[0] !== agentId) continue;
    if (docOwnerId(conv) !== ownerId) continue;
    const cascade = await deleteConversationCascade(deps, ownerId, conv.id);
    if (!cascade.ok && cascade.status !== 404) return cascade;
  }
  // The agent's goals, ideas and feed posts go with it; nothing else points at them.
  for (const goal of (await listAll(deps.store, 'goals')).items) {
    if (goal.agentId === agentId) await deps.store.delete('goals', goal.id);
  }
  for (const idea of (await listAll(deps.store, 'ideas')).items) {
    if (idea.agentId === agentId) await deps.store.delete('ideas', idea.id);
  }
  for (const item of (await listAll(deps.store, 'agentCalendar')).items) {
    if (item.agentId !== agentId) continue;
    await deps.store.delete('agentCalendar', item.id);
    await deps.enqueuer.scheduleCalendarItem?.(item.id);
  }
  for (const post of (await listAll(deps.store, 'feedPosts')).items) {
    if (post.agentId === agentId) await deps.store.delete('feedPosts', post.id);
  }
  // Its routines go too, so no timer wakes a deleted agent (a stray fire also checks the agent exists).
  for (const routine of (await listAll(deps.store, 'routines')).items) {
    if (routine.agentId !== agentId) continue;
    await deps.store.delete('routines', routine.id);
    await deps.store.delete('monitorState', routine.id);
  }
  for (const row of (await listAll(deps.store, 'agentHome')).items) {
    if (row.agentId === agentId) await deps.store.delete('agentHome', row.id);
  }
  await detachAgentFromComputer(deps.store, agentId);
  await deps.store.delete('agents', agentId);
  await deps.store.emit({ type: 'agent.deleted', agentId });
  return { ok: true };
}

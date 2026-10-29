/**
 * `POST /v1/onboarding/start` (BACKEND §8.7): called by the API when an account is created. The new account gets its default
 * agent and that agent's direct chat, and the agent is woken once to speak first. Safe to repeat: once the owner has a visible agent
 * it creates nothing.
 */
import { randomUUID } from 'node:crypto';
import { type Hono } from 'hono';
import { createAgentInputSchema, profileIdFor } from '@agent-desktop/public-contracts';
import { goalConversationId } from 'juno-agent/modules/goals/checkin';
import { retryOnboarding } from 'juno-agent/modules/onboarding';
import { OWNER_FALLBACK_NAME } from 'juno-agent/modules/memory/owner';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { createAgent } from './agents.js';
import { isAgentVisible, listAll } from './relationships.js';

const DEFAULT_AGENT = createAgentInputSchema.parse({ name: 'Juno' });

export function registerOnboarding(app: Hono, deps: AgentdDeps): void {
  app.post('/v1/onboarding/start', async (c) => {
    const ownerId = getOwnerId(c);
    // The sign-up name (the account's display name, also the profile's "Name" entry) is the owner's person's name (BACKEND §9.5).
    const body: unknown = await c.req.json().catch(() => null);
    const name = typeof body === 'object' && body !== null && 'name' in body && typeof (body as { name: unknown }).name === 'string' ? (body as { name: string }).name.trim().slice(0, 100) : '';
    if (deps.memory !== undefined) await deps.memory.people.ensureOwner(ownerId, name === '' ? OWNER_FALLBACK_NAME : name);
    const agents = (await listAll(deps.store, 'agents')).items;
    for (const agent of agents) if (isAgentVisible(agent, ownerId)) return c.json({});
    if (name !== '') {
      const at = new Date().toISOString();
      await deps.store.put('profiles', { entries: [{ id: randomUUID(), key: 'Name', value: name, visibility: 'private', source: { by: 'user', at } }], id: profileIdFor(ownerId), updatedAt: at });
    }
    // createAgent opens the agent's direct chat and wakes it to speak first, with the once-per-account skill as well.
    const created = await createAgent(deps, ownerId, DEFAULT_AGENT, { account: true });
    if ('error' in created) return c.json({ error: created.error }, created.status);
    return c.json({ agentId: created.agent.id, conversationId: await goalConversationId(deps.store, ownerId, created.agent) });
  });

  // The owner chose their model: a still-new account whose greeting could not run gets it again.
  app.post('/v1/onboarding/model-chosen', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const providerId = typeof body === 'object' && body !== null && 'providerId' in body ? (body as { providerId: unknown }).providerId : undefined;
    if (typeof providerId !== 'string' || providerId === '') return c.json({ error: { code: 'INVALID_REQUEST', message: 'providerId is required' } }, 400);
    await retryOnboarding(deps, getOwnerId(c), providerId);
    return c.json({});
  });
}

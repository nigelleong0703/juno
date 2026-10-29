import { randomUUID } from 'node:crypto';
import { type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { NotFoundError } from '@agent-desktop/contracts';
import { createRuleInputSchema, updateRuleInputSchema } from '@agent-desktop/public-contracts';
import { getOwnerId } from '../auth.js';
import { parseListQueryWithWhere } from './query-helpers.js';
import type { AgentdDeps } from './index.js';

export function registerRules(app: Hono, deps: AgentdDeps) {
  app.get('/v1/rules', async (c) => {
    // `agentId` narrows to that agent's own rules (standing grants); owner-wide rules have no agentId.
    const query = parseListQueryWithWhere(c.req.query(), ['agentId']);
    const page = await deps.store.list('rules', {
      ...query,
    });
    return c.json({ items: page.items, nextCursor: page.nextCursor });
  });

  app.post(
    '/v1/rules',
    zValidator('json', createRuleInputSchema),
    async (c) => {
      const ownerId = getOwnerId(c);
      const input = c.req.valid('json');
      if (input.scope === 'delegation') return c.json({ error: { code: 'INVALID_RULE', message: 'Delegations are made with POST /v1/delegations' } }, 400);
      // Time-ordered and unique: a millisecond timestamp alone collides when two are created at once.
      const id = `rul-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const rule = {
        id,
        description: input.description,
        scope: input.scope,
        behavior: input.behavior,
        source: 'user' as const,
        enabled: true,
        subject: input.subject,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        createdAt: new Date().toISOString(),
        createdBy: ownerId,
      };
      const created = await deps.store.put('rules', rule);
      return c.json(created, 201);
    }
  );

  app.patch(
    '/v1/rules/:id',
    zValidator('json', updateRuleInputSchema.optional()),
    async (c) => {
      const patch = c.req.valid('json') || {};
      if (patch.scope === 'delegation') return c.json({ error: { code: 'INVALID_RULE', message: 'Delegations are changed with PATCH /v1/delegations/:id' } }, 400);
      const updated = await deps.store.patch('rules', c.req.param('id'), patch);
      return c.json(updated);
    }
  );

  // Revoking a standing grant: another owner's rule answers exactly like a missing one.
  app.delete('/v1/rules/:id', async (c) => {
    const id = c.req.param('id');
    if ((await deps.store.get('rules', id)) === null) throw new NotFoundError('rules', id);
    await deps.store.delete('rules', id);
    return c.json({});
  });

  app.post('/v1/rules/:id/accept', async (c) => {
    const updated = await deps.store.patch('rules', c.req.param('id'), {
      source: 'user' as const,
    });
    return c.json(updated);
  });

  app.post('/v1/rules/:id/reject', async (c) => {
    await deps.store.delete('rules', c.req.param('id'));
    return c.json({});
  });
}

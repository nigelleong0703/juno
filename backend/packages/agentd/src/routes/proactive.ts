import { type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { keepProactiveRuleInputSchema, proactiveFeedbackInputSchema } from '@agent-desktop/public-contracts';
import { applyFeedback } from 'juno-agent/modules/proactive/feedback';
import { toPublicRule } from 'juno-agent/modules/proactive/rules';
import { keepRuleById, readRules, removeRule, todayFor } from 'juno-agent/modules/proactive/service';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';

/**
 * What the owner tells the agent about its unprompted messages (BACKEND §5.10): the buttons on proactive items and the rules
 * they made (the fixed-format PROACTIVE_PREFERENCES.md; only this API and the agent's `preference_note` write it). Every route
 * stays inside the caller's own rows.
 */
export function registerProactive(app: Hono, deps: AgentdDeps) {
  const homeDeps = { store: deps.store, ...(deps.computerd?.home === undefined ? {} : { home: deps.computerd.home }) };
  const notFound = (code: string, message: string) => ({ error: { code, message } });

  app.post('/v1/proactive/feedback', zValidator('json', proactiveFeedbackInputSchema), async (c) => {
    const outcome = await applyFeedback(homeDeps, getOwnerId(c), c.req.valid('json'), new Date());
    return 'code' in outcome ? c.json(notFound(outcome.code, outcome.message), 404) : c.json(outcome);
  });

  app.get('/v1/proactive/rules', async (c) => {
    const ownerId = getOwnerId(c);
    const today = await todayFor(deps.store, ownerId, new Date());
    return c.json({ items: (await readRules(deps.store, ownerId)).map((rule) => toPublicRule(rule, today)) });
  });

  app.delete('/v1/proactive/rules/:id', async (c) => {
    const removed = await removeRule(homeDeps, getOwnerId(c), c.req.param('id'));
    return removed ? c.json({}) : c.json(notFound('RULE_NOT_FOUND', 'Rule not found'), 404);
  });

  app.patch('/v1/proactive/rules/:id', zValidator('json', keepProactiveRuleInputSchema), async (c) => {
    const ownerId = getOwnerId(c);
    const kept = await keepRuleById(homeDeps, ownerId, c.req.param('id'), new Date());
    if (kept === undefined) return c.json(notFound('RULE_NOT_FOUND', 'No such rule, or it has no review date to keep'), 404);
    return c.json(toPublicRule(kept, await todayFor(deps.store, ownerId, new Date())));
  });
}

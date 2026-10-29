import { type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { NotFoundError } from '@agent-desktop/contracts';
import {
  createDelegationInputSchema,
  delegationDraftSchema,
  updateDelegationInputSchema,
} from '@agent-desktop/public-contracts';
import type { CreateDelegationInput, DelegationDraft, DelegationPlatform, Rule } from '@agent-desktop/public-contracts';
import { delegationRuleId, describeDelegation, platformKeyOfDelegation } from 'juno-agent/execution/harness/services/decision/delegation';
import { getOwnerId } from '../auth.js';
import { parseListQueryWithWhere } from './query-helpers.js';
import type { AgentdDeps } from './index.js';

/** A delegation lapses after this long unless the owner renews it (BACKEND 8.0). */
const DEFAULT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

function describe(draft: DelegationDraft): string {
  return describeDelegation(draft.category, draft.platform, draft.limits, draft.routineId !== undefined);
}

/**
 * Create the delegation, or update the limits of the one already there for the same agent + category + platform + routine
 * (one id per such cell). Shared by `POST /v1/delegations` and "allow this kind" on an approval.
 */
export async function upsertDelegation(deps: Pick<AgentdDeps, 'store' | 'enqueuer'>, ownerId: string, agentId: string, draft: DelegationDraft, expiresAt?: string): Promise<Rule> {
  const platformKey = platformKeyOfDelegation(draft.platform);
  const id = delegationRuleId(agentId, draft.category, platformKey, draft.routineId);
  const lapse = expiresAt ?? new Date(Date.now() + DEFAULT_LIFETIME_MS).toISOString();
  const existing = await deps.store.get('rules', id);
  const delegation = { category: draft.category, platformKey, ...(draft.routineId === undefined ? {} : { routineId: draft.routineId }), limits: draft.limits };
  if (existing !== null) {
    return deps.store.patch('rules', id, { description: describe(draft), delegation, enabled: true, expiresAt: lapse });
  }
  return deps.store.put('rules', {
    id,
    description: describe(draft),
    scope: 'delegation',
    behavior: 'auto',
    source: 'user',
    enabled: true,
    agentId,
    createdAt: new Date().toISOString(),
    createdBy: ownerId,
    delegation,
    expiresAt: lapse,
    useCount: 0,
  });
}

/** The platform a stored delegation key stands for (the inverse of `platformKeyOfDelegation`); a chat's title is read from the chat. */
async function platformOfKey(deps: Pick<AgentdDeps, 'store'>, key: string): Promise<DelegationPlatform> {
  if (key.startsWith('app:')) return { kind: 'connector', catalogId: key.slice(4) };
  if (key.startsWith('site:')) return { kind: 'site', host: key.slice(5) };
  if (key.startsWith('chat:')) {
    const conversationId = key.slice(5);
    const title = (await deps.store.get('conversations', conversationId))?.title;
    return { kind: 'chat', conversationId, ...(title === undefined ? {} : { title }) };
  }
  return { kind: 'juno' };
}

export async function requireDelegation(deps: AgentdDeps, id: string): Promise<Rule> {
  const rule = await deps.store.get('rules', id);
  if (rule === null || rule.scope !== 'delegation' || rule.delegation === undefined) throw new NotFoundError('delegations', id);
  return rule;
}

export function registerDelegations(app: Hono, deps: AgentdDeps) {
  app.get('/v1/delegations', async (c) => {
    const query = parseListQueryWithWhere(c.req.query(), ['agentId']);
    const page = await deps.store.list('rules', query);
    return c.json({ items: page.items.filter((rule) => rule.scope === 'delegation'), nextCursor: page.nextCursor });
  });

  app.post('/v1/delegations', zValidator('json', createDelegationInputSchema), async (c) => {
    const input: CreateDelegationInput = c.req.valid('json');
    if ((await deps.store.get('agents', input.agentId)) === null) throw new NotFoundError('agents', input.agentId);
    const { agentId, expiresAt, ...draft } = input;
    const rule = await upsertDelegation(deps, getOwnerId(c), agentId, draft, expiresAt);
    return c.json(rule, 201);
  });

  app.patch('/v1/delegations/:id', zValidator('json', updateDelegationInputSchema), async (c) => {
    const rule = await requireDelegation(deps, c.req.param('id'));
    const patch = c.req.valid('json');
    const current = rule.delegation;
    if (current === undefined) throw new NotFoundError('delegations', rule.id);
    const limits = patch.limits ?? current.limits;
    const platform = await platformOfKey(deps, current.platformKey);
    const draft = delegationDraftSchema.safeParse({ category: current.category, platform, ...(current.routineId === undefined ? {} : { routineId: current.routineId }), limits });
    if (!draft.success) return c.json({ error: { code: 'INVALID_DELEGATION', message: draft.error.issues.map((issue) => issue.message).join('; ') } }, 400);
    const updated = await deps.store.patch('rules', rule.id, {
      description: describe(draft.data),
      delegation: { ...current, limits },
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.expiresAt === undefined ? {} : { expiresAt: patch.expiresAt }),
    });
    return c.json(updated);
  });

  // Revoking is final for the next call: the policy reads the rules fresh on every tool call.
  app.delete('/v1/delegations/:id', async (c) => {
    const rule = await requireDelegation(deps, c.req.param('id'));
    await deps.store.delete('rules', rule.id);
    return c.json({});
  });
}

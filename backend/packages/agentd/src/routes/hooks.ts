import { type Context, type Hono } from 'hono';
import { z } from 'zod';
import { NotFoundError, sessionKey, wakeEventSchema } from '@agent-desktop/contracts';
import type { WakeEvent } from '@agent-desktop/contracts';
import { createTriggersService } from 'juno-agent/execution/harness/index';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { docOwnerId, isRelationshipError } from './relationships.js';
import { resolveRoutineTarget } from './routine-scope.js';
import { resolveWakeConversation } from './wake-scope.js';

/**
 * H-80: kinds a caller may start through the public wake route. Internal kinds (task_done, hand_back,
 * timer, child_task, typing, ...) are produced only by the harness, so they can never be forged here.
 */
const PUBLIC_WAKE_KINDS = ['user_message', 'webhook', 'connector_event'] as const;

const wakeBodySchema = z.object({
  conversationId: z.string().min(1).optional(),
  text: z.string().min(1),
  kind: z.enum(PUBLIC_WAKE_KINDS).default('user_message'),
});

async function admitWake(c: Context, deps: AgentdDeps, wake: WakeEvent) {
  try {
    const result = await deps.enqueuer.enqueue(wake);
    if (result.accepted) return undefined;
  } catch {
    // Transport failures and explicit rejection both mean no accepted wake.
  }
  return c.json({ error: { code: 'WAKE_ENQUEUE_FAILED', message: 'Wake could not be queued' } }, 503);
}

/** The api gateway verifies the routine's webhook secret and forwards as the routine's owner; agentd only re-checks ownership. */
export function registerHooks(app: Hono, deps: AgentdDeps) {
  const triggers = createTriggersService({ store: deps.store, enqueuer: deps.enqueuer });
  app.post('/v1/hooks/:routineId', async (c) => {
    const ownerId = getOwnerId(c);
    const routineId = c.req.param('routineId');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: 'INVALID_HOOK', message: 'Webhook payload must be an object' } }, 400);
    }
    const parsedPayload = z.record(z.string(), z.unknown()).safeParse(body);
    if (!parsedPayload.success) return c.json({ error: { code: 'INVALID_HOOK', message: 'Webhook payload must be an object' } }, 400);
    const payload = parsedPayload.data;
    const routine = await deps.store.get('routines', routineId);
    if (!routine) throw new NotFoundError('routines', routineId);
    const routineOwner = docOwnerId(routine);
    if (routineOwner !== undefined && routineOwner !== ownerId) {
      return c.json({ error: { code: 'ROUTINE_FORBIDDEN', message: 'Routine is not yours' } }, 403);
    }
    // A routine waiting for an app the owner has not connected does not run, whatever calls it.
    if (routine.status === 'needs_setup') return c.json({ error: { code: 'ROUTINE_NEEDS_SETUP', message: 'This routine is waiting for an app to be connected' } }, 409);
    const target = await resolveRoutineTarget(deps.store, ownerId, routine.agentId);
    if (isRelationshipError(target)) return c.json({ error: target }, target.status);
    const requestedId = routine.delivery.channel === 'chat' ? routine.delivery.target : undefined;
    const chat = await resolveWakeConversation(deps.store, ownerId, routine.agentId, requestedId);
    if (isRelationshipError(chat)) return c.json({ error: chat }, chat.status);
    const event = {
      ...payload,
      id: typeof payload['id'] === 'string' && payload['id'].length > 0 ? payload['id'] : crypto.randomUUID(),
      source: typeof payload['source'] === 'string' ? payload['source'] : 'webhook',
      type: typeof payload['type'] === 'string' ? payload['type'] : 'webhook',
    };
    try {
      const delivered = await triggers.deliverExternal(event, { ownerId, agentId: routine.agentId, conversationId: chat.id });
      if (delivered.attempted > 0) {
        if (delivered.matched === delivered.attempted) return c.json({ received: true, resumed: delivered.matched }, 202);
        return c.json({ error: { code: 'WAKE_ENQUEUE_FAILED', message: 'Matching event could not be delivered' } }, 503);
      }
      // The original Run already consumed this exact event (durable receipt): acknowledge the
      // retry without queuing another wake behind it. No phantom wake is persisted as a receipt.
      if (delivered.duplicated > 0) return c.json({ received: true, duplicate: true }, 202);
    } catch {
      return c.json({ error: { code: 'WAKE_ENQUEUE_FAILED', message: 'Matching event could not be delivered' } }, 503);
    }
    const wake = wakeEventSchema.parse({
      id: `wk-hook-${routineId}-${event.id}`,
      ownerId, agentId: routine.agentId,
      sessionKey: sessionKey(routine.agentId, chat.id), conversationId: chat.id,
      kind: 'webhook', origin: { type: 'automation', id: routineId },
      trusted: false, priority: 'background', payload,
      at: new Date().toISOString(), status: 'accepted',
    });
    const failure = await admitWake(c, deps, wake);
    return failure ?? c.json({ received: true }, 202);
  });

  app.post('/v1/agents/:id/wake', async (c) => {
    const ownerId = getOwnerId(c);
    const agentId = c.req.param('id');
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: { code: 'INVALID_WAKE', message: 'Invalid wake input' } }, 400);
    }
    const body = wakeBodySchema.safeParse(rawBody);
    if (!body.success) return c.json({ error: { code: 'INVALID_WAKE', message: 'Invalid wake input' } }, 400);
    const target = await resolveRoutineTarget(deps.store, ownerId, agentId);
    if (isRelationshipError(target)) return c.json({ error: target }, target.status);
    const chat = await resolveWakeConversation(deps.store, ownerId, agentId, body.data.conversationId);
    if (isRelationshipError(chat)) return c.json({ error: chat }, chat.status);
    const wake = wakeEventSchema.parse({
      id: `wk-api-${agentId}-${crypto.randomUUID()}`,
      ownerId, agentId, sessionKey: sessionKey(agentId, chat.id), conversationId: chat.id,
      kind: body.data.kind, origin: { type: 'user' }, trusted: true, priority: 'user',
      payload: { text: body.data.text }, at: new Date().toISOString(), status: 'accepted',
    });
    const failure = await admitWake(c, deps, wake);
    return failure ?? c.json({ id: wake.id, accepted: true }, 202);
  });
}

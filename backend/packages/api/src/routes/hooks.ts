/**
 * Public webhook ingress and the owner's secret endpoint.
 *
 * POST /v1/hooks/:routineId is the only /v1 route open to callers without a login session (Zapier,
 * GitHub, ...). It is registered before the session middleware and is the single place the webhook
 * secret is verified: the routine is loaded, the presented secret is compared with the stored hash,
 * and only then is the request forwarded to agentd as the routine's owner. Unknown routine, missing
 * secret and wrong secret all answer the same 401.
 */
import type { Hono } from 'hono';
import { NotFoundError, type Store } from '@agent-desktop/contracts';
import { docOwnerId } from '@agent-desktop/db';
import { forwardToAgentd, type ForwardDeps } from '../proxy.js';
import { requestOwner } from '../owner.js';
import {
  hashWebhookSecret,
  maskWebhookSecret,
  newWebhookSecret,
  presentedWebhookSecret,
  webhookSecretMatches,
} from '../modules/webhook-secret.js';

export function registerHookIngress(app: Hono, deps: { store: Store; forward: ForwardDeps }): void {
  app.post('/v1/hooks/:routineId', async (c) => {
    const routine = await deps.store.get('routines', c.req.param('routineId'));
    const ownerId = docOwnerId(routine);
    const presented = presentedWebhookSecret(c.req, c.req.query('key')) ?? '';
    const matches = webhookSecretMatches(presented, routine?.webhookSecretHash);
    if (ownerId === undefined || !matches) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing webhook secret' } }, 401);
    }
    return forwardToAgentd(c, ownerId, deps.forward);
  });
}

/** (Re)generates the routine's webhook secret; the plaintext is returned here once and never stored. */
export function registerRoutineWebhook(app: Hono, deps: { store: Store; publicUrl?: string }): void {
  app.post('/v1/routines/:id/webhook', async (c) => {
    const store = deps.store.forOwner?.(requestOwner(c));
    if (!store) throw new Error('Store.forOwner is required: refusing unscoped routine access');
    const id = c.req.param('id');
    const routine = await store.get('routines', id);
    if (!routine) throw new NotFoundError('routines', id);
    if (routine.trigger.kind !== 'webhook') {
      return c.json({ error: { code: 'NOT_A_WEBHOOK', message: 'Routine does not have a webhook trigger' } }, 400);
    }
    const secret = newWebhookSecret();
    const url = (deps.publicUrl ?? new URL(c.req.url).origin) + '/v1/hooks/' + id;
    const updated = await store.patch('routines', id, {
      trigger: { kind: 'webhook', url, secretMasked: maskWebhookSecret(secret) },
      webhookSecretHash: hashWebhookSecret(secret).toString('hex'),
    });
    await store.emit({ type: 'routine.updated', routine: updated });
    c.header('Cache-Control', 'no-store');
    return c.json({ url, secret });
  });
}

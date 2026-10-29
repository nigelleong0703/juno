/**
 * The iPhone app as a device (BACKEND 7.13). While the app holds its live event stream it declares what the owner allowed
 * (EventKit); a call reaches it as a `device.call` event and it answers here. A declaration needs an open stream tagged `ios`
 * and goes away with it (juno-agent execution/presence.ts), so a phone that is not connected can never look available.
 * The declaration and the answers are rows (execution/phone.ts): the `phone_*` tools run on workers, this runs on the coordinator.
 */
import { type Hono } from 'hono';
import { phoneCallResultSchema, phoneDeclarationSchema } from '@agent-desktop/public-contracts';
import { clientOpen } from 'juno-agent/execution/presence';
import { completePhoneCall, declarePhone, withdrawPhone } from 'juno-agent/execution/phone';
import { getOwnerId } from '../auth.js';
import { ownerStore } from '../owner-scope.js';
import type { AgentdDeps } from './index.js';

/** An answer bigger than this is refused: the app caps what it returns long before. */
const MAX_RESULT_BYTES = 512 * 1024;

export function registerPhone(app: Hono, deps: Pick<AgentdDeps, 'store'>): void {
  app.put('/v1/phone/declaration', async (c) => {
    const body = phoneDeclarationSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: { code: 'INVALID_BODY', message: 'deviceId, name, osVersion and actions are required' } }, 400);
    const ownerId = getOwnerId(c);
    const store = ownerStore(deps, ownerId);
    if (!(await clientOpen(store, ownerId, 'ios'))) {
      return c.json({ error: { code: 'NOT_CONNECTED', message: 'Open the event stream (x-juno-client: ios) before declaring' } }, 409);
    }
    await declarePhone(store, ownerId, body.data);
    return c.body(null, 204);
  });

  app.delete('/v1/phone/declaration', async (c) => {
    const deviceId = c.req.query('deviceId');
    const ownerId = getOwnerId(c);
    await withdrawPhone(ownerStore(deps, ownerId), ownerId, deviceId === undefined || deviceId === '' ? undefined : deviceId);
    return c.body(null, 204);
  });

  app.post('/v1/phone/calls/:callId/result', async (c) => {
    const text = await c.req.text();
    if (text.length > MAX_RESULT_BYTES) return c.json({ error: { code: 'TOO_LARGE', message: 'The result is too large' } }, 413);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const body = phoneCallResultSchema.safeParse(json);
    if (!body.success) return c.json({ error: { code: 'INVALID_BODY', message: 'ok, and data or error, are required' } }, 400);
    const ownerId = getOwnerId(c);
    // Late, repeated or unknown answers are not an error for the phone: nobody is waiting, so it is told so and moves on.
    return c.json({ applied: await completePhoneCall(ownerStore(deps, ownerId), ownerId, c.req.param('callId'), body.data) });
  });
}

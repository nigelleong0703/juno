/**
 * `DELETE /v1/account` (BACKEND §5.2c): delete the caller's own account and all its data. The owner is the service-resolved one
 * (the gateway's session), never anything in the body. The body must say `{"confirm": true}` so a stray call cannot do it.
 * 200 `{deleted: true}` when everything is already gone; 202 `{deleting: true}` when the sign-in is closed and the job carries on
 * in the background (and across restarts). An operator removes another user the same way through this internal service, with
 * the service bearer and that user's `x-owner-id`; editing the database by hand emits no delete events.
 */
import { type Hono } from 'hono';
import { z } from 'zod';
import type { AccountEraser } from '../account/erase.js';
import { getOwnerId } from '../auth.js';

const bodySchema = z.object({ confirm: z.literal(true) });

export function registerAccount(app: Hono, eraser: AccountEraser): void {
  app.delete('/v1/account', async (c) => {
    if (!bodySchema.safeParse(await c.req.json().catch(() => null)).success) {
      return c.json({ error: { code: 'CONFIRMATION_REQUIRED', message: 'Send {"confirm": true} to delete this account and all its data' } }, 400);
    }
    const state = await eraser.erase(getOwnerId(c));
    return state === 'deleted' ? c.json({ deleted: true }) : c.json({ deleting: true }, 202);
  });
}

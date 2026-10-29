import type { Context, Hono, Next } from 'hono';
import { getConfig } from '../config.js';

/** Bare route-test apps skip auth; set the request owner explicitly instead of relying on a config fallback (E41). */
export function withTestOwner(app: Hono, ownerId: string = getConfig().OWNER_ID): Hono {
  app.use('*', async (c: Context, next: Next) => {
    c.set('ownerId', ownerId);
    await next();
  });
  return app;
}

/**
 * The owner's Mac as a computer (My Mac). The desktop app on the Mac pairs itself here (`POST` returns the link address and its
 * token once), anyone signed in as the owner can read the status (paired, online) and revoke it. Pairing is owner-wide: it needs
 * no agent and only that owner's agents can be set to the Mac.
 */
import { type Context, type Hono } from 'hono';
import { z } from 'zod';
import { ComputerdClientError, type ComputerdClient } from '../computerd.js';
import { reconcileOwner } from 'juno-agent/modules/tasks/routines/capability-gate';
import { listMacApps, revokeMacApp } from 'juno-agent/modules/mac-apps';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { gateDeps } from './routines.js';

const pairSchema = z.object({ name: z.string().trim().min(1).max(80).optional() });

/** The apps the owner let agents use on the Mac for good ("Always allow" on the approval card); needs only the store. */
export function registerMacApps(app: Hono, deps: AgentdDeps): void {
  app.get('/v1/mac/apps', async (c) => c.json({ apps: await listMacApps(deps.store) }));
  app.delete('/v1/mac/apps/:app', async (c) => {
    const key = c.req.param('app');
    if (!(await revokeMacApp(deps.store, key))) return c.json({ error: { code: 'NOT_FOUND', message: 'That app is not on the allowed list' } }, 404);
    return c.json({ apps: await listMacApps(deps.store) });
  });
}

export function registerMac(app: Hono, deps: AgentdDeps & { computerd: ComputerdClient }): void {
  const client = deps.computerd;
  const signal = () => new AbortController().signal;
  const run = async (c: Context, work: () => Promise<unknown>, status: 200 | 201 = 200): Promise<Response> => {
    try {
      return c.json(await work(), status);
    } catch (error) {
      if (!(error instanceof ComputerdClientError)) throw error;
      return c.json({ error: { code: error.code, message: error.message } }, (error.status >= 400 && error.status < 600 ? error.status : 502) as 400);
    }
  };
  // Registered before `/v1/computers/:id`, so `runtime` and `my-mac` are never read as a computer id.
  app.get('/v1/computers/runtime', (c) => run(c, () => client.runtime(signal())));
  app.get('/v1/computers/my-mac', (c) => run(c, async () => {
    const status = await client.macStatus(signal());
    // The Mac coming online may be what a Connect card in a chat was waiting for; the app reads this status while the card is open.
    if (status.online) void reconcileOwner(gateDeps(deps), getOwnerId(c)).catch(() => undefined);
    return status;
  }));
  app.post('/v1/computers/my-mac', async (c) => {
    const body = pairSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: { code: 'INVALID_BODY', message: 'name must be 1-80 characters' } }, 400);
    return run(c, () => client.macPair(body.data.name, signal()), 201);
  });
  app.delete('/v1/computers/my-mac', (c) => run(c, () => client.macRevoke(signal())));
  // Stop all agent access to the Mac from any client (the Mac cancels what runs). Resuming is not offered here: it happens on the Mac itself.
  app.post('/v1/computers/my-mac/stop', (c) => run(c, () => client.macStop({ actorId: getOwnerId(c), via: c.req.header('x-client') ?? 'api' }, signal())));
}

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { ComputerRuntime } from '@agent-desktop/public-contracts';
import { controlActorSchema } from '@agent-desktop/contracts';
import type { OwnerComputers } from '../modules/computers/owner-computers.js';
import type { MacRegistry } from '../modules/mac/registry.js';
import type { MacComputers } from '../modules/mac/mac-computer.js';
import { handle } from './http.js';
import { createComputerApp } from './routes.js';

export interface MacPairing {
  registry: MacRegistry;
  computers: MacComputers;
  /** The link token of a link id (the hub derives it). */
  tokenFor(linkId: string): string;
  /** Where the Mac dials. */
  url: string;
  /** Cut a link that was just revoked or replaced. */
  drop(linkId: string): void;
}

const pairSchema = z.object({ name: z.string().max(120).optional() });

export function createOwnerComputerApp(options: { computers: OwnerComputers; token: string; mac?: MacPairing; runtime?: () => ComputerRuntime | Promise<ComputerRuntime> }): Hono {
  const app = new Hono();
  const apps = new Map<string, Hono>();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  /** The bearer check and the owner of the request, or the refusal. */
  const owner = (c: Context): string | Response => {
    if (!options.token || c.req.header('authorization') !== `Bearer ${options.token}`) {
      return c.json({ code: 'not_allowed', message: 'missing or invalid bearer token' }, 403);
    }
    const id = c.req.header('x-owner-id');
    return id?.trim() ? id : c.json({ code: 'not_allowed', message: 'missing owner' }, 403);
  };
  const { mac } = options;
  // Where the sandbox runs and whether its image is ready (the desktop app shows it; a server's sandbox is always "cloud").
  app.get('/v1/runtime', async (c) => {
    const id = owner(c);
    if (typeof id !== 'string') return id;
    return c.json(await (options.runtime?.() ?? { kind: 'cloud' as const, image: { state: 'ready' as const } }));
  });
  if (mac) {
    // Pairing, status and revoke of the owner's Mac (My Mac). The token is shown once, in the pairing response.
    app.post('/v1/mac/pair', async (c) => {
      const id = owner(c);
      if (typeof id !== 'string') return id;
      const body = pairSchema.safeParse(await c.req.json().catch(() => ({})));
      const previous = mac.registry.get(id);
      const link = mac.registry.pair(id, body.success ? body.data.name ?? '' : '');
      if (previous) mac.drop(previous.id);
      await mac.computers.forOwner(id).ensureControl();
      return c.json({ id: link.id, url: mac.url, token: mac.tokenFor(link.id), name: link.name, pairedAt: link.pairedAt }, 201);
    });
    app.get('/v1/mac', async (c) => {
      const id = owner(c);
      return typeof id === 'string' ? c.json(await mac.computers.forOwner(id).status()) : id;
    });
    // Stop all agent access to the Mac from any client. There is no remote resume: that happens on the Mac itself (the hub accepts it only from there).
    app.post('/v1/mac/stop', async (c) => {
      const id = owner(c);
      if (typeof id !== 'string') return id;
      const actor = controlActorSchema.safeParse({ via: c.req.header('x-actor-via') ?? 'api', ...(c.req.header('x-actor-id') ? { userId: c.req.header('x-actor-id') } : {}) });
      if (!mac.registry.get(id)) return c.json({ code: 'not_allowed', message: 'no Mac is paired with this account' }, 403);
      return c.json(await mac.computers.forOwner(id).stop(actor.success && actor.data.via !== 'mac-local' ? actor.data : { via: 'api' }));
    });
    app.delete('/v1/mac', (c) => {
      const id = owner(c);
      if (typeof id !== 'string') return id;
      const link = mac.registry.revoke(id);
      if (link) mac.drop(link.id);
      return c.json({ paired: false, online: false });
    });
  }
  // Account deletion: the owner's computers, their durable storage and state files, and the paired Mac, in one idempotent call.
  app.delete('/v1/owner', (c) => {
    const id = owner(c);
    if (typeof id !== 'string') return id;
    return handle(c, async (signal) => {
      const erasure = await options.computers.erase(id, signal);
      const link = mac?.registry.revoke(id);
      if (link) mac?.drop(link.id);
      return c.json({ ...erasure, macRevoked: link !== undefined });
    });
  });
  app.all('/v1/*', (c) => {
    const id = owner(c);
    if (typeof id !== 'string') return id;
    let scoped = apps.get(id);
    if (!scoped) {
      scoped = createComputerApp({ ...options.computers.forOwner(id), token: options.token, requireAuth: true, ...(mac ? { mac: mac.computers.forOwner(id) } : {}) });
      apps.set(id, scoped);
    }
    return scoped.fetch(c.req.raw);
  });
  return app;
}

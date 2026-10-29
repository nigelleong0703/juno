/** Spaces (BACKEND 5.12): the owner's published apps with their live status, the signed link that opens one on its own origin, and their share links on long-lived hosting (option B). */
import type { Context, Hono } from 'hono';
import { HostedError } from '@agent-desktop/spaces-host/publisher';
import { spaceHostedUpdateSchema, spacePublishHostedSchema } from '@agent-desktop/public-contracts';
import { requestOwner } from '../owner.js';
import { OPEN_URL_TTL_MS, signSpaceToken } from '../space-origin.js';
import { publishedSpace, publishedSpaces, spaceStatuses, toHosted, toSpace, type ComputerdLink } from '../modules/spaces.js';
import { hostedOpenUrl, liveHosted, publishHosted, revokeHosted, updateHosted, type HostedDeps, type HostedSetup } from '../modules/spaces-hosted.js';
import type { AppRoutesDeps } from './index.js';

export interface SpaceRoutesDeps {
  /** `spaces.localhost:8793` */
  domain: string;
  /** `http` or `https` (the scheme of the public app). */
  scheme: string;
  secret: string;
  computerd?: ComputerdLink;
  /** Hosted Spaces (option B): on, or off with the reason (the 503 answer). Absent = off. */
  hosted?: HostedSetup;
}

const notFound = { error: { code: 'NOT_FOUND', message: 'space not found' } };
const badBody = { error: { code: 'INVALID_BODY', message: 'the request body is not valid' } };

export function registerSpaces(app: Hono, deps: AppRoutesDeps & { spaces: SpaceRoutesDeps }): void {
  const scoped = (ownerId: string) => {
    if (deps.store.forOwner === undefined) throw new Error('Store.forOwner is required: refusing unscoped app data access');
    return deps.store.forOwner(ownerId);
  };
  /** The hosting deps, or the reason hosting is off. */
  const hosting = (): HostedDeps | string => {
    const hosted = deps.spaces.hosted;
    if (hosted === undefined) return 'hosted Spaces are not wired on this server';
    return hosted.ready ? hosted.deps : hosted.reason;
  };

  app.get('/v1/spaces', async (c) => {
    const ownerId = requestOwner(c);
    const store = scoped(ownerId);
    const rows = await publishedSpaces(store);
    const statuses = await spaceStatuses(deps.spaces.computerd, ownerId, rows);
    const shares = await Promise.all(rows.map((row) => liveHosted(store, row.id)));
    return c.json({ items: rows.map((row, index) => toSpace(row, statuses.get(row.id) ?? 'unknown', shares[index])) });
  });

  app.get('/v1/spaces/:id', async (c) => {
    const ownerId = requestOwner(c);
    const store = scoped(ownerId);
    const row = await publishedSpace(store, c.req.param('id'));
    if (row === null) return c.json(notFound, 404);
    const status = (await spaceStatuses(deps.spaces.computerd, ownerId, [row])).get(row.id) ?? 'unknown';
    return c.json(toSpace(row, status, await liveHosted(store, row.id)));
  });

  app.post('/v1/spaces/:id/open-url', async (c) => {
    const ownerId = requestOwner(c);
    const row = await publishedSpace(scoped(ownerId), c.req.param('id'));
    if (row === null) return c.json(notFound, 404);
    const expiresAt = Date.now() + OPEN_URL_TTL_MS;
    const token = signSpaceToken({ kind: 'open', spaceId: row.id, ownerId, expiresAt }, deps.spaces.secret);
    return c.json({ url: `${deps.spaces.scheme}://${row.id}.${deps.spaces.domain}/__juno/auth?token=${token}`, expiresAt: new Date(expiresAt).toISOString() });
  });

  // Hosted (option B). A new publish, or a republish, reads the app from its computer; the rest works on the link that exists.
  app.post('/v1/spaces/:id/publish-hosted', async (c) => {
    const ownerId = requestOwner(c);
    const store = scoped(ownerId);
    const row = await publishedSpace(store, c.req.param('id'));
    if (row === null) return c.json(notFound, 404);
    const hosted = hosting();
    if (typeof hosted === 'string') return c.json({ error: { code: 'HOSTED_UNAVAILABLE', message: hosted } }, 503);
    const body = spacePublishHostedSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json(badBody, 400);
    try {
      return c.json(toHosted(await publishHosted(store, hosted, ownerId, row, body.data)));
    } catch (error) {
      return hostedFailure(c, error);
    }
  });

  app.patch('/v1/spaces/:id/hosted', async (c) => {
    const ownerId = requestOwner(c);
    const hosted = hosting();
    if (typeof hosted === 'string') return c.json({ error: { code: 'HOSTED_UNAVAILABLE', message: hosted } }, 503);
    const body = spaceHostedUpdateSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return c.json(badBody, 400);
    try {
      return c.json(toHosted(await updateHosted(scoped(ownerId), hosted, c.req.param('id'), body.data)));
    } catch (error) {
      return hostedFailure(c, error);
    }
  });

  app.delete('/v1/spaces/:id/hosted', async (c) => {
    const ownerId = requestOwner(c);
    const hosted = hosting();
    if (typeof hosted === 'string') return c.json({ error: { code: 'HOSTED_UNAVAILABLE', message: hosted } }, 503);
    try {
      await revokeHosted(scoped(ownerId), hosted, c.req.param('id'));
      return c.body(null, 204);
    } catch (error) {
      return hostedFailure(c, error);
    }
  });

  app.post('/v1/spaces/:id/hosted/open-url', async (c) => {
    const ownerId = requestOwner(c);
    const hosted = hosting();
    if (typeof hosted === 'string') return c.json({ error: { code: 'HOSTED_UNAVAILABLE', message: hosted } }, 503);
    try {
      return c.json(await hostedOpenUrl(scoped(ownerId), hosted, c.req.param('id'), OPEN_URL_TTL_MS));
    } catch (error) {
      return hostedFailure(c, error);
    }
  });
}

/** A failed hosted call as an answer: the owner's mistakes as 4xx, the hosting service and the computer as 502 (their details stay in the logs). */
function hostedFailure(c: Context, error: unknown): Response {
  if (error instanceof HostedError) {
    if (error.code === 'not_found') return c.json({ error: { code: 'NOT_FOUND', message: error.message } }, 404);
    if (error.code === 'invalid') return c.json({ error: { code: 'NOT_HOSTABLE', message: error.message } }, 422);
    // The message is the owner-facing reason (SERVER_CODE_MESSAGE in services/spaces-host).
    if (error.code === 'server_code') return c.json({ error: { code: 'SPACE_HAS_SERVER_CODE', message: error.message } }, 409);
    return c.json({ error: { code: 'HOSTING_FAILED', message: 'the hosting service failed; try again' } }, 502);
  }
  return c.json({ error: { code: 'SPACE_UNREADABLE', message: 'the Space could not be read from its computer; check that the computer is running' } }, 502);
}

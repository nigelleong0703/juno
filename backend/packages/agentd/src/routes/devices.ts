/**
 * Push-notification device registrations (APNs for iOS, FCM for Android). Owner-scoped: a device row belongs to the caller's
 * owner, and the row id is derived from owner + token, so two owners never share a row (and a phone
 * that changes accounts gets a fresh row instead of a collision). Unregistering is idempotent.
 */
import { createHash } from 'crypto';
import { type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';

/** APNs device tokens are hex; bounded so a value can be interpolated into an HTTP/2 path safely. */
const apnsTokenSchema = z.string().regex(/^[0-9a-fA-F]{32,256}$/);
/** FCM registration tokens are long strings of letters, digits, `-`, `_` and `:` (case matters, never lowercased). */
const fcmTokenSchema = z.string().regex(/^[A-Za-z0-9_:-]{64,512}$/);

const registerSchema = z.discriminatedUnion('platform', [
  z.object({
    platform: z.literal('ios'),
    token: apnsTokenSchema,
    environment: z.enum(['sandbox', 'production']),
    bundleId: z.string().min(1).max(200),
  }),
  // FCM has no sandbox host, so an Android registration carries no environment (stored as 'production').
  z.object({
    platform: z.literal('android'),
    token: fcmTokenSchema,
    bundleId: z.string().min(1).max(200),
  }),
]);

/** iOS ids hash the lowercased token (unchanged from before Android); Android ids hash the exact token with a platform tag. */
export function deviceRowId(ownerId: string, token: string, platform: 'ios' | 'android' = 'ios'): string {
  const material = platform === 'ios' ? ownerId + ':' + token.toLowerCase() : ownerId + ':android:' + token;
  return 'dev_' + createHash('sha256').update(material).digest('hex');
}

export function registerDevices(app: Hono, deps: AgentdDeps) {
  app.post('/v1/devices', zValidator('json', registerSchema), async (c) => {
    const body = c.req.valid('json');
    const ownerId = getOwnerId(c);
    const id = deviceRowId(ownerId, body.token, body.platform);
    const existing = await deps.store.get('devices', id);
    const now = new Date().toISOString();
    const saved = await deps.store.put('devices', {
      id,
      platform: body.platform,
      token: body.platform === 'ios' ? body.token.toLowerCase() : body.token,
      environment: body.platform === 'ios' ? body.environment : 'production',
      bundleId: body.bundleId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return c.json(saved);
  });

  app.delete('/v1/devices/:token', async (c) => {
    const token = c.req.param('token');
    const isApns = apnsTokenSchema.safeParse(token).success;
    const isFcm = fcmTokenSchema.safeParse(token).success;
    if (!isApns && !isFcm) return c.json({ error: { code: 'DEVICE_TOKEN_INVALID', message: 'Invalid device token' } }, 400);
    // Owner-scoped delete: another owner's token resolves to different row ids, so this is a no-op for them.
    // The path carries no platform; a token of one shape can only be a row of that platform.
    const ownerId = getOwnerId(c);
    if (isApns) await deps.store.delete('devices', deviceRowId(ownerId, token, 'ios'));
    if (isFcm) await deps.store.delete('devices', deviceRowId(ownerId, token, 'android'));
    return c.body(null, 204);
  });
}

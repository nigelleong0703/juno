/**
 * Channel ingress helpers (CH1): row ids and the platform-secret check.
 *
 * The shape copies routes/hooks.ts: the row stores only the sha256 of the platform secret and
 * every comparison is between two fixed-length digests, so an unknown channel, a missing secret
 * and a wrong secret all take the same path to the same 401.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';

/** Fails closed: a missing or malformed stored hash never matches. */
export function channelSecretMatches(presented: string, storedHashHex: string | undefined): boolean {
  const actual = createHash('sha256').update(presented).digest();
  const expected = Buffer.from(storedHashHex ?? '', 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

/** `X-Channel-Secret`, Telegram's `X-Telegram-Bot-Api-Secret-Token`, then `Authorization: Bearer`, then `?key=` (for callers that cannot set headers). */
export function presentedChannelSecret(
  headers: { header(name: string): string | undefined },
  queryKey: string | undefined,
): string | undefined {
  const direct = headers.header('x-channel-secret');
  if (direct) return direct;
  const telegram = headers.header('x-telegram-bot-api-secret-token');
  if (telegram) return telegram;
  const bearer = /^Bearer (.+)$/i.exec(headers.header('authorization') ?? '');
  return bearer?.[1] ?? (queryKey || undefined);
}

const SLACK_MAX_AGE_SECONDS = 5 * 60;

/** The shared Juno Slack app's signing secret (env SLACK_SIGNING_SECRET); one for every workspace. */
export async function sharedSlackVerifier(c: Context): Promise<boolean> {
  const secret = process.env['SLACK_SIGNING_SECRET']?.trim();
  return secret !== undefined && secret !== '' && (await verifySlackSignature(c, secret));
}

async function verifySlackSignature(c: Context, secret: string): Promise<boolean> {
  const timestamp = c.req.header('x-slack-request-timestamp');
  const signature = c.req.header('x-slack-signature');
  if (!timestamp || !signature) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SLACK_MAX_AGE_SECONDS) return false;
  const rawBody = await c.req.raw.clone().text();
  const expected = Buffer.from('v0=' + createHmac('sha256', secret).update('v0:' + timestamp + ':' + rawBody).digest('hex'));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

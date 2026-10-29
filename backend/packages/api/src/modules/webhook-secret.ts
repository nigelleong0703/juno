/**
 * Routine webhook secrets. The secret is 32 random bytes shown to the user once; only its sha256
 * is stored (on the routine doc) and every comparison is between two fixed-length digests.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function newWebhookSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashWebhookSecret(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/** What the UI may show about a secret it can no longer read. */
export function maskWebhookSecret(secret: string): string {
  return 'whsec_••••' + secret.slice(-4);
}

/** Fails closed: a missing or malformed stored hash never matches. */
export function webhookSecretMatches(presented: string, storedHashHex: string | undefined): boolean {
  const actual = hashWebhookSecret(presented);
  const expected = Buffer.from(storedHashHex ?? '', 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

/** `X-Hook-Secret`, then `Authorization: Bearer`, then `?key=` (for callers that cannot set headers). */
export function presentedWebhookSecret(headers: { header(name: string): string | undefined }, queryKey: string | undefined): string | undefined {
  const direct = headers.header('x-hook-secret');
  if (direct) return direct;
  const bearer = /^Bearer (.+)$/i.exec(headers.header('authorization') ?? '');
  return bearer?.[1] ?? (queryKey || undefined);
}

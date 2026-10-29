/** Short-lived signed claims for the separate origins (artifact pages, Spaces): `<base64url(JSON)>.<HMAC-SHA256 base64url>`, constant-time check. */
import { createHmac, timingSafeEqual } from 'node:crypto';

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signToken(claims: object, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return payload + '.' + signature(payload, secret);
}

/** The claims object when the signature is genuine (and the secret non-empty); callers validate the fields. */
export function verifyToken(token: string, secret: string): Record<string, unknown> | null {
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined || secret.length === 0) return null;
  const expected = Buffer.from(signature(payload, secret));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

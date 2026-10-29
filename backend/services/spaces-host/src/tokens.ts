/**
 * The signed links of hosted Spaces (BACKEND 5.12, option B). An `owner` token is what the API hands the owner: opening it
 * on the Space's host (`/__auth?t=`) turns it into a `session` token in a cookie, which opens a private Space. Format:
 * base64url(JSON claims) + "." + base64url(HMAC-SHA256 of the first part). WebCrypto only, so the API (Node) and the Worker
 * verify the same tokens.
 */

export type LinkTokenKind = 'owner' | 'session';

export interface LinkClaims {
  kind: LinkTokenKind;
  /** The publication (link id) the token opens. */
  pub: string;
  /** Expiry, in epoch milliseconds. */
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

async function hmacKey(secret: string, usage: 'sign' | 'verify') {
  if (secret === '') throw new Error('the Spaces signing key is empty');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signLinkToken(claims: LinkClaims, secret: string): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(mac))}`;
}

/** The claims of a genuine, unexpired token of this kind for this publication; null for anything else. */
export async function verifyLinkToken(token: string, secret: string, kind: LinkTokenKind, pub: string, now: number): Promise<LinkClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, mac] = parts;
  const signature = fromBase64url(mac ?? '');
  const body = fromBase64url(payload ?? '');
  if (signature === undefined || body === undefined) return null;
  if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), signature, encoder.encode(payload ?? '')))) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(decoder.decode(body));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null) return null;
  const value = claims as Record<string, unknown>;
  if (value['kind'] !== kind || value['pub'] !== pub || typeof value['exp'] !== 'number') return null;
  if (value['exp'] <= now) return null;
  return { kind, pub, exp: value['exp'] };
}

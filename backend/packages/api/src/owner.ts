/**
 * Request owner seam for the public API.
 *
 * The gateway resolves the account session to an owner once per request and stores it on the
 * Hono context. Route handlers read it through here so the owner key and the fail-closed check
 * live in one place; a handler can never be reached without an owner.
 */
import type { Context } from 'hono';

/** Hono context key holding the authenticated owner id. */
export const OWNER_CONTEXT_KEY = 'ownerId';

export function setRequestOwner(c: Context, ownerId: string): void {
  c.set(OWNER_CONTEXT_KEY, ownerId);
}

/** Owner for the current request; throws when the request was not authenticated. */
export function requestOwner(c: Context): string {
  const ownerId = c.get(OWNER_CONTEXT_KEY);
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new Error('missing authenticated owner');
  }
  return ownerId;
}

const OWNER_EMAIL_KEY = 'ownerEmail';

export function setRequestOwnerEmail(c: Context, email: string): void {
  c.set(OWNER_EMAIL_KEY, email);
}

/** The owner's account email when the session carries one. */
export function requestOwnerEmail(c: Context): string | undefined {
  const email: unknown = c.get(OWNER_EMAIL_KEY);
  return typeof email === 'string' && email.length > 0 ? email : undefined;
}

/**
 * Owner derivation for the durable event log (AU2).
 *
 * Event payloads are never trusted for the owner itself: ids in the payload are pointers into
 * persisted rows, and the recorded row owner wins. Anything that resolves to no persisted row
 * lands on UNKNOWN_OWNER, which account-mode subscribers never see.
 *
 * The owner rules are shared with the in-memory store and live once, in juno-agent (contracts/owner-events).
 */
import { isRecord, readString } from './guards.js';

export { UNKNOWN_OWNER, ownerCollisionMessage, resolveEventOwner } from 'juno-agent/contracts/owner-events';
export type { OwnerLookup } from 'juno-agent/contracts/owner-events';

/** Owner id persisted on docs (client models rarely declare it; read it safely). */
export function docOwnerId(doc: unknown): string | undefined {
  return isRecord(doc) ? readString(doc, 'ownerId') : undefined;
}

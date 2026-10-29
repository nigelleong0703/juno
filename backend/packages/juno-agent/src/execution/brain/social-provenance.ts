// Session provenance and ownership for the social context: relationship detail
// (roster, conversation members/title) renders only for a valid session key
// plus an attached wake bound to this agent/conversation/session whose
// principal matches the resolved owner. A recorded owner alone never
// authorizes anything; unknown ownership authorizes nothing.
import type { WakeEvent } from '../../contracts/index.js';
import type { SocialContextInput } from './social-context.js';
import { quoteId } from './social-format.js';
import { readString } from './social-read.js';

export interface Provenance {
  keyValid: boolean;
  wakePresent: boolean;
  wakeBound: boolean;
  principal: string | undefined;
}

// Ownership comes only from the record itself: ownerId, or the authenticated wake
// identity matching the recorded creator. Nothing else may invent ownership. Unknown owners close the directory.
export function resolveOwner(
  agentDoc: object | undefined,
  wake: WakeEvent[],
): { ownerId: string | undefined; derived: boolean } {
  if (agentDoc === undefined) return { ownerId: undefined, derived: false };
  const recorded = readString(agentDoc, 'ownerId');
  if (recorded !== undefined) return { ownerId: recorded, derived: false };
  const createdBy = readString(agentDoc, 'createdBy');
  const first = wake[0];
  const wakeOwner = first !== undefined && typeof first.ownerId === 'string' && first.ownerId.length > 0 ? first.ownerId : undefined;
  if (createdBy !== undefined && wakeOwner !== undefined && wakeOwner === createdBy) {
    return { ownerId: wakeOwner, derived: true };
  }
  return { ownerId: undefined, derived: false };
}

// Session provenance: the session key must bind this agent to this conversation, and
// a wake must be attached and bound to the same agent, conversation, and session key.
// The principal is the authenticated wake owner; a rebuild without a wake carries no
// principal, so the relationship context is unavailable.
export function describeProvenance(input: SocialContextInput, expectedKey: string): Provenance {
  const keyValid = input.sessionKey === expectedKey;
  const first = input.wake[0];
  if (first === undefined) return { keyValid, wakePresent: false, wakeBound: false, principal: undefined };
  const principal = typeof first.ownerId === 'string' && first.ownerId.length > 0 ? first.ownerId : undefined;
  const wakeBound =
    keyValid &&
    principal !== undefined &&
    first.agentId === input.agentId &&
    first.conversationId === input.conversationId &&
    first.sessionKey === expectedKey;
  return { keyValid, wakePresent: true, wakeBound, principal };
}

// Relationship context (roster, conversation members/title) is authorized only by
// provenance: a valid session key plus an attached wake bound to this
// agent/conversation/session whose principal matches the resolved owner. A recorded
// owner alone never authorizes anything: without an authenticated wake the
// relationship context is unavailable. Unknown ownership authorizes nothing.
export function authorizeRelationshipOwner(resolvedOwner: string | undefined, provenance: Provenance): string | undefined {
  if (!provenance.keyValid || !provenance.wakeBound) return undefined;
  if (resolvedOwner === undefined) return undefined;
  if (provenance.principal !== resolvedOwner) return undefined;
  return resolvedOwner;
}

export function appendProvenanceNote(lines: string[], resolvedOwner: string | undefined, provenance: Provenance): void {
  if (!provenance.keyValid) {
    lines.push('- Relationship context withheld: the session key is unvalidated for this agent and conversation.');
    return;
  }
  if (!provenance.wakePresent) {
    lines.push('- Relationship context withheld: no authenticated wake event attached.');
    return;
  }
  if (provenance.wakePresent && !provenance.wakeBound) {
    lines.push('- Relationship context withheld: the wake event does not match this agent, conversation, and session.');
    return;
  }
  if (provenance.wakeBound && resolvedOwner !== undefined && provenance.principal !== undefined && provenance.principal !== resolvedOwner) {
    lines.push('- Relationship context withheld: the wake principal ' + quoteId(provenance.principal) + ' does not match the recorded owner ' + quoteId(resolvedOwner) + '.');
  }
}

/**
 * Relationship-layer helpers (RA1): ownership validation, membership-based
 * conversation resolution and truthful pagination over owner-visible docs.
 *
 * Existing conversation.agentIds / memberIds arrays stay canonical; no second copied
 * list is introduced. Ownership is read with type guards (docs may carry an ownerId
 * field that the client zod models do not declare).
 */

import type { Collection, Doc, Store } from '@agent-desktop/contracts';
import type { Agent, Conversation } from '@agent-desktop/public-contracts';

export interface RelationshipError {
  status: 400 | 403 | 404;
  code: string;
  message: string;
}

export function relationshipError(status: 400 | 403 | 404, code: string, message: string): RelationshipError {
  return { status, code, message };
}

export function isRelationshipError(value: unknown): value is RelationshipError {
  if (typeof value !== 'object' || value === null) return false;
  if (!('status' in value) || !('code' in value) || !('message' in value)) return false;
  const status: unknown = value.status;
  return status === 400 || status === 403 || status === 404;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Owner id persisted on docs (the client models do not declare it; read it safely). */
export function docOwnerId(doc: unknown): string | undefined {
  if (!isRecord(doc)) return undefined;
  const value: unknown = doc['ownerId'];
  return typeof value === 'string' ? value : undefined;
}

export function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Canonical visibility precedence (docs/AGENT-CONTEXT): the recorded owner has
 * authority; the creator fallback applies only when no owner is recorded; a recorded
 * foreign owner never yields to createdBy. Unknown owners fail closed.
 */
export function isAgentVisible(agent: Agent, ownerId: string): boolean {
  const owner = docOwnerId(agent);
  if (owner === ownerId) return true;
  if (owner !== undefined) return false;
  return agent.createdBy === ownerId;
}

/**
 * Mutation guard: visibility is not edit permission. Only the recorded owner may
 * mutate; the creator fallback applies only when no owner is recorded. A published
 * foreign agent stays read-only for non-owners. Own legacy rows (owner or creator
 * equal to the requester) remain editable.
 */
export function canMutateAgent(agent: Agent, ownerId: string): boolean {
  const owner = docOwnerId(agent);
  if (owner !== undefined) return owner === ownerId;
  return agent.createdBy === ownerId;
}

/** A conversation is visible when the owner created it or belongs to its members. */
export function isConversationVisible(conv: Conversation, ownerId: string): boolean {
  if (docOwnerId(conv) === ownerId) return true;
  return conv.memberIds.includes(ownerId);
}

export interface ResolvedMembers {
  agents: Agent[];
  memberAgentIds: string[];
}

/**
 * Validate every requested conversation member: existence, authorization for the
 * authenticated owner. Duplicates are collapsed; nothing is guessed.
 */
export async function resolveConversationMembers(
  store: Store,
  ownerId: string,
  requestedIds: string[],
): Promise<ResolvedMembers | RelationshipError> {
  const memberAgentIds = dedupeIds(requestedIds);
  if (memberAgentIds.length === 0) {
    return relationshipError(400, 'CONVERSATION_MEMBERS_REQUIRED', 'At least one member agent is required');
  }
  const agents: Agent[] = [];
  const missing: string[] = [];
  for (const id of memberAgentIds) {
    const agent = await store.get('agents', id);
    if (!agent) {
      missing.push(id);
      continue;
    }
    agents.push(agent);
  }
  if (missing.length > 0) {
    return relationshipError(404, 'AGENT_NOT_FOUND', 'Unknown agents: ' + missing.join(', '));
  }
  const foreign: string[] = [];
  for (const agent of agents) {
    const visible = isAgentVisible(agent, ownerId);
    if (!visible) foreign.push(agent.id);
  }
  if (foreign.length > 0) {
    return relationshipError(403, 'AGENT_FORBIDDEN', 'Agents not shared with you: ' + foreign.join(', '));
  }
  return { agents, memberAgentIds };
}

export interface Listed<C extends Collection> {
  items: Array<Doc<C>>;
  /** True when the page cap stopped the scan; callers must not present items as complete. */
  truncated: boolean;
}

/** Bounded scan through the store's own keyset pagination; truncation is signaled. */
export async function listAll<C extends Collection>(
  store: Store,
  collection: C,
  maxPages = 50,
): Promise<Listed<C>> {
  const items: Array<Doc<C>> = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < maxPages; guard++) {
    const page = await store.list(collection, { limit: 200, cursor });
    for (const item of page.items) items.push(item);
    if (!page.nextCursor) return { items, truncated: false };
    cursor = page.nextCursor;
  }
  return { items, truncated: true };
}

export interface Paginated<T> {
  items: T[];
  nextCursor?: string;
}

/** Truthful offset pagination over an already-filtered list. */
export function paginateFiltered<T extends { id: string }>(
  all: T[],
  limitRaw: unknown,
  cursorRaw: unknown,
): Paginated<T> {
  let limit = 50;
  if (typeof limitRaw === 'string' && limitRaw !== '') {
    const parsed = Number.parseInt(limitRaw, 10);
    if (Number.isInteger(parsed) && parsed > 0) limit = Math.min(parsed, 1000);
  }
  let offset = 0;
  if (typeof cursorRaw === 'string' && cursorRaw !== '') {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8'));
      if (isRecord(parsed)) {
        const rawOffset: unknown = parsed['offset'];
        if (typeof rawOffset === 'number' && Number.isInteger(rawOffset) && rawOffset > 0) {
          offset = Math.min(rawOffset, all.length);
        }
      }
    } catch {
      offset = 0;
    }
  }
  const items = all.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const nextCursor =
    nextOffset < all.length
      ? Buffer.from(JSON.stringify({ offset: nextOffset })).toString('base64url')
      : undefined;
  return { items, nextCursor };
}

/**
 * Shared read-only relationship policy for agent tools.
 *
 * Mirrors packages/brain/src/social-context.ts (BC1, the isolation authority):
 * ownership comes from the record itself (ownerId, else createdBy corroborated by
 * the authenticated requester); unknown
 * ownership closes access instead of opening it. Tools must not invent a
 * different policy here.
 */
import type { Store, ToolContext } from '../../../contracts/index.js';
import { LIMITS } from '../../../contracts/index.js';
import { meaningfulRole } from '../../../execution/brain/social-format.js';
import { listAll } from '../../memory/util.js';
import { CHAIN_OWNER_ONLY, profileAudience, type AudienceWake } from '../../profile/index.js';

/**
 * What a wake from another agent carries about its sender (payload fields), so the receiver reads "[from agent Atlas (travel)]"
 * and not a bare id: the name and, when it has one, the role (the default "New agent" title is not a role). With `chain` (the
 * sending run's conversation and wake) it also carries whether that run was owner-only, so the receiver can tell the owner's
 * own peer chain from one that started with someone else (BACKEND 5.3).
 */
export async function peerSenderPayload(store: Store, agentId: string, chain?: { conversationId: string; wake: AudienceWake }): Promise<Record<string, string | boolean>> {
  const agent = await store.get('agents', agentId).catch(() => null);
  const name = readString(agent, 'name');
  const role = meaningfulRole(readString(agent, 'title'));
  const ownerOnly = chain === undefined ? false : (await profileAudience(store, { agentId, conversationId: chain.conversationId, wake: [chain.wake] })).ownerOnly;
  return {
    ...(name === undefined ? {} : { fromAgentName: name }),
    ...(role === undefined ? {} : { fromAgentRole: role }),
    ...(ownerOnly ? { [CHAIN_OWNER_ONLY]: true } : {}),
  };
}

export function readString(doc: unknown, key: string): string | undefined {
  if (typeof doc !== 'object' || doc === null) return undefined;
  const value: unknown = Reflect.get(doc, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readBoolean(doc: unknown, key: string): boolean | undefined {
  if (typeof doc !== 'object' || doc === null) return undefined;
  const value: unknown = Reflect.get(doc, key);
  return typeof value === 'boolean' ? value : undefined;
}

export function readStringArray(doc: unknown, key: string): string[] | undefined {
  if (typeof doc !== 'object' || doc === null) return undefined;
  const value: unknown = Reflect.get(doc, key);
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

export interface ResolvedOwner {
  ownerId: string | undefined;
  derived: boolean;
}

export function resolveOwner(selfAgent: unknown, requesterId: string): ResolvedOwner {
  const recorded = readString(selfAgent, 'ownerId');
  if (recorded !== undefined) return { ownerId: recorded, derived: false };
  const createdBy = readString(selfAgent, 'createdBy');
  if (createdBy !== undefined && createdBy === requesterId) {
    return { ownerId: requesterId, derived: true };
  }
  return { ownerId: undefined, derived: false };
}

export interface Visibility {
  visible: boolean;
  unverified: boolean;
}

/**
 * Directory policy (BC1/RA1, same as the brain roster): the requester's own agents only.
 * This exposes public metadata (id, name, handle, role) only — visibility here grants no
 * delegation, roster borrowing, or action rights. Unknown ownership excludes.
 */
export function isAgentVisible(candidate: unknown, opts: { ownerId: string }): Visibility {
  const candidateOwner = readString(candidate, 'ownerId');
  if (candidateOwner === undefined) {
    if (readString(candidate, 'createdBy') !== opts.ownerId) return { visible: false, unverified: false };
    return { visible: true, unverified: true };
  }
  return { visible: candidateOwner === opts.ownerId, unverified: false };
}

/**
 * Action policy: mutation/sending targets must sit in the requester's own
 * graph (recorded owner, else legacy creator). Published directory metadata
 * does not authorize cross-owner actions; those stay denied until an
 * explicit delegation mechanism exists.
 */
export function isOwnedAgent(candidate: unknown, ownerId: string): boolean {
  const candidateOwner = readString(candidate, 'ownerId');
  if (candidateOwner !== undefined) return candidateOwner === ownerId;
  return readString(candidate, 'createdBy') === ownerId;
}

/** The refusal text when a name is already in use; the same words for the API (409) and the tools. */
export const agentNameTakenMessage = (name: string): string => `You already have an agent called "${name.trim()}". Agents are told apart by their names, so pick a different one.`;

const normalizedName = (name: string): string => name.trim().toLowerCase();

/** The owner's agents' names, normalized, leaving out `exceptId`. */
async function ownedAgentNames(store: Store, ownerId: string, exceptId?: string): Promise<Set<string>> {
  return new Set((await listAll(store, 'agents')).filter((agent) => agent.id !== exceptId && isOwnedAgent(agent, ownerId)).map((agent) => normalizedName(agent.name)));
}

/** True when another agent of the owner (not `exceptId`) already has this name, ignoring case and surrounding spaces. */
export async function agentNameTaken(store: Store, ownerId: string, name: string, exceptId?: string): Promise<boolean> {
  return (await ownedAgentNames(store, ownerId, exceptId)).has(normalizedName(name));
}

/** Names a new agent gets when its creator gives none (a blank "New agent" tap in an app, `agent_create` without a name), in this order. */
export const BLANK_AGENT_NAMES = ['Nova', 'Atlas', 'Sol', 'Mint', 'Echo', 'Iris', 'Orion', 'Sage', 'Rio', 'Wren', 'Juniper', 'Pixel'] as const;

/** The first name of the list the owner has not used yet; "Agent 2", "Agent 3"… once all are taken. */
export async function freshAgentName(store: Store, ownerId: string): Promise<string> {
  const taken = await ownedAgentNames(store, ownerId);
  const free = BLANK_AGENT_NAMES.find((name) => !taken.has(normalizedName(name)));
  if (free !== undefined) return free;
  for (let n = 2; ; n += 1) if (!taken.has('agent ' + String(n))) return 'Agent ' + String(n);
}

/** Stored labels are untrusted data: bound them and quote them so they read as values, never instructions. */
const MAX_LABEL = 120;

export function quoteLabel(value: string | undefined): string {
  if (value === undefined) return '"(unknown)"';
  const short = value.length > MAX_LABEL ? value.slice(0, MAX_LABEL) + '...' : value;
  return JSON.stringify(short);
}

export interface RequesterContext {
  selfAgent: unknown;
  ownerId: string;
  derivedOwner: boolean;
}

export async function requireRequesterContext(
  ctx: ToolContext,
): Promise<{ ok: true; value: RequesterContext } | { ok: false; error: string }> {
  if (ctx.ownerId.length === 0) {
    return { ok: false, error: 'Error: missing requester identity; refusing to disclose agents.' };
  }
  let selfAgent: unknown;
  try {
    selfAgent = await ctx.store.get('agents', ctx.agentId);
  } catch {
    return { ok: false, error: 'Error: the current agent record is unreadable; membership is unverified.' };
  }
  if (selfAgent === null) {
    return { ok: false, error: 'Error: no agent record for the current agent; membership is unverified.' };
  }
  const owner = resolveOwner(selfAgent, ctx.ownerId);
  if (owner.ownerId === undefined) {
    return {
      ok: false,
      error:
        'Error: ownership cannot be established for the current agent (no recorded owner and no corroborated creator identity). This is not proof that no other agents exist.',
    };
  }
  if (owner.ownerId !== ctx.ownerId) {
    return {
      ok: false,
      error: 'Error: the requester is not the recorded owner of the current agent; access denied.',
    };
  }
  return { ok: true, value: { selfAgent, ownerId: owner.ownerId, derivedOwner: owner.derived } };
}

export function clampLimit(limit: number | undefined, def: number, max: number): number {
  if (limit === undefined) return def;
  if (!Number.isInteger(limit) || limit < 1) return def;
  return Math.min(limit, max);
}

export interface RoomValidation {
  room: unknown;
}

/**
 * Revalidate a room action at execution time: the room must exist, be a room,
 * list the sender as a member, and list every
 * target as a member already. Anything else fails before any write/enqueue —
 * targets are never joined implicitly.
 */
export async function validateRoomAction(
  ctx: ToolContext,
  requester: RequesterContext,
  roomId: string,
  targets: string[],
  verb: string,
): Promise<{ ok: true; value: RoomValidation } | { ok: false; error: string }> {
  const currentHop = ctx.wake.hop?.depth ?? 0;
  if (currentHop >= LIMITS.chain.maxHopDepth) {
    return {
      ok: false,
      error:
        'Error: message depth exceeds limit (' + String(currentHop) + ' >= ' + String(LIMITS.chain.maxHopDepth) + '). Agent-to-agent loops are blocked.',
    };
  }
  const uniqueTargets = [...new Set(targets)];
  let room: unknown;
  try {
    room = await ctx.store.get('conversations', roomId);
  } catch {
    return { ok: false, error: 'Error: the room record is unreadable; ' + verb + ' denied.' };
  }
  if (room === null) return { ok: false, error: 'Error: room ' + roomId + ' does not exist; nothing was ' + verb + '.' };
  const kind = readString(room, 'kind');
  if (kind !== 'room') {
    return { ok: false, error: 'Error: conversation ' + roomId + ' is kind ' + (kind ?? 'unknown') + ', not a room; refusing to ' + verb + ' there.' };
  }
  const agentIds = readStringArray(room, 'agentIds') ?? [];
  if (!agentIds.includes(ctx.agentId)) {
    return { ok: false, error: 'Error: the current agent is not a member of room ' + roomId + '; ' + verb + ' denied.' };
  }
  const roomMembers = readStringArray(room, 'memberIds') ?? [];
  if (!roomMembers.includes(requester.ownerId)) {
    return { ok: false, error: 'Error: the requester is not a listed member of room ' + roomId + '; ' + verb + ' denied.' };
  }
  for (const targetId of uniqueTargets) {
    let target: unknown;
    try {
      target = await ctx.store.get('agents', targetId);
    } catch {
      return { ok: false, error: 'Error: the target agent record is unreadable; ' + verb + ' denied.' };
    }
    if (target === null) return { ok: false, error: 'Error: target agent ' + targetId + ' does not exist; nothing was ' + verb + '.' };
    if (!isOwnedAgent(target, requester.ownerId)) {
      return { ok: false, error: 'Error: target agent ' + targetId + ' is outside the requester’s own graph; cross-owner actions need explicit delegation.' };
    }
    if (!agentIds.includes(targetId)) {
      return { ok: false, error: 'Error: target agent ' + targetId + ' is not a member of room ' + roomId + '; refusing a hidden join.' };
    }
  }
  return { ok: true, value: { room } };
}

/** Store rows read per list call inside one tool call. */
const SCAN_PAGE_SIZE = 100;
/** Upper bound on store rows scanned per tool call; excess continues via cursor. */
const MAX_SCAN_ROWS_PER_CALL = 1000;

interface StreamPosition {
  /** Store cursor to resume from; absent means from the start. */
  s?: string;
  /** Authorized entries at or after s already yielded (or skipped as seen). */
  o: number;
}

function encodeStreamCursor(pos: StreamPosition): string {
  return Buffer.from(JSON.stringify(pos), 'utf8').toString('base64url');
}

function decodeStreamCursor(cursor: string): StreamPosition | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const offset: unknown = Reflect.get(raw, 'o');
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return undefined;
  const start: unknown = Reflect.get(raw, 's');
  if (start !== undefined && typeof start !== 'string') return undefined;
  const pos: StreamPosition = { o: offset };
  if (start !== undefined) pos.s = start;
  return pos;
}

export interface AuthorizedPage<T> {
  entries: T[];
  /** Opaque continuation; present only when more entries may exist. */
  nextCursor?: string;
  /** Per-call row cap hit with store rows remaining; follow nextCursor. */
  scanTruncated: boolean;
}

/**
 * Page over the authorized stream, not over raw store rows. The store is
 * scanned page by page (keyset order) and each row passes authorize(); the
 * opaque cursor resumes the store scan where it stopped, so authorized
 * entries beyond the first store page stay reachable. Work per call is
 * bounded; an unfinished scan reports scanTruncated with a continuation
 * instead of a dead end.
 */
export async function paginateAuthorized<T>(
  store: Store,
  collection: 'agents' | 'conversations',
  cursor: string | undefined,
  limit: number,
  authorize: (doc: unknown) => Promise<T | undefined>,
): Promise<{ ok: true; value: AuthorizedPage<T> } | { ok: false; error: string }> {
  let position: StreamPosition = { o: 0 };
  if (cursor !== undefined) {
    const decoded = decodeStreamCursor(cursor);
    if (decoded === undefined) {
      return { ok: false, error: 'Error: invalid cursor; pass back the nextCursor from the previous answer.' };
    }
    position = decoded;
  }
  let storeCursor = position.s;
  let skip = position.o;
  const out: T[] = [];
  let rowsScanned = 0;
  for (;;) {
    const query: { limit: number; orderBy: 'id'; cursor?: string } = { limit: SCAN_PAGE_SIZE, orderBy: 'id' };
    if (storeCursor !== undefined) query.cursor = storeCursor;
    let page;
    try {
      page = await store.list(collection, query);
    } catch {
      return { ok: false, error: 'Error: the ' + collection + ' list could not be read.' };
    }
    const pageStart = storeCursor;
    const authorized: T[] = [];
    for (const doc of page.items) {
      const entry = await authorize(doc);
      if (entry !== undefined) authorized.push(entry);
    }
    rowsScanned += page.items.length;
    if (skip >= authorized.length) {
      skip -= authorized.length;
      if (page.nextCursor === undefined) return { ok: true, value: { entries: out, scanTruncated: false } };
      storeCursor = page.nextCursor;
      if (rowsScanned >= MAX_SCAN_ROWS_PER_CALL) {
        return { ok: true, value: { entries: out, nextCursor: encodeStreamCursor({ s: storeCursor, o: 0 }), scanTruncated: true } };
      }
      continue;
    }
    const fresh = authorized.slice(skip);
    const consumedInPage = skip + Math.min(fresh.length, limit - out.length);
    skip = 0;
    for (const entry of fresh) {
      if (out.length >= limit) break;
      out.push(entry);
    }
    if (out.length >= limit) {
      const pageHasMore = consumedInPage < authorized.length;
      if (!pageHasMore && page.nextCursor === undefined) return { ok: true, value: { entries: out, scanTruncated: false } };
      if (!pageHasMore && page.nextCursor !== undefined) {
        return { ok: true, value: { entries: out, nextCursor: encodeStreamCursor({ s: page.nextCursor, o: 0 }), scanTruncated: false } };
      }
      return { ok: true, value: { entries: out, nextCursor: encodeStreamCursor({ s: pageStart, o: consumedInPage }), scanTruncated: false } };
    }
    if (page.nextCursor === undefined) return { ok: true, value: { entries: out, scanTruncated: false } };
    storeCursor = page.nextCursor;
    if (rowsScanned >= MAX_SCAN_ROWS_PER_CALL) {
      return { ok: true, value: { entries: out, nextCursor: encodeStreamCursor({ s: storeCursor, o: 0 }), scanTruncated: true } };
    }
  }
}

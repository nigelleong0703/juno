/**
 * Canonical user-message admission: validate mentions, resolve wake targets, store the
 * user_message item with its event, then enqueue one wake per target. Shared by
 * POST /v1/conversations/:id/messages and the firstMessage of POST /v1/conversations so
 * both paths admit a message through the same pipeline (no HTTP self-call). A caller that
 * passes a deterministic messageId gets retry-safe ids; no stronger exactly-once promise is made.
 *
 * The requestId conflict check is a read-then-write. agentd is a single process, so same-key
 * admissions are serialized in-process by withKeyLock (E64); a second concurrent request then sees
 * the first writer's row and replays or conflicts. Multiple agentd instances would need a store CAS.
 */
import type { Attachment, Conversation, ComposerPayload, Item, Mention } from '@agent-desktop/public-contracts';
import type { WakeEvent } from '@agent-desktop/contracts';
import { patchWhen, sessionKey, toPublicRequest, wakeEventSchema } from '@agent-desktop/contracts';
import { createLogger } from '@agent-desktop/log';
import { createHash, randomUUID } from 'node:crypto';
import { emitItemAdded } from 'juno-agent/execution/conversation-activity';
import { emitAgentStatus } from 'juno-agent/execution/agent-status';
import { ownerStore } from '../owner-scope.js';
import type { AgentdDeps } from './index.js';

/** What admitting a message needs: the store and the enqueuer (channel runners have no event bus). */
export type AdmissionDeps = Pick<AgentdDeps, 'store' | 'enqueuer'>;
import { isAgentVisible } from './relationships.js';

const log = createLogger({ service: 'agentd' });

type UserMessageItem = Extract<Item, { type: 'user_message' }>;

/** How the wake addresses its target agent; a trusted `direct`/`member` ask is never dropped. */
type WakeAddress = 'direct' | 'member' | 'everyone';

const keyTails = new Map<string, Promise<void>>();

/** Run fn after every earlier holder of the same key settles (in-process, per agentd). */
export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = keyTails.get(key) ?? Promise.resolve();
  const run = previous.then(fn);
  const tail = run.then(() => undefined, () => undefined);
  keyTails.set(key, tail);
  try {
    return await run;
  } finally {
    if (keyTails.get(key) === tail) keyTails.delete(key);
  }
}

/** Bare uuid so concurrent requests never collide on a timestamp-only id. */
function newItemId(): string {
  return 'itm-' + randomUUID();
}

/** Stable digest so a replayed idempotency key resolves to the same document ids. */
function digestId(prefix: string, parts: string[]): string {
  return prefix + createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24);
}

/** Deterministic conversation id for a client Idempotency-Key (retry reuses this row). */
export function idempotentConversationId(ownerId: string, key: string): string {
  return digestId('cvn-', [ownerId, key]);
}

/** Deterministic first-message id so a replay re-enqueues the same wake id (deduped upstream). */
export function idempotentMessageId(ownerId: string, key: string): string {
  return digestId('itm-', [ownerId, key, 'first-message']);
}

/** A refused admission; `status` is a safe HTTP code to echo to the caller. */
export interface AdmissionFailure {
  status: 400 | 403 | 404 | 409 | 503;
  code: string;
  message: string;
}

/** An admitted message, with the run it is in when exactly one agent was woken and Session named it (null otherwise). */
export type AdmissionResult = { ok: true; item: UserMessageItem; runId: string | null } | { ok: false; error: AdmissionFailure };

/** Room "wake everyone" aliases. Recognized by label so the same auth/validation path applies. */
const EVERYONE_MENTION_LABELS = ['@everyone', '@all'];

/** True for the explicit "wake all" aliases; any other mention names a specific member. */
export function isEveryoneMention(mention: Mention): boolean {
  return EVERYONE_MENTION_LABELS.includes(mention.label.trim().toLowerCase());
}

/** Agent-kind mentions must name room members; user mentions must name human members. */
function mentionViolation(mentions: Mention[], conv: Conversation): string | undefined {
  for (const mention of mentions) {
    if (isEveryoneMention(mention)) continue;
    if (mention.kind === 'agent' && !conv.agentIds.includes(mention.id)) return mention.id;
    if (mention.kind === 'user' && !conv.memberIds.includes(mention.id)) return mention.id;
  }
  return undefined;
}

/** Pre-write firstMessage check: a mention naming a non-member is refused before any store write. */
export function firstMessageViolation(conv: Conversation, payload: ComposerPayload): AdmissionFailure | undefined {
  const badMention = mentionViolation(payload.mentions || [], conv);
  if (badMention === undefined) return undefined;
  return { status: 400, code: 'MENTION_NOT_MEMBER', message: 'Mentioned agent is not a room member: ' + badMention };
}

/**
 * Resolve which agents a user message wakes. Direct and peer chats wake their single
 * member (which must exist; there is no fallback agent). Rooms wake only @everyone/@all
 * or the explicitly mentioned members — never an implicit host, floor or first member.
 */
async function resolveWakeTargets(
  deps: AdmissionDeps,
  conv: Conversation,
  ownerId: string,
  mentions: Mention[],
): Promise<string[] | AdmissionFailure> {
  if (conv.kind === 'direct' || conv.kind === 'peer') {
    const peerId = conv.agentIds[0];
    if (!peerId) {
      return { status: 400, code: 'DIRECT_AGENT_MISSING', message: 'Direct conversation has no agent' };
    }
    const agent = await deps.store.get('agents', peerId);
    if (!agent) {
      return { status: 404, code: 'AGENT_NOT_FOUND', message: 'Agent ' + peerId + ' not found' };
    }
    if (!isAgentVisible(agent, ownerId)) {
      return { status: 403, code: 'AGENT_FORBIDDEN', message: 'Agent not shared with you' };
    }
    return [peerId];
  }
  if (conv.kind === 'room') {
    // Mention-only rooms: an un-mentioned message wakes no one. `@everyone`/`@all` is the only
    // way to address the whole room, and every other target must be an explicit member mention.
    const candidateIds = mentions.some(isEveryoneMention)
      ? conv.agentIds
      : mentions.filter((m) => m.kind === 'agent' && !isEveryoneMention(m)).map((m) => m.id);
    const missing: string[] = [];
    const forbidden: string[] = [];
    for (const agentId of candidateIds) {
      const agent = await deps.store.get('agents', agentId);
      if (!agent) {
        missing.push(agentId);
        continue;
      }
      if (!isAgentVisible(agent, ownerId)) forbidden.push(agentId);
    }
    if (missing.length > 0) {
      return { status: 404, code: 'AGENT_NOT_FOUND', message: 'Unknown agents: ' + missing.join(', ') };
    }
    if (forbidden.length > 0) {
      return { status: 403, code: 'AGENT_FORBIDDEN', message: 'Agents not shared with you: ' + forbidden.join(', ') };
    }
    return candidateIds;
  }
  return [];
}

function isAdmissionFailure(value: unknown): value is AdmissionFailure {
  if (typeof value !== 'object' || value === null) return false;
  if (!('status' in value) || !('code' in value) || !('message' in value)) return false;
  const status: unknown = value.status;
  return status === 400 || status === 403 || status === 404 || status === 503;
}

/** The refusal for the first attachment that is not one of the owner's uploaded files, checked before any write. */
export async function missingAttachment(deps: AdmissionDeps, ownerId: string, attachments: Attachment[]): Promise<AdmissionFailure | undefined> {
  const resolved = await resolveAttachments(deps, ownerId, attachments);
  return isAdmissionFailure(resolved) ? resolved : undefined;
}

/**
 * Every attachment must name one of the owner's library files (what POST /v1/uploads returned); it is
 * rebuilt from that row, so a client cannot dress up a name, size or url. An id that is not there (a file
 * that was never uploaded, another owner's id) refuses the whole message: posting it anyway would show a
 * file in the chat that the agent never receives.
 */
async function resolveAttachments(
  deps: AdmissionDeps,
  ownerId: string,
  attachments: Attachment[],
): Promise<{ attachments: Attachment[]; agentIds: string[] } | AdmissionFailure> {
  if (attachments.length === 0) return { attachments, agentIds: [] };
  const library = ownerStore(deps, ownerId);
  const agentIds: string[] = [];
  const resolved: Attachment[] = [];
  for (const attachment of attachments) {
    const row = await library.get('library', attachment.id);
    if (row === null) {
      return { status: 400, code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment ' + attachment.name + ' was not uploaded; upload it with POST /v1/uploads and send the returned attachment' };
    }
    agentIds.push(row.id);
    resolved.push({ id: row.id, name: row.name, kind: row.kind === 'image' ? 'image' : 'file', mimeType: row.mimeType, sizeBytes: row.sizeBytes, ...(row.width !== undefined && row.height !== undefined ? { width: row.width, height: row.height } : {}) });
  }
  return { attachments: resolved, agentIds };
}

function buildUserMessageItem(
  id: string,
  conversationId: string,
  ownerId: string,
  payload: ComposerPayload,
  mentions: Mention[],
  attachments: Attachment[],
): UserMessageItem {
  return {
    id,
    conversationId,
    type: 'user_message',
    at: new Date().toISOString(),
    authorId: ownerId,
    text: payload.text || '',
    attachments,
    mentions,
  };
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return record;
}

/** True when a stored item carries the same composer-controlled content as the incoming one. */
function isSameUserMessage(stored: unknown, incoming: UserMessageItem): boolean {
  const record = plainRecord(stored);
  if (!record || record['type'] !== 'user_message') return false;
  return (
    record['conversationId'] === incoming.conversationId &&
    record['authorId'] === incoming.authorId &&
    record['text'] === incoming.text &&
    JSON.stringify(record['mentions'] ?? []) === JSON.stringify(incoming.mentions) &&
    JSON.stringify(record['attachments'] ?? []) === JSON.stringify(incoming.attachments)
  );
}

/**
 * A question card still open when the user types something else is superseded: the typed message is the
 * answer the agent gets, so the card closes (`expired`, shown as no longer open) instead of lingering.
 */
async function supersedeOpenQuestions(deps: AdmissionDeps, conversationId: string): Promise<void> {
  const open = await deps.store.list('requests', { where: { conversationId, kind: 'question', status: 'pending' }, limit: 50 });
  for (const request of open.items) {
    const closed = await patchWhen(deps.store, 'requests', request.id, (current) => current.status === 'pending', { status: 'expired', resolvedAt: new Date().toISOString() });
    if (closed === undefined) continue;
    await deps.store.emit({ type: 'request.resolved', request: toPublicRequest(closed) });
    await emitAgentStatus(deps.store, closed.agentId);
  }
}

/**
 * Admit one user message into an existing conversation. Validates mentions and wake targets
 * before any write, stores the item and its event in one transaction, then enqueues a wake per
 * target. A refused durable enqueue is surfaced (not acked) so the caller never reports success
 * for a message whose agents were not woken.
 */
export async function admitUserMessage(
  deps: AdmissionDeps,
  conv: Conversation,
  ownerId: string,
  payload: ComposerPayload,
  options?: { messageId?: string },
): Promise<AdmissionResult> {
  const messageId = options?.messageId;
  if (messageId === undefined) return admitUnlocked(deps, conv, ownerId, payload, undefined);
  return withKeyLock('items:' + messageId, () => admitUnlocked(deps, conv, ownerId, payload, messageId));
}

async function admitUnlocked(
  deps: AdmissionDeps,
  conv: Conversation,
  ownerId: string,
  payload: ComposerPayload,
  messageId: string | undefined,
): Promise<AdmissionResult> {
  const mentions = payload.mentions || [];
  const resolvedAttachments = await resolveAttachments(deps, ownerId, payload.attachments || []);
  if (isAdmissionFailure(resolvedAttachments)) return { ok: false, error: resolvedAttachments };
  const { attachments, agentIds: attachmentIds } = resolvedAttachments;
  const item = buildUserMessageItem(messageId ?? newItemId(), conv.id, ownerId, payload, mentions, attachments);
  // A deterministic id (from a client requestId) makes a replay find the stored message. Reusing
  // the key with different content is refused, and the same content is what gets re-enqueued.
  const stored = await deps.store.get('items', item.id);
  if (stored !== null && !isSameUserMessage(stored, item)) {
    return {
      ok: false,
      error: { status: 409, code: 'REQUEST_ID_CONFLICT', message: 'requestId was already used with a different message' },
    };
  }
  const violation = firstMessageViolation(conv, payload);
  if (violation !== undefined) return { ok: false, error: violation };
  const targets = await resolveWakeTargets(deps, conv, ownerId, mentions);
  if (isAdmissionFailure(targets)) {
    return { ok: false, error: targets };
  }
  if (stored === null) {
    await deps.store.tx(async (store) => {
      await store.put('items', item, { conversationId: conv.id });
      await emitItemAdded(store, conv.id, item);
    });
  }
  await supersedeOpenQuestions(deps, conv.id);
  const now = new Date().toISOString();
  const addressed: WakeAddress =
    conv.kind === 'direct' || conv.kind === 'peer'
      ? 'direct'
      : mentions.some(isEveryoneMention)
        ? 'everyone'
        : 'member';
  const runIds: Array<string | undefined> = [];
  for (const agentId of targets) {
    const wake: Omit<WakeEvent, 'status'> = {
      id: 'wk-' + item.id + '-' + agentId,
      ownerId,
      agentId,
      sessionKey: sessionKey(agentId, conv.id),
      conversationId: conv.id,
      kind: mentions.length > 0 ? 'room_mention' : 'user_message',
      origin: { type: 'user' },
      trusted: true,
      priority: 'user',
      payload: { text: payload.text || '', itemId: item.id, addressed, ...(attachmentIds.length === 0 ? {} : { attachmentIds }) },
      at: now,
    };
    // Every authenticated user wake steers: a message sent while this conversation's run is busy is
    // consumed by that run as a correction, never queued as a second run. Private idle batching and
    // room recipient selection are unchanged; only the busy mode is pinned here.
    const validated = wakeEventSchema.parse({ ...wake, mode: 'steer' as const });
    log.info({ agentId, conversationId: conv.id }, 'Enqueueing wake event for agent');
    // The decision (not the one-way send) carries the run this message is in, so the caller can name it.
    let enqueued: { accepted: boolean; reason?: string; runId?: string };
    try {
      enqueued = await deps.enqueuer.enqueue(validated, { awaitDecision: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: {
          status: 503,
          code: 'WAKE_ENQUEUE_FAILED',
          message: 'Message stored but the wake for agent ' + agentId + ' was not queued: ' + detail,
        },
      };
    }
    log.info({ wakeId: wake.id, enqueued }, 'Enqueued wake event');
    if (!enqueued.accepted) {
      const suffix = enqueued.reason !== undefined ? ': ' + enqueued.reason : '';
      return {
        ok: false,
        error: {
          status: 503,
          code: 'WAKE_ENQUEUE_FAILED',
          message: 'Message stored but the wake for agent ' + agentId + ' was not queued' + suffix,
        },
      };
    }
    runIds.push(enqueued.runId);
  }
  // One woken agent names its run. A room that woke several has one run per agent, so no single id is returned.
  return { ok: true, item, runId: targets.length === 1 ? (runIds[0] ?? null) : null };
}

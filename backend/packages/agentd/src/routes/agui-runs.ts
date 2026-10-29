import { type Hono } from 'hono';
import type { Doc } from '@agent-desktop/contracts';
import {
  composerPayloadSchema,
  type ComposerPayload,
  type ResolveRequestInput,
  type RunAgentInput,
  RunAgentInputSchema,
  resolveRequestInputSchema,
  type UserMessage,
} from '@agent-desktop/public-contracts';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { admitUserMessage } from './message-admission.js';
import { docOwnerId, isConversationVisible } from './relationships.js';
import { parseStoredRequest, type StoredRequest } from 'juno-agent/contracts/requests';
import { resolveRequestLocked, validateResolution, withRequestLocks } from './requests.js';

type ResumeEntry = NonNullable<RunAgentInput['resume']>[number];

interface ResumeFailure {
  code: string;
  status: 400 | 403 | 404 | 409 | 502;
  message: string;
  /** A product error body to answer verbatim (delivery failures keep their original code). */
  body?: unknown;
}

function resumeFailure(failure: ResumeFailure): Response {
  return Response.json(failure.body ?? { error: { code: failure.code, message: failure.message } }, { status: failure.status });
}

/** One pre-validated resume decision: the request row, the typed product decision, its binding. */
interface BoundResume {
  requestId: string;
  request: StoredRequest;
  decision: ResolveRequestInput;
  /** Already decided elsewhere: a replay is accepted only with the same decision payload. */
  replay: boolean;
}

/**
 * The standard AG-UI run entrypoint (docs/architecture/AGUI-MIGRATION.md): one production
 * ingress for RunAgentInput run starts and interrupt resumes. Authorization and admission are
 * exactly the product message path; the client never supplies history truth.
 *
 * Resume safety (bind the whole batch, then record any decision):
 * - every interruptId must exist, belong to the authorized owner AND this conversation;
 * - all entries of a batch bind to ONE interrupted run segment, and the batch must answer
 *   exactly that segment's still-pending requests (missing, partial and extra are all refused);
 * - expired requests are refused; an already-decided request replays only with the same
 *   decision payload, otherwise 409;
 * - only after every entry is bound and validated is the first decision recorded.
 */
export function registerAguiRuns(app: Hono, deps: AgentdDeps) {
  app.post('/v1/conversations/:id/runs', async (c) => {
    const ownerId = getOwnerId(c);
    const convId = c.req.param('id');
    const conv = await deps.store.get('conversations', convId);
    if (!conv) {
      return c.json({ error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation ' + convId + ' not found' } }, 404);
    }
    if (!isConversationVisible(conv, ownerId)) {
      return c.json({ error: { code: 'CONVERSATION_FORBIDDEN', message: 'Conversation not shared with you' } }, 403);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: { code: 'INVALID_BODY', message: 'Request body must be JSON' } }, 400);
    }
    const parsed = RunAgentInputSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: { code: 'INVALID_RUN_INPUT', message: 'Invalid RunAgentInput' } }, 400);
    }
    const input = parsed.data;
    // The route conversation is the authorization boundary; a mismatched threadId never admits.
    if (input.threadId !== convId) {
      return c.json({ error: { code: 'THREAD_ID_MISMATCH', message: 'RunAgentInput.threadId must be the authorized conversation' } }, 400);
    }

    const resumeEntries = input.resume ?? [];
    const resumeIds = resumeEntries.map((entry) => entry.interruptId);
    if (new Set(resumeIds).size !== resumeIds.length) {
      return resumeFailure(invalidResume('A resume batch names the same interrupt more than once'));
    }
    const bound: BoundResume[] = [];
    for (const entry of resumeEntries) {
      const binding = await bindResume(deps, ownerId, convId, entry);
      if ('code' in binding) return resumeFailure(binding);
      bound.push(binding);
    }
    if (bound.length > 0) {
      // A resume batch binds one interrupted run segment and answers exactly its still-pending
      // requests (missing, partial and extra are all refused).
      const segment = segmentOf(bound);
      if (typeof segment === 'object') return resumeFailure(segment);
      const pendingIds = await pendingRequestsOfSegment(deps, convId, segment);
      const entryIds = new Set(resumeIds);
      for (const pendingId of pendingIds) {
        if (!entryIds.has(pendingId)) {
          return resumeFailure(invalidResume('Interrupt ' + pendingId + ' of the interrupted run is not answered'));
        }
      }
      // Record the decisions under one batch lock, so a concurrent decision (the product route or
      // another resume batch) cannot interleave half a batch. The binding above refuses an
      // invalid batch before anything is recorded; inside the lock EVERY entry is re-read and
      // re-validated before the first decision is persisted. A lost race (another device decided
      // differently) is a conflict, never a silent overwrite. Delivery runs after each durable
      // decision and a 502 is retryable: a replay of the same batch re-attempts an undelivered wake.
      const failed = await withRequestLocks(resumeIds, async (): Promise<ResumeFailure | undefined> => {
        const fresh: BoundResume[] = [];
        for (const resume of bound) {
          const current = await bindResumeById(deps, ownerId, convId, resume.requestId, resume.decision);
          if ('code' in current) return current;
          fresh.push(current);
        }
        const freshSegment = segmentOf(fresh);
        if (typeof freshSegment === 'object') return freshSegment;
        for (const resume of fresh) {
          const outcome = await resolveRequestLocked(deps, ownerId, resume.requestId, resume.decision, true);
          if (outcome.status === 200) continue;
          return {
            code: outcome.status === 502 ? 'WAKE_DELIVERY_FAILED' : 'INVALID_RESUME',
            status: outcome.status,
            message: 'Request ' + resume.requestId + ' was not resolved',
            body: outcome.body,
          };
        }
        // All valid decisions are durable before the first awakeable/wake is delivered. This is
        // ordered persistence, not a batch transaction: storage failures are surfaced, and retries
        // bind the saved first decisions and re-deliver only the missing deliveries.
        for (const resume of fresh) {
          const outcome = await resolveRequestLocked(deps, ownerId, resume.requestId, resume.decision);
          if (outcome.status !== 200) return {
            code: 'WAKE_DELIVERY_FAILED', status: outcome.status,
            message: 'Request ' + resume.requestId + ' delivery failed', body: outcome.body,
          };
        }
        return undefined;
      });
      if (failed !== undefined) return resumeFailure(failed);
      // The messages of a resume are context hints only: the interrupted turn is already
      // admitted, and a resume never admits a user message (historical or not).
      return c.json({ runId: segment }, 202);
    }

    // A fresh start: the newest user message is the new turn. A message id already stored in THIS
    // conversation is an idempotent retry (the wake id is stable and the Session dedupes it), so
    // admission runs again and can re-deliver a wake that failed after the item was stored.
    const turn = [...input.messages].reverse().find((message): message is UserMessage => message.role === 'user');
    if (turn === undefined) {
      return c.json({ error: { code: 'EMPTY_RUN_INPUT', message: 'RunAgentInput carries no new turn' } }, 400);
    }
    const stored = await deps.store.get('items', turn.id);
    if (stored !== null && (stored.conversationId !== convId || stored.type !== 'user_message')) {
      return c.json({ error: { code: 'REQUEST_ID_CONFLICT', message: 'RunAgentInput message id belongs to another conversation or item' } }, 409);
    }
    let payload: { text: string; attachments?: unknown[] };
    try {
      const composer = composerOf(input);
      if (composer === 'invalid') {
        // A composer payload that fails the product schema (too many attachments, bad mention, ...) is
        // refused; falling back to the bare message text would silently drop the attachments.
        return c.json({ error: { code: 'INVALID_MESSAGE', message: 'Invalid composer payload' } }, 400);
      }
      payload = userPayloadOf(turn, composer);
    } catch (error) {
      if (error instanceof UnsupportedContentError) {
        return c.json({ error: { code: 'UNSUPPORTED_CONTENT', message: error.message } }, 400);
      }
      throw error;
    }
    const composer = composerPayloadSchema.safeParse(payload);
    if (!composer.success) {
      return c.json({ error: { code: 'INVALID_MESSAGE', message: 'Invalid user message content' } }, 400);
    }
    const admitted = await admitUserMessage(deps, conv, ownerId, composer.data, { messageId: turn.id });
    if (!admitted.ok) {
      return c.json({ error: { code: admitted.error.code, message: admitted.error.message } }, admitted.error.status);
    }
    return c.json({ item: admitted.item, runId: admitted.runId ?? input.runId }, 202);
  });
}

const invalidResume = (message: string): ResumeFailure => ({ code: 'INVALID_RESUME', status: 400, message });

/** Load, authorize and bind ONE resume entry to this owner and conversation. */
async function bindResume(deps: AgentdDeps, ownerId: string, convId: string, entry: ResumeEntry): Promise<BoundResume | ResumeFailure> {
  const found = await deps.store.get('requests', entry.interruptId);
  if (!found) {
    return { code: 'REQUEST_NOT_FOUND', status: 404, message: 'No request ' + entry.interruptId };
  }
  if (docOwnerId(found) !== ownerId) {
    return { code: 'REQUEST_FORBIDDEN', status: 403, message: 'Request ' + entry.interruptId + ' belongs to another owner' };
  }
  const request = parseStoredRequest(found);
  if (request.conversationId !== convId) {
    return { code: 'REQUEST_BOUND_ELSEWHERE', status: 400, message: 'Request ' + entry.interruptId + ' belongs to another conversation' };
  }
  const decision = resumeDecisionOf(entry);
  if (decision === undefined) return invalidResume('Invalid resume payload for ' + entry.interruptId);
  return bindDecision(ownerId, convId, entry.interruptId, decision, found);
}

/** Re-bind one already-authorized entry inside the batch lock, against the CURRENT stored row. */
async function bindResumeById(
  deps: AgentdDeps,
  ownerId: string,
  convId: string,
  requestId: string,
  decision: ResolveRequestInput,
): Promise<BoundResume | ResumeFailure> {
  const found = await deps.store.get('requests', requestId);
  if (!found) return { code: 'REQUEST_NOT_FOUND', status: 404, message: 'No request ' + requestId };
  return bindDecision(ownerId, convId, requestId, decision, found);
}

async function bindDecision(
  ownerId: string,
  convId: string,
  requestId: string,
  decision: ResolveRequestInput,
  found: Doc<'requests'>,
): Promise<BoundResume | ResumeFailure> {
  if (docOwnerId(found) !== ownerId) {
    return { code: 'REQUEST_FORBIDDEN', status: 403, message: 'Request ' + requestId + ' belongs to another owner' };
  }
  const request = parseStoredRequest(found);
  if (request.conversationId !== convId) {
    return { code: 'REQUEST_BOUND_ELSEWHERE', status: 400, message: 'Request ' + requestId + ' belongs to another conversation' };
  }
  if (request.status === 'expired') {
    return { code: 'REQUEST_EXPIRED', status: 400, message: 'Request ' + requestId + ' expired' };
  }
  if (request.runId === undefined) return invalidResume('Request ' + requestId + ' has no run to resume');
  if (request.status !== 'pending') {
    if (!sameDecision(request, decision)) {
      return { code: 'DECISION_CONFLICT', status: 409, message: 'Request ' + requestId + ' was already decided differently' };
    }
    return { requestId, request, decision, replay: true };
  }
  // Pre-validate the typed decision exactly like the product route would, so the batch is
  // all-or-nothing: nothing is recorded when any entry would be refused.
  const invalidDecision = validateResolution(request, decision);
  if (invalidDecision !== undefined) return invalidResume(invalidDecision.message);
  return { requestId, request, decision, replay: false };
}

/** The one run segment this batch binds to: all entries' requests must share one runId. */
function segmentOf(bound: BoundResume[]): string | ResumeFailure {
  const runIds = new Set(bound.map((resume) => resume.request.runId).filter((id): id is string => id !== undefined));
  if (runIds.size === 1) {
    for (const runId of runIds) return runId;
  }
  if (runIds.size === 0) return invalidResume('No resumed request carries a run');
  return { code: 'INVALID_RESUME', status: 400, message: 'A resume batch must answer one interrupted run, got ' + runIds.size };
}

/** The still-pending request ids of the interrupted segment in this conversation (fully paginated, conversation-scoped). */
async function pendingRequestsOfSegment(deps: AgentdDeps, convId: string, segmentRunId: string): Promise<string[]> {
  const pending: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.store.list('requests', {
      limit: 200,
      where: { conversationId: convId },
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const row of page.items) {
      const request = parseStoredRequest(row);
      if (request.runId === segmentRunId && request.status === 'pending') pending.push(request.id);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return pending;
}

/** Map a standard resume entry to the typed product decision it carries. */
function resumeDecisionOf(entry: ResumeEntry): ResolveRequestInput | undefined {
  if (entry.status === 'cancelled') {
    if (entry.payload === undefined || entry.payload === null) return { action: 'deny' };
    const cancelled = resolveRequestInputSchema.safeParse(entry.payload);
    return cancelled.success && cancelled.data.action === 'deny' ? cancelled.data : undefined;
  }
  if (typeof entry.payload === 'string' && entry.payload.length > 0) {
    return { action: 'answer', answers: { text: entry.payload } };
  }
  const parsed = resolveRequestInputSchema.safeParse(entry.payload);
  return parsed.success ? parsed.data : undefined;
}

/** Stable JSON: the same decision in a different key order is still the same decision. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => JSON.stringify(key) + ':' + canonical(entry));
    return '{' + entries.join(',') + '}';
  }
  return JSON.stringify(value) ?? 'null';
}

/** An already-decided request replays only when the new decision is the same one (action, scope, answers, note, delegations). */
function sameDecision(request: StoredRequest, decision: ResolveRequestInput): boolean {
  const stored = request.resolution ?? { action: request.status === 'approved' ? 'approve' : 'deny' };
  return canonical(stored) === canonical(decision);
}

/** The Juno composer payload the TS client sends with the standard input (`forwardedProps.juno.composer`). */
function composerOf(input: RunAgentInput): ComposerPayload | undefined | 'invalid' {
  const juno = (input.forwardedProps as { juno?: unknown } | undefined)?.juno;
  const composer = (typeof juno === 'object' && juno !== null ? (juno as { composer?: unknown }).composer : undefined);
  if (composer === undefined) return undefined;
  const parsed = composerPayloadSchema.safeParse(composer);
  return parsed.success ? parsed.data : 'invalid';
}

/**
 * The composer payload of the new turn. The full product composer (attachments, mentions,
 * replyTo, options) arrives at `forwardedProps.juno.composer`; the standard message content is
 * bound to it: the two must agree on the text, so neither side can silently drop or fake input.
 * Standard-only clients get the text; content parts that cannot be admitted (inline bytes) are
 * refused, never dropped.
 */
function userPayloadOf(message: UserMessage, composer: ComposerPayload | undefined): { text: string; attachments?: unknown[] } {
  if (composer !== undefined) {
    const content = contentTextOf(message);
    if (content !== '' && composer.text !== content) {
      throw new UnsupportedContentError('RunAgentInput.messages and forwardedProps.juno.composer disagree');
    }
    return composer;
  }
  if (typeof message.content === 'string') return { text: message.content };
  const text = contentTextOf(message);
  if (text !== '') return { text };
  // Non-text parts without a composer payload have no admission path: refuse, never drop.
  const supported = message.content.every((part) => part.type === 'text' || (part.source.type === 'url' && part.source.value.length > 0));
  if (supported) {
    const attachments = message.content
      .filter((part): part is Extract<UserMessage['content'][number], { type: 'image' | 'file' }> => part.type !== 'text')
      .map((part) => ({
        id: part.id ?? part.source.value,
        name: part.id ?? part.source.value.split('/').pop() ?? 'attachment',
        kind: part.type === 'image' ? 'image' : 'file',
        ...(part.source.mimeType === undefined ? {} : { mimeType: part.source.mimeType }),
        url: part.source.value,
      }));
    return attachments.length === 0 ? { text: '' } : { text: '', attachments };
  }
  throw new UnsupportedContentError('unsupported content part: inline bytes have no composer admission');
}

/** The text of a standard user message: a string body, or its text parts joined. */
function contentTextOf(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part): part is Extract<UserMessage['content'][number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

class UnsupportedContentError extends Error {}

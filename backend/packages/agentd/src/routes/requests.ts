import { type Hono } from 'hono';
import { approvalExpired, NotFoundError, parseStoredRequest, patchWhen, sessionKey, toPublicRequest, wakeEventSchema } from '@agent-desktop/contracts';
import type { StoredRequest, WakeEvent } from '@agent-desktop/contracts';
import { decisionCategorySchema, isDelegableCategory, uiInteractiveBlock, requestOutcomeSchema, resolveRequestInputSchema, validateUiAnswers } from '@agent-desktop/public-contracts';
import type {
  DelegationDraft,
  UiDoc,
  QuestionPayload,
  RequestAction,
  RequestDecision,
  RequestKind,
  RequestStatus,
  ResolveRequestInput,
} from '@agent-desktop/public-contracts';
import { emitAgentStatus } from 'juno-agent/execution/agent-status';
import { allowMacApp } from 'juno-agent/modules/mac-apps';
import { settleEffectReview } from 'juno-agent/modules/tasks/effect-review';
import { settleSilenceQuestion } from 'juno-agent/modules/proactive/silence';
import { getOwnerId } from '../auth.js';
import { parseListQueryWithWhere } from './query-helpers.js';
import { upsertDelegation } from './delegations.js';
import { admitUserMessage } from './message-admission.js';
import { settleOwnerClaim } from '../channels/owner-claim.js';
import type { AgentdDeps } from './index.js';

/** What recording a decision needs; channel buttons resolve requests without an event bus. */
export type DecisionDeps = Pick<AgentdDeps, 'store' | 'enqueuer' | 'channels' | 'computerd'>;

/** The `status` filter of GET /v1/requests that lists every decided request (approved, denied, answered, expired). */
const RESOLVED = 'resolved';

/** Terminal status for each decision action: a resolved request never goes back to pending. */
const TERMINAL_STATUS: Record<RequestAction, RequestStatus> = {
  approve: 'approved',
  deny: 'denied',
  answer: 'answered',
};

/** Actions each request kind accepts: a question is answered or declined, the rest approved or denied. */
const ACTIONS_PER_KIND: Record<RequestKind, RequestAction[]> = {
  question: ['answer', 'deny'],
  approval: ['approve', 'deny'],
  signin: ['approve', 'deny'],
  admin: ['approve', 'deny'],
  // approve = "done, back to you" (handing control back approves it too), deny = "I can't help".
  computer: ['approve', 'deny'],
  // Values only arrive through POST /v1/requests/:id/secure-input; resolve can only cancel.
  secure_input: ['deny'],
  // The card only asks the owner to connect an app; the server resolves it when they do, "deny" dismisses it.
  connect: ['deny'],
};

export interface ErrorBody {
  error: { code: string; message: string; /** Per-field messages by question field id (invalid answers). */ fields?: Record<string, string> };
}

export function errorBody(code: string, message: string, fields?: Record<string, string>): ErrorBody {
  return { error: fields ? { code, message, fields } : { code, message } };
}

/** The request was closed by someone else before this decision could be recorded. */
export const REQUEST_NOT_PENDING = 'REQUEST_NOT_PENDING';

/** 409 when the decision lost to another write on the request, 502 when recording or delivering it failed. */
export function decisionErrorStatus(error: ErrorBody): 409 | 502 {
  return error.error.code === REQUEST_NOT_PENDING ? 409 : 502;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The exact validated decision stored with the request. A retry re-delivers this instead of the retry
 * body, so repeating the call cannot rewrite an already-recorded decision.
 */
function storedResolution(request: StoredRequest): unknown {
  return request.resolution ?? reconstructedResolution(request);
}

/** Fallback for docs written before the resolution was persisted (or by an older agentd). */
function reconstructedResolution(request: StoredRequest): Record<string, unknown> {
  if (request.status === 'answered' && request.payload.kind === 'question') {
    return { action: 'answer', answers: request.payload.answers ?? {} };
  }
  const action = request.status === 'approved' ? 'approve' : 'deny';
  const note = request.decision?.note;
  return note ? { action, note } : { action };
}

/**
 * A request that belongs to a run does not need a conversation wake: the suspended run installs its
 * awakeable on the request and resumes from the stored decision (run-input.ts). Waking the session as
 * well would deliver the same resolution twice, so the route leaves it to the run. A question never
 * suspends its run: its answer is delivered as a user message instead (answerAsMessage).
 */
function runOwnsWake(request: StoredRequest): boolean {
  return (request.kind !== 'question' || request.reconciliation !== undefined) && request.interrupted !== true && typeof request.runId === 'string' && request.runId.length > 0;
}

function needsDelivery(request: StoredRequest): boolean {
  if (request.kind === 'question') return request.reconciliation !== undefined
    ? (request.status === 'answered' && (request.awakeableId !== undefined || request.interrupted === true))
      || (request.status === 'denied' && request.awakeableId !== undefined)
    : request.status === 'answered';
  // A card that timed out is told to its run (to ask again); one that was only withdrawn or cancelled has nobody waiting.
  if ((request.status === 'expired' && request.decision?.reason !== 'timeout') || request.kind === 'connect') return false;
  if (request.awakeableId) return true;
  if (runOwnsWake(request)) return false;
  return typeof request.conversationId === 'string' && request.conversationId.length > 0;
}

function wakePayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value };
}

/**
 * The decision of a request whose run stopped waiting because the user typed instead (run-input.ts): the original
 * tool call was never performed, so the agent is told what was decided and what to do about it.
 */
function lateDecisionText(request: StoredRequest): string {
  if (request.reconciliation !== undefined) {
    const state = request.reconciliation.state;
    const decision = state === 'user_reported_succeeded'
      ? 'The owner reports success, but this is not a verified external receipt.'
      : state === 'user_confirmed_not_executed'
        ? 'The owner reports that it did not happen and authorized one retry; this is not machine evidence, and current permissions must be checked before acting.'
        : 'The outcome remains unknown, so the action must stay blocked until checked.';
    return `[system note, from the user's reconciliation card] This run stopped waiting before the decision arrived; the external action may or may not have happened. ${decision}`;
  }
  if (request.status === 'expired') return `[system note, from the user's tap on a card] The user approved "${request.title}" only after the approval had expired, so it was NOT performed. If it is still wanted, make the call again: that asks the user again.`;
  const decision = request.status === 'approved' ? 'approved' : request.status === 'answered' ? 'answered' : 'declined';
  const head = `[system note, from the user's tap on a card] The user ${decision} "${request.title}", which you stopped waiting for because they sent a message. That action was NOT performed.`;
  if (request.status !== 'approved') return head + ' Do not do it. Tell the user briefly if it matters.';
  if (request.kind === 'approval') return head + ' To go ahead, make the exact same call again now: this approval covers one identical call (same details) for 30 minutes, so no new card appears. If you change anything, a new approval is needed.';
  return head + ' Check the current state first, then continue from there.';
}

export function validateDecision(request: StoredRequest, input: ResolveRequestInput): InvalidAnswers | undefined {
  const allowed = ACTIONS_PER_KIND[request.kind];
  if (!allowed.includes(input.action)) {
    return { message: `A ${request.kind} request cannot be resolved with action "${input.action}"` };
  }
  if (input.action !== 'answer') return undefined;
  if (request.payload.kind !== 'question') return { message: 'Answers are only accepted for a question request' };
  return validateAnswers(request.payload, input.answers);
}

/**
 * The scopes that outlive one request. `always` (one auto rule per tool) is retired: old rules keep working, but a standing
 * permission is now a delegation of a KIND of decision with limits (BACKEND 8.0), so no new per-tool rule is made.
 * `delegate` (approve + allow this kind): only an approval with a brief the server found delegable (verified facts, a known
 * connector, only spending / speaking / public / committing); never for irreversible, sensitive or setup decisions.
 * Returns the delegations to create, or the message to refuse with.
 */
function delegationsFor(request: StoredRequest, input: ResolveRequestInput): { drafts: DelegationDraft[] } | { error: string } | undefined {
  if (input.scope === 'always') return { error: 'Always allowing one tool is retired: allow this kind of decision instead (scope "delegate")' };
  if (input.scope !== 'delegate') return undefined;
  if (request.kind !== 'approval' || request.payload.kind !== 'approval' || input.action !== 'approve') {
    return { error: 'Allowing this kind is only available when approving an approval request' };
  }
  const { brief, delegationOffer: offer } = request.payload;
  if (brief === undefined || offer === undefined) return { error: 'This approval cannot be allowed in advance' };
  const blocked = brief.categories.filter((category) => !isDelegableCategory(category));
  if (blocked.length > 0) return { error: `${blocked.join(', ')} is asked every time and cannot be allowed in advance` };
  if (!offer.delegable) return { error: offer.reason ?? 'This approval cannot be allowed in advance' };
  const drafts = input.delegations ?? offer.suggested;
  const covered = new Set(drafts.map((draft) => draft.category));
  if (!brief.categories.every((category) => covered.has(category))) return { error: 'Each kind of decision in this request needs a limit' };
  if (drafts.some((draft) => draft.platform.catalogId !== brief.platform.catalogId || !brief.categories.includes(draft.category))) {
    return { error: 'A delegation must be for this request\'s app and kinds of decision' };
  }
  return { drafts };
}

/** Complete validation shared with standard resume batches, before any decision or permission write. */
export function validateResolution(request: StoredRequest, input: ResolveRequestInput): InvalidAnswers | undefined {
  const invalid = validateDecision(request, input);
  if (invalid !== undefined) return invalid;
  const standing = delegationsFor(request, input);
  if (standing !== undefined && 'error' in standing) return { message: standing.error };
  if (input.scope === 'app') {
    const macApp = request.payload.kind === 'approval' ? request.payload.macApp : undefined;
    if (macApp?.purpose !== 'use' || input.action !== 'approve') {
      return { message: 'Always allow is only for approving a request to use an app on your Mac' };
    }
  }
  return undefined;
}

interface InvalidAnswers {
  message: string;
  fields?: Record<string, string>;
}

function validateAnswers(
  payload: QuestionPayload,
  answers: Record<string, string> | undefined
): InvalidAnswers | undefined {
  const result = validateUiAnswers(payload.ui, answers);
  if ('ok' in result) return undefined;
  const message = Object.entries(result.errors)
    .map(([id, error]) => `${id}: ${error}`)
    .join('; ');
  return { message, fields: result.errors };
}

function withAnswers(payload: QuestionPayload, answers: Record<string, string> | undefined): QuestionPayload {
  return answers === undefined ? payload : { ...payload, answers };
}

/** The answer as the user would have typed it: the chosen option labels, or one "Label: value" line per filled field. */
function answerText(ui: UiDoc, answers: Record<string, string>): string {
  const block = uiInteractiveBlock(ui);
  if (block?.type === 'choices') {
    const raw = answers[block.id] ?? '';
    const ids: unknown = block.multiple === true ? JSON.parse(raw) : [raw];
    const chosen = Array.isArray(ids) ? ids : [];
    return block.options.filter((option) => chosen.includes(option.id)).map((option) => option.label).join(', ');
  }
  if (block?.type === 'fields') {
    return block.fields.flatMap((field) => ((answers[field.id] ?? '').trim() === '' ? [] : [`${field.label}: ${answers[field.id]!.trim()}`])).join('\n');
  }
  return '';
}

/**
 * A question's answer is the user's next chat message, admitted like a typed one so the agent wakes the
 * same way. The message id is derived from the request, so a retried delivery stores and wakes once.
 */
async function answerAsMessage(deps: DecisionDeps, ownerId: string, request: StoredRequest): Promise<void> {
  if (request.payload.kind !== 'question' || request.conversationId === undefined) return;
  const conv = await deps.store.get('conversations', request.conversationId);
  if (conv === null) throw new Error('conversation ' + request.conversationId + ' not found');
  const asker = conv.kind === 'room' && conv.agentIds.includes(request.agentId) ? await deps.store.get('agents', request.agentId) : null;
  // A room wakes only mentioned agents, so the answer mentions the agent that asked (and nobody else), as the app's composer would.
  const mentions = asker === null ? [] : [{ kind: 'agent' as const, id: asker.id, label: '@' + asker.name }];
  const answer = answerText(request.payload.ui, request.payload.answers ?? {});
  const text = request.reconciliation !== undefined && request.interrupted === true
    ? answer + '\n\n' + lateDecisionText(request)
    : answer;
  const admitted = await admitUserMessage(deps, conv, ownerId, { text, mentions, attachments: [] }, { messageId: 'itm-answer-' + request.id });
  if (!admitted.ok) throw new Error(admitted.error.message);
}

/**
 * Deliver the resolution after the decision is durable. The ordering is deliberate and is not a
 * transaction: the decision is persisted first, delivery is attempted second, and a delivery failure is
 * reported to the caller instead of being swallowed, so a retry can re-attempt it. Re-delivery is deduped
 * by the deterministic wake id and, for an awakeable, by the persisted wakeDeliveredAt marker.
 */
async function deliverResolution(
  deps: DecisionDeps,
  ownerId: string,
  request: StoredRequest,
  value: unknown
): Promise<void> {
  if (request.kind === 'question') {
    if (request.reconciliation !== undefined) {
      if (request.awakeableId) await deps.enqueuer.resolveAwakeable(request.awakeableId, value);
      else if (request.interrupted === true && request.status === 'answered') await answerAsMessage(deps, ownerId, request);
      return;
    }
    if (request.channelClaim !== undefined) {
      // "Is this you?" for an unbound channel: the answer binds (or declines) the sender, not a chat message.
      if (request.status === 'answered') await settleOwnerClaim(deps, ownerId, request);
      return;
    }
    if (request.silenceQuestion !== undefined) {
      // "Want fewer of these?": yes writes a soft rule; the answer is not a chat message and wakes nobody.
      await settleSilenceQuestion({ store: deps.store, ...(deps.computerd?.home === undefined ? {} : { home: deps.computerd.home }) }, ownerId, request);
      return;
    }
    if (request.status === 'answered') await answerAsMessage(deps, ownerId, request);
    return;
  }
  if (request.awakeableId) {
    await deps.enqueuer.resolveAwakeable(request.awakeableId, value);
    return;
  }
  if (runOwnsWake(request) || !request.conversationId || request.kind === 'connect') return;
  const wake: Omit<WakeEvent, 'status'> = {
    id: `wk-req-${request.id}`,
    ownerId,
    agentId: request.agentId,
    sessionKey: sessionKey(request.agentId, request.conversationId),
    conversationId: request.conversationId,
    kind: 'request_resolved',
    origin: { type: 'user' },
    trusted: true,
    priority: 'user',
    payload: request.interrupted === true ? { ...wakePayload(value), text: lateDecisionText(request) } : wakePayload(value),
    at: new Date().toISOString(),
  };
  const result = await deps.enqueuer.enqueue(wakeEventSchema.parse(wake));
  if (!result.accepted) throw new Error(result.reason ?? 'wake delivery rejected');
}

async function markDelivered(deps: DecisionDeps, reqId: string): Promise<StoredRequest> {
  return parseStoredRequest(await deps.store.patch('requests', reqId, { wakeDeliveredAt: new Date().toISOString() }));
}

function deliveryError(error: unknown): ErrorBody {
  const message = error instanceof Error ? error.message : String(error);
  return errorBody('WAKE_DELIVERY_FAILED', message);
}

/** The approval's window (APPROVAL_WINDOW_MS) closed before this "yes". */
export const REQUEST_EXPIRED = 'REQUEST_EXPIRED';
const EXPIRED_MESSAGE = 'This approval expired before it was decided, so nothing was done. If it is still wanted, the agent asks again.';

/**
 * Closes a pending approval that was approved too late: it ends `expired` with reason `timeout` (outcome `timed_out`), is delivered to the run
 * that waits on it as a "no" (the run reads the status and tells the model to ask again), and answers the caller with a 409.
 */
async function expireApproval(deps: DecisionDeps, ownerId: string, request: StoredRequest): Promise<ResolveOutcome> {
  const now = new Date().toISOString();
  const resolution: ResolveRequestInput = { action: 'deny' };
  const decision: RequestDecision = { by: ownerId, at: now, mode: 'manual', scope: 'once', reason: 'timeout' };
  const closed = await deps.store.tx((tx) => patchWhen(tx, 'requests', request.id, (current) => current.status === 'pending', { status: 'expired', resolvedAt: now, decision, resolution }));
  if (closed === undefined) return { status: 409, body: errorBody(REQUEST_NOT_PENDING, `This request is already ${(await deps.store.get('requests', request.id))?.status ?? 'closed'}`) };
  const expired = parseStoredRequest(closed);
  await deps.store.emit({ type: 'request.resolved', request: toPublicRequest(expired) });
  if (!expired.awakeableId && !runOwnsWake(expired)) await emitAgentStatus(deps.store, expired.agentId);
  try {
    await deliverResolution(deps, ownerId, expired, resolution);
  } catch (error) {
    return { status: 502, body: deliveryError(error) };
  }
  await markDelivered(deps, request.id);
  return { status: 409, body: errorBody(REQUEST_EXPIRED, EXPIRED_MESSAGE) };
}

/**
 * Serializes decisions for one request inside this process: two concurrent submissions then run
 * read → validate → patch one after the other, so the second sees the first decision and returns it
 * instead of overwriting the chosen answer. Only the coordinator serves these routes (HTTP and the channel
 * buttons live there, and one coordinator holds the instance lock), so a process-local queue is enough for
 * decisions against each other. A decision against a worker's write (it withdraws or expires the same request) is
 * settled by the database instead: `recordDecision` and every worker-side close change the row only while it
 * is still `pending`, under the row lock (`patchWhen`).
 */
const inFlight = new Map<string, Promise<void>>();

export async function withRequestLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(key) ?? Promise.resolve();
  const run = previous.then(() => fn());
  const tail = run.then(() => undefined, () => undefined);
  inFlight.set(key, tail);
  try {
    return await run;
  } finally {
    if (inFlight.get(key) === tail) inFlight.delete(key);
  }
}

/**
 * Record a decision on a pending request, then deliver it to the waiting run (or the session). Shared by
 * resolve, the secure-input submission and the screen hand-back; callers hold `withRequestLock`. `input`
 * is what the run receives and what a retry re-delivers, so it must never carry a secret.
 */
export async function recordDecision(
  deps: DecisionDeps,
  ownerId: string,
  request: StoredRequest,
  input: ResolveRequestInput,
  payload: StoredRequest['payload'] = request.payload,
  deferDelivery = false,
): Promise<{ request: StoredRequest } | { error: ErrorBody }> {
  const now = new Date().toISOString();
  const decision: RequestDecision = {
    by: ownerId,
    at: now,
    mode: 'manual',
    scope: input.scope ?? 'once',
    ...(input.note ? { note: input.note } : {}),
    ...(input.action === 'deny' && input.reason !== undefined ? { reason: input.reason } : {}),
  };
  const patch: Partial<StoredRequest> = {
    status: TERMINAL_STATUS[input.action],
    resolvedAt: now,
    decision,
    payload,
    resolution: input,
  };
  if (request.reconciliation !== undefined) {
    const choice = input.action === 'answer' ? input.answers?.['recovery_outcome'] : undefined;
    const state = choice === 'reported_done' ? 'user_reported_succeeded'
      : choice === 'confirmed_absent_retry' ? 'user_confirmed_not_executed'
        : 'still_unknown';
    patch.reconciliation = { ...request.reconciliation, state, source: 'owner_report' };
  }
  // A review card's answer also settles (or keeps open) the run's effect review, in the same transaction.
  const decided = await deps.store.tx(async (tx) => {
    const row = await patchWhen(tx, 'requests', request.id, (current) => current.status === 'pending', patch);
    if (row !== undefined && row.reconciliation !== undefined) await settleEffectReview(tx, row);
    return row;
  });
  if (decided === undefined) {
    // A worker withdrew or expired it (or another decision landed) between the read and this write: that outcome stands.
    const now = await deps.store.get('requests', request.id);
    return { error: errorBody(REQUEST_NOT_PENDING, `This request is already ${now?.status ?? 'closed'}`) };
  }
  const resolved = parseStoredRequest(decided);
  // The event log is client-visible: it carries the public request only, never awakeableId.
  await deps.store.emit({ type: 'request.resolved', request: toPublicRequest(resolved) });
  // A run-bound request resumes its run, and the resume emits the status; emitting here would flash idle in between.
  if (!resolved.awakeableId && !runOwnsWake(resolved)) await emitAgentStatus(deps.store, resolved.agentId);
  if (deferDelivery) return { request: resolved };
  try {
    await deliverResolution(deps, ownerId, resolved, input);
  } catch (error) {
    return { error: deliveryError(error) };
  }
  return { request: await markDelivered(deps, request.id) };
}

export function registerRequests(app: Hono, deps: AgentdDeps) {
  app.get('/v1/requests', async (c) => {
    const query = parseListQueryWithWhere(c.req.query(), ['agentId', 'conversationId', 'runId', 'status', 'kind', 'parentId', 'ids']);
    const category = decisionCategorySchema.optional().safeParse(c.req.query('category') || undefined);
    const outcome = requestOutcomeSchema.optional().safeParse(c.req.query('outcome') || undefined);
    if (!category.success || !outcome.success) return c.json(errorBody('INVALID_QUERY', 'Unknown category or outcome'), 400);
    // History filters (0.22.0): by the kind of decision, and by how it ended. Applied to the page like the pending rows are skipped.
    const matches = (request: StoredRequest): boolean =>
      (category.data === undefined || (request.payload.kind === 'approval' && request.payload.brief?.categories.includes(category.data) === true))
      && (outcome.data === undefined || toPublicRequest(request).outcome === outcome.data);
    // `status=resolved`: the decision history (every non-pending request), newest first unless asked
    // otherwise. A page can hold fewer than `limit` rows (pending ones are skipped); follow nextCursor.
    if (query.where?.status === RESOLVED) {
      const { status: _status, ...where } = query.where;
      const page = await deps.store.list('requests', { ...query, where, orderBy: query.orderBy ?? 'at', order: query.order ?? 'desc' });
      return c.json({ items: page.items.filter((request) => request.status !== 'pending' && matches(request)).map(toPublicRequest), nextCursor: page.nextCursor });
    }
    const page = await deps.store.list('requests', {
      ...query,
    });
    return c.json({ items: page.items.filter(matches).map(toPublicRequest), nextCursor: page.nextCursor });
  });

  app.get('/v1/requests/:id', async (c) => {
    const req = await deps.store.get('requests', c.req.param('id'));
    if (!req) throw new NotFoundError('requests', c.req.param('id'));
    return c.json(toPublicRequest(req));
  });

  app.post('/v1/requests/:id/resolve', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = resolveRequestInputSchema.safeParse(body);
    if (!parsed.success) return c.json(errorBody('INVALID_RESOLUTION', 'Invalid request decision'), 400);
    const result = await resolveRequest(deps, getOwnerId(c), c.req.param('id'), parsed.data);
    return c.json(result.body, result.status);
  });
}

/** The outcome of resolving one request: the HTTP status and body the route answers with. */
export interface ResolveOutcome {
  status: 200 | 400 | 409 | 502;
  body: ReturnType<typeof toPublicRequest> | ErrorBody;
}

/**
 * Decide one pending request (the body of POST /v1/requests/:id/resolve), shared with the channel buttons so a tap on a
 * platform runs exactly the app's validation, delegation and delivery path. The whole read, validate, patch runs under one
 * per-request lock: a concurrent second decision must observe the first one instead of overwriting the answer.
 */
export function resolveRequest(deps: DecisionDeps, ownerId: string, reqId: string, input: ResolveRequestInput): Promise<ResolveOutcome> {
  return withRequestLock(reqId, () => resolveRequestLocked(deps, ownerId, reqId, input));
}

/**
 * The decision body without its own per-request lock: the caller already holds it (the AG-UI
 * resume batch lock). Never call this for a request whose lock the caller does not hold.
 */
export function resolveRequestLocked(deps: DecisionDeps, ownerId: string, reqId: string, input: ResolveRequestInput, deferDelivery = false): Promise<ResolveOutcome> {
  return (async (): Promise<ResolveOutcome> => {
    const found = await deps.store.get('requests', reqId);
    if (!found) throw new NotFoundError('requests', reqId);
    const request = parseStoredRequest(found);

    // Already decided: idempotent replay. Never decide twice and never deliver the wake twice.
    if (request.status !== 'pending') {
      // A "yes" for an approval that already timed out is refused again, not answered as if it had worked.
      const lateYes = request.status === 'expired' && request.decision?.reason === 'timeout' && input.action === 'approve';
      const replayed = (): ResolveOutcome => lateYes ? { status: 409, body: errorBody(REQUEST_EXPIRED, EXPIRED_MESSAGE) } : { status: 200, body: toPublicRequest(request) };
      if (deferDelivery || request.wakeDeliveredAt || !needsDelivery(request)) return replayed();
      try {
        await deliverResolution(deps, ownerId, request, storedResolution(request));
      } catch (error) {
        return { status: 502, body: deliveryError(error) };
      }
      await markDelivered(deps, reqId);
      return replayed();
    }

    // An approval is good for APPROVAL_WINDOW_MS after it was raised. A later "yes" does not approve: the card closes as timed out, the run
    // that waits is told to ask again, and the person gets a 409 they can read.
    if (input.action === 'approve' && approvalExpired(request, Date.now())) return expireApproval(deps, ownerId, request);

    const invalid = validateDecision(request, input);
    if (invalid) return { status: 400, body: errorBody('INVALID_RESOLUTION', invalid.message, invalid.fields) };
    const standing = delegationsFor(request, input);
    if (standing !== undefined && 'error' in standing) return { status: 400, body: errorBody('INVALID_RESOLUTION', standing.error) };

    // "Always allow" on "<Agent> wants to use <App> on your Mac": kept per app (GET/DELETE /v1/mac/apps), before the decision like the delegations.
    if (input.scope === 'app') {
      const macApp = request.payload.kind === 'approval' ? request.payload.macApp : undefined;
      if (macApp?.purpose !== 'use' || input.action !== 'approve') return { status: 400, body: errorBody('INVALID_RESOLUTION', 'Always allow is only for approving a request to use an app on your Mac') };
      await allowMacApp(deps.store, ownerId, macApp.app, macApp.name);
    }

    // The delegations come first: the replay path above never revisits them, so one that failed after the
    // decision was recorded would be lost for good. A retry after a failure here finds the request pending.
    for (const draft of standing?.drafts ?? []) await upsertDelegation(deps, ownerId, request.agentId, draft);

    const payload =
      input.action === 'answer' && request.payload.kind === 'question'
        ? withAnswers(request.payload, input.answers)
        : request.payload;
    const recorded = await recordDecision(deps, ownerId, request, input, payload, deferDelivery);
    if ('error' in recorded) return { status: decisionErrorStatus(recorded.error), body: recorded.error };
    return { status: 200, body: toPublicRequest(recorded.request) };
  })();
}

/**
 * Serializes a whole batch of request ids in sorted order (deadlock-free), so a concurrent
 * decision on any member either lands entirely before or entirely after the batch. Ids must be
 * distinct; the per-request locks stay with the product route, which wraps one request only.
 */
export async function withRequestLocks<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(ids)].sort();
  const enter = (index: number): Promise<T> => {
    const id = sorted[index];
    return id === undefined || index >= sorted.length ? fn() : withRequestLock(id, () => enter(index + 1));
  };
  return enter(0);
}

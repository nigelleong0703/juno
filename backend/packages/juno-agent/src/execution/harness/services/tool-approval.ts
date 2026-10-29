/**
 * Durable approval seam (PH7). An `ask` creates a real request the user decides and suspends on the
 * run's awakeable BEFORE any effect, so an approval is a decision about exactly what will run, and a
 * refusal means nothing ran. The verdict and the raised request are journaled once; the wait and the
 * decision read are separate top-level steps, so no `ctx.run` nests another.
 */
import { approvalExpired, APPROVAL_WINDOW_MS, parseStoredRequest, patchWhen, type Doc, type Store, type StoredRequest, type ToolResult } from '../../../contracts/index.js';
import type { ApprovalPayload, AuditDecision, AuditEntry, DecisionBinding, DelegationOffer, Item, Request } from '@agent-desktop/public-contracts';
import type { RunCancellation } from './cancel.js';
import { emitAgentStatus } from '../../agent-status.js';
import { awaitUser, interruptedNote } from './run-input.js';
import type { RunContext, RunInput, RunServices } from './run-types.js';
import { buildDelegationOffer, NO_USAGE, readDelegationUsage } from './decision/delegation.js';
import type { Derived } from './decision/derive.js';
import { stripHarnessArgs } from './decision/binding.js';
import { STRANGER_RULE_ID } from './decision/stranger.js';
import { auditInitiatorFor } from '../logic/run-origin.js';
import {
  deriveFor,
  evaluateToolPolicy,
  policyCallOf,
  draftNoticeOf,
  readToolPolicyConfig,
  type ToolAuthorization,
  type ToolCallContext,
  type ToolPolicyVerdict,
} from './tool-policy.js';
import { redactText, refusal } from './tool-projection.js';
import { emitItemAdded } from '../../conversation-activity.js';

/** An action whose reviewed arguments exceed this is refused outright: it could not be reviewed. */
const REVIEW_LIMIT = 2000;

/** The exact arguments the user reviews, or null when they are too large to review safely. */
export function reviewableArgs(args: unknown): string | null {
  // The agent's own `approval` words and the background options are not part of what runs; the card shows them as the brief.
  const shown = stripHarnessArgs(args);
  const text = redactText(typeof shown === 'string' ? shown : (JSON.stringify(shown) ?? ''));
  return text.length <= REVIEW_LIMIT ? text : null;
}

export interface ApprovalBinding {
  requestId: string;
  itemId: string;
  agentId: string;
  conversationId: string;
  runId: string;
  toolName: string;
  /** The exact reviewed arguments, already bounded and redacted. */
  review: string;
  /** The call's arguments, for the card's draft (subject and body) and nothing else. */
  args: unknown;
  /** The brief of this call: sentence, categories, platform and the facts the server verified. */
  derived: Derived;
  /** Whether "allow this kind" can be offered and the limits it would start with. */
  offer: DelegationOffer;
  reason: string;
  ruleId?: string;
  /** The tool's own card extras (purchase fields, screenshot preview); see `Tool.approvalDetails`. */
  extras?: Pick<ApprovalPayload, 'purchase' | 'preview' | 'ui'>;
  /** The card's line for a send to someone else in an owner-only run (batch 5b); see draftNoticeOf. */
  notice?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The subject and body a call sends out, when its arguments hold them: the card shows the text, not the model's description of it. */
function draftOf(args: unknown): ApprovalPayload['draft'] {
  if (!isRecord(args)) return undefined;
  const text = (keys: readonly string[]): string | undefined => keys.map((key) => args[key]).find((value): value is string => typeof value === 'string' && value.trim() !== '');
  const body = text(['body', 'text', 'message', 'content']);
  if (body === undefined) return undefined;
  const subject = text(['subject', 'title']);
  return { ...(subject === undefined ? {} : { subject }), body };
}

function recipientLine(derived: Derived): string | undefined {
  const names = derived.brief.facts.audience?.recipients.map((recipient) => recipient.address ?? recipient.name) ?? [];
  if (names.length === 0) return undefined;
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

/** The card's payload: plain words (never the raw tool name), the brief, and the exact reviewed arguments. */
function approvalPayloadFor(binding: ApprovalBinding): ApprovalPayload {
  const { brief } = binding.derived;
  const recipient = recipientLine(binding.derived);
  const draft = draftOf(binding.args);
  return {
    kind: 'approval',
    action: binding.derived.action,
    target: binding.review,
    // A stranger's ask says who asked and where, whatever story the agent tells (its own words stay in `brief.why`).
    why: binding.ruleId === STRANGER_RULE_ID ? binding.reason : (brief.why ?? binding.reason),
    ...(binding.derived.app === undefined ? {} : { app: binding.derived.app }),
    ...(brief.platform.kind === 'site' && brief.platform.host !== undefined ? { site: brief.platform.host } : {}),
    ...(recipient === undefined ? {} : { recipient }),
    ...(draft === undefined ? {} : { draft }),
    ...(binding.notice === undefined ? {} : { notice: binding.notice }),
    ...binding.extras,
    brief,
    delegationOffer: binding.offer,
    ...(binding.derived.macApp === undefined ? {} : { macApp: binding.derived.macApp }),
  };
}

/** The durable approval the user decides; its id is derived from the step so a replay reuses it. */
export function approvalRequestFor(binding: ApprovalBinding): StoredRequest {
  return {
    id: binding.requestId,
    kind: 'approval',
    status: 'pending',
    title: binding.derived.brief.sentence,
    summary: binding.reason,
    agentId: binding.agentId,
    conversationId: binding.conversationId,
    runId: binding.runId,
    ...(binding.ruleId === undefined ? {} : { triggeringRuleId: binding.ruleId }),
    payload: approvalPayloadFor(binding),
    createdAt: new Date().toISOString(),
    tool: binding.toolName,
  };
}

export function approvalRequestItem(itemId: string, conversationId: string, requestId: string): Item {
  return { id: itemId, conversationId, type: 'request', requestId, at: new Date().toISOString() };
}

/** The tool's card extras, best effort: an approval never fails because a screenshot could not be taken. */
async function approvalExtras(
  services: RunServices,
  input: RunInput,
  runId: string,
  call: { name: string; arguments: unknown },
  signal: AbortSignal,
): Promise<Pick<ApprovalPayload, 'purchase' | 'preview' | 'ui'>> {
  const tool = services.toolRegistry.get(call.name);
  if (tool?.approvalDetails === undefined) return {};
  const ownerId = input.wakeEvents[0]?.ownerId ?? '';
  try {
    return await tool.approvalDetails(call.arguments, { ownerId, agentId: input.agentId, conversationId: input.conversationId, runId, store: services.store, blobs: services.blobs, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return {};
  }
}

/** Everything an approval card or a delegated decision is built from, read once inside the journaled policy step. */
interface CallBrief {
  derived: Derived;
  offer: DelegationOffer;
  config: Awaited<ReturnType<typeof readToolPolicyConfig>>;
}

function bindingFor(
  input: RunInput,
  runId: string,
  step: Doc<'steps'>,
  call: { name: string; arguments: unknown },
  brief: CallBrief,
  review: string,
  reason: string,
  ruleId: string | undefined,
  extras: ApprovalBinding['extras'],
): ApprovalBinding {
  const notice = draftNoticeOf(brief.config, call.name, call.arguments);
  return {
    requestId: 'req_' + step.id,
    itemId: 'itm_' + step.id,
    agentId: input.agentId,
    conversationId: input.conversationId,
    runId,
    toolName: call.name,
    review,
    args: call.arguments,
    derived: brief.derived,
    offer: brief.offer,
    reason,
    ...(ruleId === undefined ? {} : { ruleId }),
    ...(extras === undefined ? {} : { extras }),
    ...(notice === undefined ? {} : { notice }),
  };
}

type Reservation =
  | { kind: 'recorded'; verdict: ToolPolicyVerdict; requestId: string }
  /** The limits no longer let this through (another run spent them first): the verdict to follow instead. */
  | { kind: 'refused'; verdict: ToolPolicyVerdict };

/**
 * Check a delegation's limits and record the decision as ONE step (BACKEND 2.2c). The month's spend and the per-day counts are summed
 * from the agent's approved requests, so two parallel runs (on two workers) that both read them before either wrote its own would both
 * pass. Here the agent's row is locked first; the usage is read and the verdict re-evaluated under that lock; the decided request is
 * written before the lock is released, so the next run's read counts it. Nothing slow runs under the lock: the policy config (tool
 * discovery) was read before, and only database statements run inside.
 */
async function reserveDelegation(
  services: RunServices,
  input: RunInput,
  runId: string,
  step: Doc<'steps'>,
  call: { name: string; arguments: unknown },
  config: Awaited<ReturnType<typeof readToolPolicyConfig>>,
): Promise<Reservation> {
  const wake = input.wakeEvents[0];
  return services.store.tx(async (tx): Promise<Reservation> => {
    if (tx.getForUpdate === undefined) throw new Error('delegated decisions need a store with row locks (getForUpdate)');
    await tx.getForUpdate('agents', input.agentId);
    // A replay of this step finds its own decided request: it counts once and is not checked against itself.
    const replayed = (await tx.get('requests', 'req_' + step.id))?.status === 'approved';
    const fresh = replayed ? evaluateToolPolicy({ ...config, usage: NO_USAGE }, call.name, wake, call.arguments)
      : evaluateToolPolicy({ ...config, usage: await readDelegationUsage(tx, input.agentId, new Date()) }, call.name, wake, call.arguments);
    if (fresh.kind !== 'allow' || fresh.delegationId === undefined) return { kind: 'refused', verdict: fresh };
    const derived = deriveFor(config, call.name, call.arguments, wake);
    const brief: CallBrief = { derived, config, offer: buildDelegationOffer(derived, wake, config.ownerTimeZone, config.rules) };
    const review = reviewableArgs(call.arguments) ?? '(too long to show)';
    const scoped: RunServices = { ...services, store: tx };
    const requestId = await recordDelegatedDecision(scoped, input, runId, step, call, fresh.delegationId, review, brief);
    await auditToolDecision(tx, input, runId, {
      id: 'aud-policy-' + step.id, actor: 'agent', tool: call.name, decision: 'auto_allowed', reason: 'allowed by your rule', ruleId: fresh.delegationId, requestId, brief: auditBrief(derived),
    });
    return { kind: 'recorded', verdict: fresh, requestId };
  });
}

/** Create the durable approval (request, item, events) inside the caller's journaled step. */
async function raiseApproval(
  services: RunServices,
  input: RunInput,
  runId: string,
  step: Doc<'steps'>,
  call: { name: string; arguments: unknown },
  verdict: Extract<ToolPolicyVerdict, { kind: 'ask' }>,
  review: string,
  brief: CallBrief,
  signal: AbortSignal,
): Promise<string> {
  const store = services.store;
  const binding = bindingFor(input, runId, step, call, brief, review, verdict.reason, verdict.ruleId, await approvalExtras(services, input, runId, call, signal));
  const request = approvalRequestFor(binding);
  const item = approvalRequestItem(binding.itemId, input.conversationId, binding.requestId);
  await store.put('requests', request, { conversationId: input.conversationId, runId });
  await store.put('items', item, { conversationId: input.conversationId });
  await store.emit({ type: 'request.created', request });
  await emitAgentStatus(store, request.agentId);
  await emitItemAdded(store, input.conversationId, item);
  return binding.requestId;
}

/**
 * A call a delegation allowed: no card and no wait, but the decision is still a decided request (mode auto, outcome "allowed by
 * your rule") so the history has one source and the monthly spend is summed from it, and the delegation's use is counted.
 * The ids come from the step, so a replay rewrites the same rows and counts once.
 */
async function recordDelegatedDecision(
  services: RunServices,
  input: RunInput,
  runId: string,
  step: Doc<'steps'>,
  call: { name: string; arguments: unknown },
  delegationId: string,
  review: string,
  brief: CallBrief,
): Promise<string> {
  const store = services.store;
  const binding = bindingFor(input, runId, step, call, brief, review, 'Allowed by a rule of yours', delegationId, undefined);
  const now = new Date().toISOString();
  const request: StoredRequest = {
    ...approvalRequestFor(binding),
    status: 'approved',
    resolvedAt: now,
    decision: { by: 'auto', at: now, mode: 'auto', scope: 'always' },
  };
  const existing = await store.get('requests', request.id);
  await store.put('requests', request, { conversationId: input.conversationId, runId });
  await store.emit({ type: 'request.resolved', request });
  const rule = await store.get('rules', delegationId);
  if (existing === null && rule !== null) {
    await store.patch('rules', delegationId, { lastUsedAt: now, useCount: (rule.useCount ?? 0) + 1 });
  }
  return request.id;
}

function approvalContext(ctx: ToolCallContext): RunContext | undefined {
  if (ctx.awakeable === undefined || ctx.drainInbox === undefined) return undefined;
  return { rand: ctx.rand, run: ctx.run, awakeable: ctx.awakeable, drainInbox: ctx.drainInbox };
}

/**
 * Whether the policy would ask the owner about this call right now, and why. Asks nothing and writes nothing: computer.batch
 * uses it to stop BEFORE a step that needs an approval card, so the one-call flow handles that step and a batch never
 * approves (or waits for) anything itself. Journaled under `key`, so a replay answers the same.
 */
export async function approvalReason(
  ctx: ToolCallContext,
  services: RunServices,
  input: RunInput,
  key: string,
  call: { name: string; arguments: unknown },
  cancellation: RunCancellation,
): Promise<string | null> {
  return ctx.run(`policy-peek:${key}`, async (): Promise<string | null> => {
    const wake = input.wakeEvents[0];
    const config = await readToolPolicyConfig(services.store, services.toolRegistry, input.agentId, wake?.ownerId ?? '', cancellation.signal, policyCallOf(input, call.name, call.arguments));
    const verdict = evaluateToolPolicy(config, call.name, wake, call.arguments);
    return verdict.kind === 'ask' ? verdict.reason : null;
  });
}

/** Keeps this call's suspend keys clear of the turn-level `stepIndex` keys in the same run. */
const SUSPEND_NAMESPACE = 1_000_000;

/** Audit `action` (and indexed `kind`) of every tool authorization row; `/v1/audit?action=` filters on it. */
export const TOOL_POLICY_AUDIT_ACTION = 'tool.policy';

/**
 * H-57: one queryable audit row per authorization decision (ask, deny, hand-off, delegated allow, and the user's
 * later approve or deny). Written inside the journaled policy step with an id derived from the step,
 * so a replay rewrites the same row instead of adding one.
 */
interface ToolAuditRow {
  id: string;
  actor: 'agent' | 'user';
  tool: string;
  decision: AuditDecision;
  reason: string;
  ruleId?: string;
  requestId?: string;
  brief?: AuditEntry['brief'];
}

/** What an audit row says a decision was about: the kinds of decision, the agent's sentence and the hash of the verified facts. */
function auditBrief(derived: Derived): AuditEntry['brief'] {
  return { categories: derived.brief.categories, sentence: derived.brief.sentence, factsHash: derived.brief.binding.factsHash };
}

async function auditToolDecision(store: Store, input: RunInput, runId: string, row: ToolAuditRow): Promise<void> {
  const initiated = auditInitiatorFor(await store.get('runs', runId));
  await store.put('audit', {
    ...initiated,
    id: row.id,
    at: new Date().toISOString(),
    actor: row.actor,
    agentId: input.agentId,
    action: TOOL_POLICY_AUDIT_ACTION,
    target: row.tool,
    decision: row.decision,
    reason: row.reason,
    runId,
    ...(row.ruleId === undefined ? {} : { ruleId: row.ruleId }),
    ...(row.requestId === undefined ? {} : { requestId: row.requestId }),
    ...(row.brief === undefined ? {} : { brief: row.brief }),
  }, { agentId: input.agentId, conversationId: input.conversationId, runId, kind: TOOL_POLICY_AUDIT_ACTION });
}

const VERDICT_DECISION: Record<ToolPolicyVerdict['kind'], AuditDecision> = {
  allow: 'auto_allowed',
  ask: 'asked',
  deny: 'denied',
  handoff: 'handed_off',
};

/** How long a late approval of an interrupted request stays good for the agent's repeated call. */
const LATE_APPROVAL_WINDOW_MS = 30 * 60_000;

/**
 * The approved request whose wait was interrupted by a message (BACKEND 8.7.1): same agent, conversation and tool, decided within
 * the window, and the same reviewed arguments and server-verified facts as this call (the one comparison the "details changed"
 * check below also uses). Taking it clears `interrupted`, so exactly one identical call uses it.
 */
async function takeLateApproval(store: Store, input: RunInput, call: { name: string }, review: string, binding: DecisionBinding): Promise<StoredRequest | undefined> {
  const page = await store.list('requests', { where: { conversationId: input.conversationId, status: 'approved' }, limit: 50 });
  const found = page.items.map(parseStoredRequest).find((request) =>
    request.interrupted === true && request.agentId === input.agentId && request.tool === call.name
    && Date.parse(request.resolvedAt ?? '') > Date.now() - LATE_APPROVAL_WINDOW_MS
    && request.payload.kind === 'approval' && request.payload.target === review
    // The same verified facts and the same arguments (the digest covers what `target` cuts or redacts), decided in time.
    && request.payload.brief?.binding.factsHash === binding.factsHash && request.payload.brief.binding.argsHash === binding.argsHash
    && !approvalExpired(request, Date.parse(request.resolvedAt ?? '')));
  if (found === undefined) return undefined;
  // The flag is the one-use token: clearing it under the row lock means two calls (on two workers) cannot both take it.
  const taken: Partial<StoredRequest> = { interrupted: false };
  const claimed = await patchWhen(store, 'requests', found.id, (current) => parseStoredRequest(current).interrupted === true, taken);
  return claimed === undefined ? undefined : found;
}

interface PolicyDecision {
  verdict: ToolPolicyVerdict;
  /** A late approval of an interrupted request covered this call and was used up. */
  preApproved?: boolean;
  requestId?: string;
  /** An `ask` whose arguments cannot be shown in full: it is refused instead of half-reviewed. */
  tooLarge?: boolean;
}

const NOTE_MAX = 1000;

/** What the model is told when the person's "yes" came after the approval window (APPROVAL_WINDOW_MS) closed: nothing ran, ask again. */
const EXPIRED_TEXT = `The approval expired before the user decided (a card is good for ${APPROVAL_WINDOW_MS / 3_600_000} hours), so it was not performed. If it is still wanted, call the tool again: that asks the user again.`;

/** The result the model gets for a call the user did not approve: the owner's note goes back to it, so it can change course. */
function notApproved(decided: Pick<Request, 'status' | 'decision'> | null): ToolResult {
  if (decided?.status === 'expired') return refusal(EXPIRED_TEXT);
  const note = decided?.decision?.note?.trim().slice(0, NOTE_MAX) ?? '';
  if (decided?.decision?.reason === 'revise') {
    return refusal('The user sent this back to be changed, so it was not performed' + (note === '' ? '.' : ': ' + note) + (note === ''
      ? ' Change it as asked and ask again.'
      : ' That is their answer: call the tool again now with it changed, which asks them again. Do not ask them in the chat first.'));
  }
  return refusal('The action was not approved, so it was not performed.' + (note === '' ? '' : ' The user said: ' + note));
}

/**
 * Decide and, for `ask`, wait for the durable decision before any effect. A rule that changed while
 * the approval was pending is caught by the fresh check the caller runs just before executing.
 */
export async function authorizeToolCall(
  ctx: ToolCallContext,
  services: RunServices,
  input: RunInput,
  runId: string,
  step: Doc<'steps'>,
  call: { name: string; arguments: unknown },
  cancellation: RunCancellation,
): Promise<ToolAuthorization> {
  let decision: PolicyDecision;
  try {
    decision = await ctx.run(`policy:${step.id}`, async (): Promise<PolicyDecision> => {
      const ownerId = input.wakeEvents[0]?.ownerId ?? '';
      const config = await readToolPolicyConfig(services.store, services.toolRegistry, input.agentId, ownerId, cancellation.signal, policyCallOf(input, call.name, call.arguments));
      let verdict = evaluateToolPolicy(config, call.name, input.wakeEvents[0], call.arguments);
      const auditFor = (decided: ToolPolicyVerdict): ToolAuditRow => ({ id: 'aud-policy-' + step.id, actor: 'agent', tool: call.name, decision: VERDICT_DECISION[decided.kind],
        reason: decided.kind === 'allow' ? 'allowed by policy' : decided.reason, ...(decided.kind !== 'allow' && decided.ruleId !== undefined ? { ruleId: decided.ruleId } : {}) });
      let audit = auditFor(verdict);
      if (verdict.kind === 'allow' && verdict.delegationId !== undefined) {
        // A delegation's limits are checked against every decision already recorded, and this one is recorded in the same transaction.
        const reserved = await reserveDelegation(services, input, runId, step, call, config);
        if (reserved.kind === 'recorded') return { verdict: reserved.verdict, requestId: reserved.requestId };
        verdict = reserved.verdict;
        audit = auditFor(verdict);
      }
      const delegationId = verdict.kind === 'allow' ? verdict.delegationId : undefined;
      if (verdict.kind !== 'ask' && delegationId === undefined) {
        // A default allow is already the step itself; the audit keeps only decisions (asked, denied, handed off, delegated).
        if (verdict.kind !== 'allow') await auditToolDecision(services.store, input, runId, audit);
        return { verdict };
      }
      const derived = deriveFor(config, call.name, call.arguments, input.wakeEvents[0]);
      const brief: CallBrief = { derived, config, offer: buildDelegationOffer(derived, input.wakeEvents[0], config.ownerTimeZone, config.rules) };
      // The review bound applies ONLY to an approval: a normal authorized call keeps its full,
      // schema-validated arguments (a large patch or file edit is not rejected here).
      const review = reviewableArgs(call.arguments);
      if (verdict.kind !== 'ask') return { verdict };
      if (review === null) {
        await auditToolDecision(services.store, input, runId, { ...audit, decision: 'denied', reason: 'arguments too large to review' });
        return { verdict, tooLarge: true };
      }
      const late = await takeLateApproval(services.store, input, call, review, derived.brief.binding);
      if (late !== undefined) {
        await auditToolDecision(services.store, input, runId, { ...audit, decision: 'approved', reason: 'approved by the user after their message', requestId: late.id, brief: auditBrief(derived) });
        return { verdict: { kind: 'allow' }, preApproved: true, requestId: late.id };
      }
      const requestId = await raiseApproval(services, input, runId, step, call, verdict, review, brief, cancellation.signal);
      await auditToolDecision(services.store, input, runId, { ...audit, requestId, brief: auditBrief(derived) });
      return { verdict, requestId };
    });
  } catch (error) {
    // A stop during tool discovery is a cancellation, not a policy failure: nothing was reviewed.
    if (cancellation.signal.aborted) return { kind: 'cancelled' };
    throw error;
  }
  if (cancellation.signal.aborted) return { kind: 'cancelled' };
  if (decision.verdict.kind === 'deny' || decision.verdict.kind === 'handoff') {
    return { kind: 'refuse', result: refusal(decision.verdict.reason) };
  }
  // Allowed by a delegation: already recorded as a decided request, so the fresh check before the effect counts it as approved.
  if (decision.verdict.kind === 'allow') return { kind: 'allow', approved: decision.preApproved === true || decision.verdict.delegationId !== undefined };
  if (decision.tooLarge === true) {
    return { kind: 'refuse', result: refusal('Tool ' + call.name + ' arguments are too large to review, so it was not run.') };
  }
  const requestId = decision.requestId;
  if (requestId === undefined) return { kind: 'refuse', result: refusal('Approval could not be requested') };
  const waiting = approvalContext(ctx);
  if (waiting === undefined) throw new Error('Approval is required for ' + call.name + ' but this caller cannot wait for one');
  // Approval is runtime control, not conversation: resume without journaling a user turn so the
  // persisted assistant tool call and its finalized result stay adjacent for the provider.
  const resumed = await awaitUser(waiting, services, input, runId, step.index + SUSPEND_NAMESPACE, { awakeableId: requestId }, cancellation, { appendAnswer: false });
  if (resumed === 'cancelled') return { kind: 'cancelled' };
  if (resumed === 'interrupted_by_message') {
    // Not done: the card stays open. The note is part of this tool result; the user's message is drained right after the tool batch.
    const title = await ctx.run(`policy:${step.id}:interrupted`, async () => (await services.store.get('requests', requestId))?.title ?? call.name);
    return { kind: 'refuse', result: refusal('Not done yet: still waiting for the user\'s decision. ' + interruptedNote(title)) };
  }
  // A decision that landed after a stop must not take effect.
  if ((await cancellation.peek()) === true) return { kind: 'cancelled' };
  const outcome = await ctx.run(`policy:${step.id}:decision`, async () => {
    const decided = await services.store.get('requests', requestId);
    const approved = decided?.status === 'approved';
    // What was approved is what is about to run: if the arguments or the verified facts (amounts, recipients, the page's host) differ
    // from the ones on the card, the approval does not cover this and a new one is needed. The card is one approval of one call.
    const approvedBinding = decided?.payload.kind === 'approval' ? decided.payload.brief?.binding : undefined;
    let changed = false;
    if (approved && approvedBinding !== undefined) {
      const config = await readToolPolicyConfig(services.store, services.toolRegistry, input.agentId, input.wakeEvents[0]?.ownerId ?? '', cancellation.signal, policyCallOf(input, call.name, call.arguments));
      const now = deriveFor(config, call.name, call.arguments, input.wakeEvents[0]).brief.binding;
      changed = now.factsHash !== approvedBinding.factsHash || now.argsHash !== approvedBinding.argsHash;
    }
    // A "yes" that came after the window closed does not run it (the route refuses these too; this covers any other way a decision lands).
    const expired = approved && decided !== null && approvalExpired(decided, Date.parse(decided.decision?.at ?? decided.resolvedAt ?? '') || Date.now());
    const revised = decided?.decision?.reason === 'revise';
    await auditToolDecision(services.store, input, runId, {
      id: 'aud-policy-' + step.id + '-decision', actor: 'user', tool: call.name, requestId,
      decision: approved && !changed && !expired ? 'approved' : revised ? 'revised' : 'denied',
      reason: expired ? 'the approval expired before it was decided' : changed ? 'the details changed after approval' : approved ? 'approved by the user' : revised ? 'sent back to change' : 'not approved (' + (decided?.status ?? 'missing') + ')',
    });
    return { decided, changed, expired };
  });
  if (outcome.changed) {
    return { kind: 'refuse', result: refusal('The details changed after the user looked at them, so it was not performed. Ask again for the changed action.') };
  }
  if (outcome.expired) return { kind: 'refuse', result: refusal(EXPIRED_TEXT) };
  if (outcome.decided?.status === 'approved') return { kind: 'allow', approved: true };
  return { kind: 'refuse', result: notApproved(outcome.decided) };
}

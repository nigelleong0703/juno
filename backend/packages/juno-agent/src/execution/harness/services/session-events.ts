import { COMPLETION_WAKE_KINDS, LIMITS, type Store, type WakeEvent } from '../../../contracts/index.js';
import { resolveBusyMode, selectNextBatch, takeSteerEvents } from '../logic/busy.js';
import { checkHop, checkPeerCost, checkRate, type GuardVerdict } from '../logic/guards.js';
import { MAX_TYPING_HOLD_MS, selfWakeAdmission, TYPING_TTL_MS } from '../logic/idle.js';
import { defaultState, MAX_SEEN_WAKE_IDS, type Services, type SessionIo, type SessionState } from './session-state.js';
import { armFlush, beginRun, isPrivateReplyBurst } from './session-reply.js';
import { readChainCost } from './chain-cost.js';
import { CHILD_SESSION_MARKER, childRunIdOfSession, docOwner, inOwnerScope } from '../../execution-owner.js';

async function checkGuards(event: WakeEvent, state: SessionState, store: Store, now: number): Promise<GuardVerdict> {
  const hopVerdict = checkHop(event);
  if (hopVerdict.kind !== 'ok') return hopVerdict;
  const costVerdict = checkPeerCost(event, await readChainCost(store, event));
  if (costVerdict.kind !== 'ok') return costVerdict;
  return checkRate(event, { now, recentStarts: state.recentStarts });
}

/** A screen-control notice that must not start a run by itself (`resume` marks one that interrupted a run and does). */
function isContextOnly(event: WakeEvent): boolean {
  return event.kind === 'hand_back' && event.payload['source'] === 'screen_control' && event.payload['resume'] !== true;
}

/** A child_message steer (kind child_task, mode steer) addressed to the child session named by its own childRunId. */
function isSteerIntoChild(event: WakeEvent): boolean {
  if (event.kind !== 'child_task' || event.mode !== 'steer') return false;
  const runId = childRunIdOfSession(event.sessionKey, event.agentId, event.conversationId);
  return runId !== undefined && event.payload['childRunId'] === runId;
}

/**
 * Session's verdict on one wake. `runId` is the run the wake is in, when it is known at this point: the run it
 * started, the busy run it steered into, or the run a private quiet window will start. Absent for a refusal, a
 * replayed wake, a delayed (guard) retry, a child steer, or a wake that waits behind other work.
 */
export interface ReceiveDecision {
  accepted: boolean;
  reason?: string;
  runId?: string;
}

/** Admit one wake (dedupe, guards, busy mode, batch start). Must run inside the wake owner's scope. */
export async function receiveEvent(
  io: SessionIo,
  services: Services,
  event: WakeEvent,
): Promise<ReceiveDecision> {
  const state = (await io.readState()) ?? defaultState();

  if (state.seenWakeIds.includes(event.id)) return { accepted: true };

  // Structural self-wake admission (not the model decision): refuse a wake an agent sent to itself.
  const admission = selfWakeAdmission(event);
  if (!admission.admit) {
    state.seenWakeIds = [event.id, ...state.seenWakeIds].slice(0, MAX_SEEN_WAKE_IDS);
    io.writeState(state);
    return { accepted: false, reason: admission.reason };
  }

  // A typing ping records presence and never queues or wakes. A pending private window is re-armed:
  // behind the user's next pause on `true`, a normal quiet window after they stop on `false`.
  if (event.kind === 'typing') {
    state.seenWakeIds = [event.id, ...state.seenWakeIds].slice(0, MAX_SEEN_WAKE_IDS);
    const now = await io.now();
    state.typingUntil = event.payload['active'] === true ? now + TYPING_TTL_MS : null;
    if (!state.activeRunId && state.pendingFlushToken) {
      armFlush(io, state, 'fl-' + event.id, now);
      return { accepted: true };
    }
    io.writeState(state);
    return { accepted: true };
  }

  // A completion from work the user stopped is dropped: Stop must not make the agent speak again later.
  const stale = (await fromStoppedRun(services.store, event)) ? 'origin_stopped' : (await consumedEventExpiry(services.store, event)) ? 'already_delivered' : (await refusedWhilePaused(services.store, event)) ? 'agent_paused' : undefined;
  if (stale !== undefined) {
    state.seenWakeIds = [event.id, ...state.seenWakeIds].slice(0, MAX_SEEN_WAKE_IDS);
    io.writeState(state);
    return { accepted: false, reason: stale };
  }

  const now = await io.now();
  // The user's own message means they stopped typing, even if the client's `false` ping is lost or late.
  if (event.kind === 'user_message' && event.origin.type === 'user') state.typingUntil = null;
  const verdict = await checkGuards(event, state, services.store, now);
  if (verdict.kind === 'drop') {
    state.seenWakeIds = [event.id, ...state.seenWakeIds].slice(0, MAX_SEEN_WAKE_IDS);
    io.writeState(state);
    return { accepted: false, reason: verdict.reason };
  }

  if (verdict.kind === 'defer') {
    // Reschedule the same event at the guard's absolute time, computed against the durable clock so
    // the delay is finite and deterministic. The dedupe key is NOT recorded: the delayed retry is the
    // same wake and must still be processed once the rate window opens.
    const delay = Math.max(1, verdict.untilMs - now);
    io.deliver(event, delay);
    return { accepted: true };
  }

  state.seenWakeIds = [event.id, ...state.seenWakeIds].slice(0, MAX_SEEN_WAKE_IDS);
  const mode = resolveBusyMode(event);
  state.inbox.push({ event, mode, seq: state.inbox.length, urgent: false, ...(isContextOnly(event) ? { contextOnly: true } : {}) });

  if (state.activeRunId) {
    if (mode === 'interrupt') {
      io.cancelRun(state.activeRunId);
    } else if (mode === 'reject') {
      state.inbox.pop();
      return { accepted: false, reason: 'busy_reject' };
    }
    io.writeState(state);
    // A steer is handed to the busy run. An interrupt cancels it and a followup waits for the next run, so neither is named here.
    return mode === 'steer' ? { accepted: true, runId: state.activeRunId } : { accepted: true };
  }

  // A child's run is started by startChildRun, which never records activeRunId here. A child_message steer
  // into that running child only queues: the child drains it at its steer points. Starting a run from it
  // would create a stray run with no parent link. Every other wake starts its run as it did before.
  if (isSteerIntoChild(event)) {
    io.writeState(state);
    return { accepted: true };
  }

  // Private messages coalesce behind a durable idle window so a quick burst yields one reply.
  // Each new message re-arms the window; a typing ping can move it (see above), and the flush waits out a typing user.
  if (await isPrivateReplyBurst(services.store, event)) {
    armFlush(io, state, 'fl-' + event.id, now);
    return { accepted: true, runId: state.pendingRunId ?? undefined };
  }
  // A wake that is not itself a private message still waits out an in-flight quiet window so a
  // routine/agent message cannot cut the user's burst short. The pending flush will start it.
  if (state.pendingFlushToken) {
    io.writeState(state);
    return { accepted: true, runId: state.pendingRunId ?? undefined };
  }

  const batch = selectNextBatch(state.inbox, LIMITS.session.collectMaxEvents);
  if (batch.batch.length === 0) {
    io.writeState(state);
    return { accepted: true };
  }

  beginRun(io, state, batch, now);
  io.writeState(state);
  return { accepted: true, runId: state.activeRunId };
}

/** Durable idle flush: start the coalesced batch unless a newer message superseded this timer. */
export async function flushInboxEvent(io: SessionIo, token: string): Promise<void> {
  const state = (await io.readState()) ?? defaultState();
  if (state.pendingFlushToken !== token) return;
  state.pendingFlushToken = null;
  if (state.activeRunId) {
    state.pendingSince = null;
    io.writeState(state);
    return;
  }
  const now = await io.now();
  // Still typing: wait for the pause, unless the burst has already been held as long as we allow.
  const typingFor = (state.typingUntil ?? 0) - now;
  if (typingFor > 0 && now - (state.pendingSince ?? now) < MAX_TYPING_HOLD_MS) {
    armFlush(io, state, 'fl-hold-' + String(now), now, typingFor);
    return;
  }
  state.pendingSince = null;
  // The flush answers the whole quiet-window burst: treat the queued private user messages as one
  // collect batch (arrival order) so a burst gets a single reply. Steering while busy is untouched.
  state.inbox = state.inbox.map(q =>
    q.mode === 'steer' && q.event.priority === 'user' ? { ...q, mode: 'collect' as const } : q,
  );
  const batch = selectNextBatch(state.inbox, LIMITS.session.collectMaxEvents);
  if (batch.batch.length === 0) {
    state.status = 'idle';
    state.pendingRunId = null;
    io.writeState(state);
    return;
  }
  beginRun(io, state, batch, now);
  io.writeState(state);
}

/** Steer: hand the run the events that arrived while it was busy, leaving the rest queued. */
export async function drainInboxEvents(io: SessionIo): Promise<WakeEvent[]> {
  const state = (await io.readState()) ?? defaultState();
  const { steer, rest } = takeSteerEvents(state.inbox);
  state.inbox = rest;
  io.writeState(state);
  return steer.map(q => q.event);
}

/** How long a chat stays quiet before it is compacted in the background. */
const IDLE_COMPACT_DELAY_MS = 60 * 60_000;

/** The session just went idle: arm the background compaction; the newest token wins, so an older timer is skipped. */
function markIdle(io: SessionIo, state: SessionState): void {
  state.status = 'idle';
  state.idleCompactToken = 'ic-' + io.newRunId();
  io.scheduleIdleCompact(state.idleCompactToken, IDLE_COMPACT_DELAY_MS);
  io.writeState(state);
}

/** Release the active run and start the next queued batch, if any. */
export async function runFinishedEvent(io: SessionIo, runId: string): Promise<void> {
  const state = (await io.readState()) ?? defaultState();
  if (state.activeRunId !== runId) return;
  state.activeRunId = undefined;
  const now = await io.now();

  if (state.inbox.length === 0) {
    markIdle(io, state);
    return;
  }

  const batch = selectNextBatch(state.inbox, LIMITS.session.collectMaxEvents);
  if (batch.batch.length === 0) {
    markIdle(io, state);
    return;
  }

  beginRun(io, state, batch, now);
  io.writeState(state);
}

/**
 * The one-hour idle timer fired: compact in the background unless a newer run or message made it stale.
 * `step` journals the compaction (Restate `ctx.run`). The agent's owner scopes it; a failure is dropped
 * rather than retried, since the next size trigger compacts anyway.
 */
export async function idleCompactEvent(
  io: Pick<SessionIo, 'key' | 'readState'>,
  services: Services,
  token: string,
  step: (compact: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const state = await io.readState();
  if (state?.idleCompactToken !== token || state.status !== 'idle' || state.inbox.length > 0 || state.activeRunId) return;
  // The canonical key is `${agentId}:${conversationId}`; a child session adds a marker and is never compacted here.
  const split = io.key.indexOf(':');
  if (split < 0 || io.key.includes(CHILD_SESSION_MARKER)) return;
  const agentId = io.key.slice(0, split);
  const conversationId = io.key.slice(split + 1);
  const ownerId = docOwner(await services.store.get('agents', agentId));
  if (ownerId === undefined) return;
  // The owner scope is entered inside the journaled step: Restate runs the step on its own async chain, outside the caller's scope.
  await step(() => inOwnerScope(ownerId, async () => {
    await services.brain.compactIdle?.({ agentId, conversationId, sessionKey: io.key }).catch(() => undefined);
  }));
}

/**
 * A paused agent starts no run on its own: routine/webhook/connector (automation), timer (wake_at) and
 * peer-agent wakes are dropped here, the single admission point, and are not replayed on resume. The
 * user's own messages and completions of work already started (task_done, hand_back) still run.
 */
async function refusedWhilePaused(store: Store, event: WakeEvent): Promise<boolean> {
  if (event.origin.type !== 'automation' && event.origin.type !== 'agent' && event.kind !== 'timer') return false;
  return (await store.get('agents', event.agentId))?.pausedAt !== undefined;
}

/** True for a completion wake (task_done / hand_back / timer) whose originating run was stopped. */
async function fromStoppedRun(store: Store, event: WakeEvent): Promise<boolean> {
  if (!COMPLETION_WAKE_KINDS.includes(event.kind)) return false;
  const origin = event.payload['originRunId'];
  if (typeof origin !== 'string' || origin.length === 0) return false;
  return (await store.get('runs', origin))?.status === 'stopped';
}

/** H-85: a wait_for notify expiry whose subscription an event already consumed (deleted) is dropped. */
async function consumedEventExpiry(store: Store, event: WakeEvent): Promise<boolean> {
  if (event.kind !== 'task_done' || event.payload['taskKind'] !== 'event' || event.payload['status'] !== 'timeout') return false;
  const id = event.payload['taskId'];
  return typeof id === 'string' && (await store.get('subscriptions', id)) === null;
}

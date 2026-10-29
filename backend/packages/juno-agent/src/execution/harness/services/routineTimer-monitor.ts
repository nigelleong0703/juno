/**
 * A monitor's check inside the RoutineTimer (BACKEND 3.6.3). `fireMonitor` runs one check, wakes the agent only when something
 * new matches, keeps the failure rules, and re-arms the next check. The seen set is committed only after the wake was sent,
 * so a crash in between repeats the wake (the wake id is the same, so the session takes it once) instead of losing the item.
 */
import type { ObjectContext } from '@agent-desktop/durable';
import type { MonitorView, Routine } from '@agent-desktop/public-contracts';
import type { Store } from '../../../contracts/index.js';
import { inOwnerScope } from '../../execution-owner.js';
import { routineTimerDef, sessionDef, type RoutineTimerDef, type SessionDef } from './definitions.js';
import { resolveDeliveryConversation } from './routineTimer-delivery.js';
import type { Services } from './routineTimer-state.js';
import { applyFailure, mergeSeen, MONITOR_LIFETIME_DAYS } from '../../../modules/tasks/routines/monitor.js';
import { loadMonitorState, matchWake, monitorWakeAllowed, noticeWake, recordMonitorWake, runCheck } from '../../../modules/tasks/routines/monitor-check.js';

const DAY_MS = 86_400_000;

/** A view built from loose fields; anything unset or undefined is left out. */
function viewOf(fields: Record<string, unknown>): MonitorView {
  const { expiresAt, lastCheckedAt, lastMatchAt, failures, lastError, needsReconnect, stoppedReason } = fields;
  return {
    expiresAt: typeof expiresAt === 'string' ? expiresAt : new Date(0).toISOString(),
    ...(typeof lastCheckedAt === 'string' ? { lastCheckedAt } : {}),
    ...(typeof lastMatchAt === 'string' ? { lastMatchAt } : {}),
    failures: typeof failures === 'number' ? failures : 0,
    ...(typeof lastError === 'string' ? { lastError } : {}),
    ...(needsReconnect === true ? { needsReconnect } : {}),
    ...(stoppedReason === 'expired' || stoppedReason === 'failures' || stoppedReason === 'reconnect' ? { stoppedReason } : {}),
  };
}

/** Store the routine's monitor view; `off` also switches the routine off (the monitor stopped itself). */
async function writeView(store: Store, routine: Routine, view: MonitorView, options: { off: boolean; emit: boolean }): Promise<void> {
  const patched = await store.patch('routines', routine.id, options.off ? { monitor: view, enabled: false, status: 'paused' } : { monitor: view });
  if (options.emit) await store.emit({ type: 'routine.updated', routine: patched });
}

/**
 * Before a monitor is armed: one the owner switched back on after it stopped itself starts fresh (no failures, thirty more
 * days). Returns the failures in a row, which set how long to wait for the next check.
 */
export async function armMonitor(store: Store, routine: Routine, nowIso: string): Promise<number> {
  const view = routine.monitor;
  if (view?.stoppedReason === undefined) return (await store.get('monitorState', routine.id))?.failures ?? 0;
  const state = await loadMonitorState(store, routine);
  await store.put('monitorState', { id: state.id, agentId: state.agentId, seen: state.seen, failures: 0, updatedAt: nowIso });
  const expiresAt = new Date(Date.parse(nowIso) + MONITOR_LIFETIME_DAYS * DAY_MS).toISOString();
  await writeView(store, routine, viewOf({ ...view, expiresAt, failures: 0, lastError: undefined, needsReconnect: undefined, stoppedReason: undefined }), { off: false, emit: true });
  return 0;
}

/** One check. Returns what happened, for "check now". */
export async function fireMonitor(ctx: ObjectContext, services: Services, routine: Routine, ownerId: string): Promise<{ outcome: string }> {
  const trigger = routine.trigger;
  const view = routine.monitor;
  const { tools, blobs, store } = services;
  if (trigger.kind !== 'check' || view === undefined || tools === undefined || blobs === undefined) return { outcome: 'unavailable' };
  const nowMs = await ctx.date.now();
  const now = new Date(nowMs);
  const at = now.toISOString();
  const conversationId = await ctx.run('monitor-conversation', () => resolveDeliveryConversation(routine, store));
  if (conversationId === undefined) return { outcome: 'no_chat' };
  const tell = (key: string, text: string): void => {
    const wake = noticeWake(routine, ownerId, conversationId, at, key, text);
    ctx.objectSendClient<SessionDef>(sessionDef, wake.sessionKey).receive(wake);
  };
  const next = (): void => { ctx.objectSendClient<RoutineTimerDef>(routineTimerDef, routine.id).arm(routine); };

  if (Date.parse(view.expiresAt) <= nowMs) {
    await ctx.run('monitor-expire', () => writeView(store, routine, viewOf({ ...view, lastCheckedAt: at, stoppedReason: 'expired' }), { off: true, emit: true }));
    tell('expired', `Your monitor "${routine.name}" ran its 30 days and has stopped. Ask the person whether they still want it; if they do, renew it with monitor_manage (action "renew", id "${routine.id}").`);
    return { outcome: 'expired' };
  }

  const state = await ctx.run('monitor-state', () => loadMonitorState(store, routine));
  const checked = await ctx.run('monitor-check', () => inOwnerScope(ownerId, () => runCheck(
    { store, blobs, enqueuer: services.enqueuer, tools },
    { ownerId, agentId: routine.agentId, conversationId, routineId: routine.id },
    trigger,
    state.seen,
  )));

  if (checked.ok) {
    let woke = false;
    if (checked.freshTotal > 0 && (await ctx.run('monitor-cap', () => monitorWakeAllowed(store, nowMs)))) {
      const wake = matchWake(routine, ownerId, conversationId, at, checked.fresh, checked.freshTotal);
      ctx.objectSendClient<SessionDef>(sessionDef, wake.sessionKey).receive(wake);
      await ctx.run('monitor-audit', () => recordMonitorWake(store, routine, wake, checked.freshTotal));
      woke = true;
    }
    // Over the wake cap: the new items stay unseen and wake the agent on a later check.
    const held = checked.freshTotal > 0 && !woke;
    await ctx.run('monitor-commit', async () => {
      await store.put('monitorState', { id: routine.id, agentId: routine.agentId, seen: held ? state.seen : mergeSeen(state.seen, checked.currentIds), failures: 0, updatedAt: at });
      const recovered = view.failures > 0 || view.needsReconnect === true;
      const good = viewOf({ ...view, lastCheckedAt: at, lastMatchAt: woke ? at : view.lastMatchAt, failures: 0, lastError: undefined, needsReconnect: undefined });
      await writeView(store, routine, good, { off: false, emit: woke || recovered });
    });
    next();
    return { outcome: woke ? 'woke' : held ? 'held' : 'nothing_new' };
  }

  const failed = applyFailure(state, checked.reconnect, now);
  const failing = viewOf({
    ...view, lastCheckedAt: at, failures: failed.failures, lastError: checked.error.slice(0, 300), needsReconnect: checked.reconnect,
    stoppedReason: failed.stop,
  });
  if (failed.notify) {
    tell('failing_' + String(nowMs), `Your monitor "${routine.name}" has failed ${String(failed.failures)} checks in a row: ${checked.error.slice(0, 200)}. Tell the person once, in a sentence${checked.reconnect ? ' (it looks like the app needs them to sign in again; the monitor shows "needs reconnect")' : ''}. It keeps trying with longer gaps.`);
  }
  if (failed.stop !== undefined) {
    tell('stopped_' + String(nowMs), `Your monitor "${routine.name}" turned itself off after ${failed.stop === 'reconnect' ? '72 hours without a working sign-in' : 'too many failed checks'}: ${checked.error.slice(0, 200)}. Tell the person once; if they want it back, they can switch it on again after fixing the connection.`);
  }
  await ctx.run('monitor-fail', async () => {
    await store.put('monitorState', {
      id: routine.id, agentId: routine.agentId, seen: state.seen, failures: failed.failures,
      ...(failed.notify ? { notifiedAt: at } : state.notifiedAt === undefined ? {} : { notifiedAt: state.notifiedAt }),
      ...(failed.brokenSince === undefined ? {} : { brokenSince: failed.brokenSince }), updatedAt: at,
    });
    await writeView(store, routine, failing, { off: failed.stop !== undefined, emit: true });
  });
  if (failed.stop === undefined) next();
  return { outcome: failed.stop === undefined ? 'failed' : 'stopped' };
}

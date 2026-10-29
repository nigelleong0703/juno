import type { ObjectContext } from '@agent-desktop/durable';
import { rpc } from '@agent-desktop/durable';
import { sessionKey, type Store, type WakeEvent } from '../../../contracts/index.js';
import type { Routine } from '@agent-desktop/public-contracts';
import { docOwner } from '../../execution-owner.js';
import { dueKey, missedRuns, planFire, MISSED_SCAN_MAX } from '../logic/schedule.js';
import { appendSkippedRoutineRun } from '../../../modules/tasks/routines/results.js';
import { routineTimerDef, sessionDef, type RoutineTimerDef, type SessionDef } from './definitions.js';
import { routineRunText, type RunCapabilities } from '../../../modules/tasks/routines/runNote.js';
import { defaultState, withDefaults, type TimerState } from './routineTimer-state.js';

/**
 * Chat the routine delivers to: the validated delivery target when it names a
 * conversation the agent belongs to, else the agent's actual direct chat for
 * legacy target-less routines. Returns undefined when nothing valid exists —
 * callers must skip the wake rather than invent an id.
 */
export async function resolveDeliveryConversation(routine: Routine, store: Store): Promise<string | undefined> {
  if (routine.delivery.channel !== 'chat') return undefined;
  const target = routine.delivery.target;
  if (target !== undefined) {
    const conversation = await store.get('conversations', target);
    if (!conversation || !conversation.agentIds.includes(routine.agentId)) return undefined;
    return conversation.id;
  }
  let cursor: string | undefined;
  do {
    const page = await store.list('conversations', { limit: 100, cursor });
    const chat = page.items.find(conversation =>
      conversation.kind === 'direct' &&
      conversation.agentIds.includes(routine.agentId)
    );
    if (chat) return chat.id;
    cursor = page.nextCursor;
  } while (cursor);
  return undefined;
}

/**
 * The owner a routine's wake belongs to: the stamp the owner-scoped store wrote on the routine, else
 * the routine's agent. Undefined means the routine carries no owner — the caller must refuse to fire
 * rather than invent one (the container previously hardcoded a single-user id here).
 */
export async function resolveRoutineOwner(store: Store, routine: Routine): Promise<string | undefined> {
  const stamped = docOwner(routine);
  if (stamped !== undefined) return stamped;
  return docOwner(await store.get('agents', routine.agentId));
}

/**
 * Routines whose chat delivery actually resolves to one conversation: explicit targets must equal
 * it, target-less routines must resolve to it right now. Paged and bounded; used by mark-read
 * so a read only ever clears the streaks it truly evidences.
 */
export async function routinesDeliveringTo(store: Store, conversationId: string): Promise<Routine[]> {
  const matched: Routine[] = [];
  let cursor: string | undefined;
  do {
    const listed = await store.list('routines', { limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const routine of listed.items) {
      if (routine.delivery.channel !== 'chat') continue;
      if (routine.delivery.target !== undefined) {
        if (routine.delivery.target === conversationId) matched.push(routine);
        continue;
      }
      if ((await resolveDeliveryConversation(routine, store)) === conversationId) matched.push(routine);
    }
    cursor = listed.nextCursor;
  } while (cursor !== undefined);
  return matched;
}

const MAX_FIRED_OCCURRENCES = 50;

/**
 * Deliver one fire (BACKEND 3.6). The occurrences that came due since the durable watermark, minus the keys already delivered
 * (a retry never duplicates), collapse into at most ONE run: the newest. Within the grace window it is an ordinary run; later than
 * that (the server was down) it is a catch-up run whose note says so. The older ones are not run; one history entry,
 * "Skipped: missed while offline", records them. The wake id is the due-offer key (routine + due minute), so a second fire for the
 * same occurrence, on any worker, is one wake. If the delivery session is already running, the run is skipped. Re-arms afterwards
 * so the schedule survives restarts.
 */
export async function deliverOccurrences(
  ctx: ObjectContext,
  services: { store: Store; capabilities?: RunCapabilities },
  routine: Routine,
  ownerId: string,
): Promise<{ delivered: number; dropped: number }> {
  const state = withDefaults((await ctx.get<TimerState>('state')) ?? defaultState(routine.id));
  const now = new Date(await ctx.date.now());
  const lastFiredAt = state.lastFiredAt ? new Date(state.lastFiredAt) : new Date(now.getTime() - 86400000);
  const fresh = missedRuns(routine.trigger, lastFiredAt, now, MISSED_SCAN_MAX).filter(
    (occurrence) => !state.firedOccurrences.includes(occurrence.getTime()),
  );
  const plan = planFire(fresh, now);
  const conversationId = await ctx.run('delivery-conversation', () => resolveDeliveryConversation(routine, services.store));
  const finish = async (delivered: number, dropped: number): Promise<{ delivered: number; dropped: number }> => {
    state.lastFiredAt = now.toISOString();
    ctx.objectSendClient<RoutineTimerDef>(routineTimerDef, routine.id).arm(routine);
    ctx.set('state', state);
    return { delivered, dropped };
  };
  const skipped = plan.skipped;
  const newestSkipped = skipped.at(-1);
  if (newestSkipped !== undefined) {
    const summary = 'Skipped: missed while offline (' + String(skipped.length) + (skipped.length === 1 ? ' run' : ' runs') + ', the latest due ' + newestSkipped.toISOString().slice(0, 16).replace('T', ' ') + ' UTC)';
    await ctx.run('append-skipped', () => appendSkippedRoutineRun(services.store, routine, { id: 'rr-skip-' + dueKey(routine.id, newestSkipped), at: now.toISOString(), summary }));
  }
  if (plan.run === undefined || conversationId === undefined || routine.agentId.length === 0) {
    return finish(0, skipped.length);
  }
  const key = sessionKey(routine.agentId, conversationId);
  const sessionState = await ctx.objectClient<SessionDef>(sessionDef, key).getState();
  if (sessionState.activeRunId !== undefined) return finish(0, fresh.length);
  // The wake text is built fresh for each fire: the instructions, what is true now and what this routine posted lately.
  const text = await ctx.run('routine-run-text', () => routineRunText(services.store, routine, ownerId, now, services.capabilities ?? { webSearch: false, computer: false }));
  const due = plan.run;
  const note = plan.late
    ? text + '\n\n[This run is late: it was due ' + due.toISOString().slice(0, 16).replace('T', ' ') + ' UTC and the server was offline until now'
      + (skipped.length > 0 ? '; ' + String(skipped.length) + ' earlier run' + (skipped.length === 1 ? ' was' : 's were') + ' skipped' : '') + '. Write for the time it is now, not the time it was due.]'
    : text;
  const wakeEvent: WakeEvent = {
    // The due-offer key: any second fire of this occurrence is the same wake and the session accepts it once.
    id: 'wake_routine_' + dueKey(routine.id, due),
    ownerId,
    agentId: routine.agentId,
    sessionKey: key,
    conversationId,
    kind: 'routine' as const,
    origin: { type: 'automation' as const, id: routine.id },
    trusted: true,
    priority: 'background' as const,
    payload: { routineId: routine.id, text: note, occurrenceAt: due.toISOString(), ...(plan.late ? { late: true } : {}) },
    at: due.toISOString(),
    status: 'accepted' as const,
  };
  ctx.objectSendClient<SessionDef>(sessionDef, key).receive(wakeEvent);
  state.firedOccurrences.push(due.getTime());
  state.firedOccurrences = state.firedOccurrences.slice(-MAX_FIRED_OCCURRENCES);
  return finish(1, skipped.length);
}

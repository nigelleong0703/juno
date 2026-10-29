/**
 * Agent-created monitors (BACKEND 3.6.3): running a check and building its wakes. One read-only tool call with the owner's own
 * connection, then the pure rules in monitor.ts. The model is not involved until a check finds something new.
 */
import type { CheckTrigger, Routine } from '@agent-desktop/public-contracts';
import { sessionKey, type BlobStore, type Enqueuer, type MonitorState, type Store, type Tool, type ToolRegistry, type ToolResult, type WakeEvent } from '../../../contracts/index.js';
import {
  evaluate, itemsText, looksLikeReconnect, MONITOR_SHOWN_ITEMS, MONITOR_WAKES_PER_DAY, MONITOR_WAKES_PER_HOUR, unseen,
  type Candidate,
} from './monitor.js';

import { offeredIn, presentToolScope } from '../../tools/scope.js';
import { auditInitiatorFor } from '../../../execution/harness/logic/run-origin.js';

const CALL_TIMEOUT_MS = 60_000;

export interface CheckDeps {
  store: Store;
  blobs: BlobStore;
  enqueuer: Enqueuer;
  tools: Pick<ToolRegistry, 'forAgent'>;
}

export interface CheckTarget {
  ownerId: string;
  agentId: string;
  conversationId: string;
  routineId: string;
}

export type CheckOutcome =
  | { ok: true; /** Every item that matches now. */ currentIds: string[]; /** The new ones (at most MONITOR_SHOWN_ITEMS shown). */ fresh: Candidate[]; freshTotal: number }
  | { ok: false; error: string; reconnect: boolean };

/** Only a connector read tool or web_fetch can be watched: the check runs unattended, so it must not change anything. */
export function readOnlyProblem(tool: Tool): string | undefined {
  if (tool.origin !== undefined) return tool.origin.access === 'read' ? undefined : 'the tool ' + tool.name + ' changes things in the connected app; a monitor can only use a tool that reads';
  return tool.name === 'web_fetch' && !tool.sideEffect ? undefined : 'a monitor can only use a connector read tool or web_fetch, not ' + tool.name;
}

function failure(error: string, reconnect = looksLikeReconnect(error)): CheckOutcome {
  return { ok: false, error, reconnect };
}

/** Make the one tool call and compare its result with what has been seen. */
export async function runCheck(deps: CheckDeps, target: CheckTarget, trigger: CheckTrigger, seen: readonly string[]): Promise<CheckOutcome> {
  const signal = AbortSignal.timeout(CALL_TIMEOUT_MS);
  let available: Tool[];
  try {
    // What the monitor may watch follows its own chat right now (batch 5b): the owner's chat offers its connected apps, a group does not.
    // The synthetic wake says the owner is the one the run serves (a monitor has no person speaking).
    const scope = await presentToolScope(deps.store, {
      ownerId: target.ownerId, agentId: target.agentId, conversationId: target.conversationId,
      wake: [{ ownerId: target.ownerId, origin: { type: 'user', id: target.ownerId }, trusted: true }],
    });
    available = offeredIn(scope, await deps.tools.forAgent(target.agentId, { signal }));
  } catch (error) {
    return failure('could not reach the connected apps: ' + (error instanceof Error ? error.message : String(error)), false);
  }
  const tool = available.find((candidate) => candidate.name === trigger.tool);
  if (tool === undefined) return failure('the tool ' + trigger.tool + ' is not available any more (the app may have been disconnected)', true);
  const problem = readOnlyProblem(tool);
  if (problem !== undefined) return failure(problem, false);
  const at = new Date().toISOString();
  let result: ToolResult;
  try {
    result = await tool.execute(trigger.args, {
      ownerId: target.ownerId, agentId: target.agentId, conversationId: target.conversationId, runId: 'monitor-' + target.routineId,
      store: deps.store, blobs: deps.blobs, enqueuer: deps.enqueuer, step: async (_name, fn) => fn(), signal,
      wake: {
        id: 'monitor-check-' + target.routineId, ownerId: target.ownerId, agentId: target.agentId, sessionKey: sessionKey(target.agentId, target.conversationId),
        conversationId: target.conversationId, kind: 'monitor', origin: { type: 'automation', id: target.routineId }, trusted: false, priority: 'background',
        payload: {}, at, status: 'accepted',
      },
    });
  } catch (error) {
    return failure(trigger.tool + ' failed: ' + (error instanceof Error ? error.message : String(error)));
  }
  if (result.isError === true) return failure(trigger.tool + ' failed: ' + result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ').slice(0, 300));
  const evaluated = evaluate(trigger, result);
  if (!evaluated.ok) return failure(evaluated.error, false);
  const fresh = unseen(evaluated.candidates, seen);
  return { ok: true, currentIds: evaluated.candidates.map((candidate) => candidate.id), fresh: fresh.slice(0, MONITOR_SHOWN_ITEMS), freshTotal: fresh.length };
}

/** What a monitor remembers; a monitor that has not checked yet remembers nothing. */
export async function loadMonitorState(store: Store, routine: Routine): Promise<MonitorState> {
  return (await store.get('monitorState', routine.id)) ?? { id: routine.id, agentId: routine.agentId, seen: [], failures: 0, updatedAt: new Date(0).toISOString() };
}

/** Whether this owner may be woken by another monitor now: at most 30 an hour and 200 a day, counted from the audit log. */
export async function monitorWakeAllowed(store: Store, nowMs: number): Promise<boolean> {
  const page = await store.list('audit', { where: { kind: 'monitor.wake' }, orderBy: 'at', order: 'desc', limit: MONITOR_WAKES_PER_DAY });
  const times = page.items.map((entry) => Date.parse(entry.at));
  return times.filter((time) => nowMs - time < 3_600_000).length < MONITOR_WAKES_PER_HOUR && times.filter((time) => nowMs - time < 86_400_000).length < MONITOR_WAKES_PER_DAY;
}

export async function recordMonitorWake(store: Store, routine: Routine, wake: WakeEvent, count: number): Promise<void> {
  await store.put('audit', {
    ...auditInitiatorFor(null),
    id: 'monitor-wake-' + wake.id, at: wake.at, actor: 'system', agentId: routine.agentId, action: 'monitor.wake',
    decision: 'auto_allowed', reason: 'monitor "' + routine.name + '" found ' + String(count) + ' new item(s)', target: routine.id,
  }, { agentId: routine.agentId, kind: 'monitor.wake' });
}

function monitorWake(routine: Routine, ownerId: string, conversationId: string, id: string, at: string, trusted: boolean, payload: Record<string, unknown>): WakeEvent {
  return {
    id, ownerId, agentId: routine.agentId, sessionKey: sessionKey(routine.agentId, conversationId), conversationId, kind: 'monitor',
    origin: { type: 'automation', id: routine.id, label: 'Monitor: ' + routine.name }, trusted, priority: 'background',
    payload: { routineId: routine.id, routineName: routine.name, ...payload }, at, status: 'accepted',
  };
}

/** New items from the source. They are data, so the wake is untrusted; what to do about them is the person's own instruction. */
export function matchWake(routine: Routine, ownerId: string, conversationId: string, at: string, fresh: readonly Candidate[], total: number): WakeEvent {
  return monitorWake(routine, ownerId, conversationId, 'wake_monitor_' + routine.id + '_' + String(Date.parse(at)), at, false, {
    instructions: routine.instructions, count: total, text: itemsText(fresh, total), occurrenceAt: at,
  });
}

/** Something the agent should say in the chat: the monitor is failing, or it stopped. Our own words, so trusted. */
export function noticeWake(routine: Routine, ownerId: string, conversationId: string, at: string, key: string, text: string): WakeEvent {
  return monitorWake(routine, ownerId, conversationId, 'wake_monitor_notice_' + routine.id + '_' + key, at, true, { notice: true, text, occurrenceAt: at });
}

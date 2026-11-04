/**
 * One-time end of the "Check an uncertain action / What did you verify?" cards (BACKEND §3.3d.5). The agent is told about an uncertain action
 * now and checks it itself; the person gets one plain question only when the agent cannot tell (`ask_about_uncertain_action`).
 *  - A card still waiting is withdrawn (closed, its link to the step removed so the step reads as an unchecked uncertain action again), and
 *    the run that waited on it is ended cleanly: its saved steps end inside the wait this code no longer has, so it cannot continue.
 *  - A card already answered keeps its link, with the state renamed: the choices of the old card map to authorized / declined / completed.
 * A marker row makes later boots skip all of it. Pass the raw (unscoped) store.
 */
import type { Store, StoredRequest } from '../../contracts/index.js';
import { toPublicRequest } from '../../contracts/index.js';
import { emitAgentStatus } from '../../execution/agent-status.js';
import { runTerminalEvent } from '../../execution/harness/services/agui-events.js';
import { getRow, newRow, putRow } from '../home/mirror.js';
import { listAll } from '../memory/util.js';
import { closeRunTasks } from './agent-tasks.js';

export const MARKER = '__migrations/uncertain-action-notice-v1';

const ENDED_RUN_REASON = 'This run was stopped by an update while it waited for an answer about an action that may or may not have happened. Nothing was repeated. Ask again if you still want it.';

const RENAMED: Readonly<Record<string, 'authorized' | 'declined' | 'consumed' | 'completed'>> = {
  user_confirmed_not_executed: 'authorized',
  still_unknown: 'declined',
  retry_consumed: 'consumed',
  retry_completed: 'completed',
  user_reported_succeeded: 'completed',
};

export interface RecoveryMigration { skipped: boolean; withdrawn: number; renamed: number; runsEnded: number }

export async function migrateRecoveryCards(store: Store): Promise<RecoveryMigration> {
  if ((await getRow(store, 'system', MARKER)) !== null) return { skipped: true, withdrawn: 0, renamed: 0, runsEnded: 0 };
  let withdrawn = 0;
  let renamed = 0;
  const endRuns = new Set<string>();
  for (const request of await listAll(store, 'requests')) {
    const link = request.reconciliation;
    if (link === undefined) continue;
    const state: string = link.state;
    if (state === 'pending') {
      const { reconciliation: _link, ...rest } = request;
      const closed: StoredRequest = { ...rest, status: 'expired', resolvedAt: new Date().toISOString() };
      await store.put('requests', closed, request.runId === undefined ? undefined : { runId: request.runId });
      await store.emit({ type: 'request.resolved', request: toPublicRequest(closed) });
      withdrawn += 1;
      if (request.runId !== undefined) endRuns.add(request.runId);
      continue;
    }
    const next = RENAMED[state];
    if (next === undefined) continue;
    const { reason: _reason, source: _source, ...kept } = link as typeof link & { reason?: unknown; source?: unknown };
    await store.patch('requests', request.id, { reconciliation: { ...kept, state: next } });
    renamed += 1;
  }
  let runsEnded = 0;
  for (const runId of endRuns) {
    const run = await store.get('runs', runId);
    if (run === null) continue;
    // The review is over either way: the card is gone.
    const settled = run.effectReview === 'open' ? await store.patch('runs', runId, { effectReview: 'resolved' }) : run;
    if (settled.status === 'completed' || settled.status === 'failed' || settled.status === 'stopped' || settled.status === 'blocked') continue;
    const failed = await store.patch('runs', runId, { status: 'failed', finishedAt: new Date().toISOString(), error: ENDED_RUN_REASON });
    await store.emit(runTerminalEvent(failed));
    await closeRunTasks(store, failed);
    await emitAgentStatus(store, failed.agentId);
    runsEnded += 1;
  }
  await putRow(store, newRow('system', MARKER, '', 'platform', new Date().toISOString()));
  return { skipped: false, withdrawn, renamed, runsEnded };
}

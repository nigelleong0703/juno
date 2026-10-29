import { type Hono } from 'hono';
import { NotFoundError, sessionKey } from '@agent-desktop/contracts';
import { parseListQueryWithWhere } from './query-helpers.js';
import type { AgentdDeps } from './index.js';
import { getOwnerId } from '../auth.js';
import { docOwnerId } from './relationships.js';
import type { Run } from '@agent-desktop/public-contracts';
import { expirePendingRequests } from 'juno-agent/execution/child-run-input';
import { emitAgentStatus } from 'juno-agent/execution/agent-status';
import { runTerminalEvent } from 'juno-agent/execution/harness/services/agui-events';
import { closeRunTasks } from 'juno-agent/modules/tasks/agent-tasks';
import { recordRunStop } from 'juno-agent/modules/tasks/stop-record';
import type { StopActor } from '@agent-desktop/contracts';

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped', 'blocked']);

export function registerRuns(app: Hono, deps: AgentdDeps) {
  app.get('/v1/runs', async (c) => {
    const query = parseListQueryWithWhere(c.req.query(), ['agentId', 'conversationId', 'runId', 'status', 'kind', 'parentId', 'ids']);
    const page = await deps.store.list('runs', query);
    return c.json({ items: page.items, nextCursor: page.nextCursor });
  });

  app.get('/v1/runs/:id', async (c) => {
    const run = await deps.store.get('runs', c.req.param('id'));
    if (!run) throw new NotFoundError('runs', c.req.param('id'));
    return c.json(run);
  });

  /**
   * H-79: request a stop; never fake it. A finished run is returned unchanged with no event. A live run
   * gets the cancel signal and finalizes itself (it writes `stopped` and emits run.finished when it has
   * actually stopped). A run no workflow will finalize (orphaned row, or a paused workflow, which is
   * killed first: H-92) is stopped here, with the same cleanup a finalize does: its pending requests
   * expire, its live children are stopped, and its chat is released.
   */
  app.post('/v1/runs/:id/stop', async (c) => {
    const current = await deps.store.get('runs', c.req.param('id'));
    if (!current) throw new NotFoundError('runs', c.req.param('id'));
    const outcome = await stopRunTruthfully(deps, current);
    if (outcome === 'failed') return c.json({ error: { code: 'STOP_FAILED', message: 'The stop could not be delivered; the run is unchanged. Try again.' } }, 502);
    return outcome === 'signalled' ? c.json(current, 202) : c.json(outcome);
  });

  /** The owner has seen this run's result: Today stops listing it as completed. Idempotent. */
  app.post('/v1/runs/:id/seen', async (c) => {
    const run = await deps.store.get('runs', c.req.param('id'));
    const owner = docOwnerId(run);
    if (!run || (owner !== undefined && owner !== getOwnerId(c))) throw new NotFoundError('runs', c.req.param('id'));
    return c.json(run.seenAt === undefined ? await deps.store.patch('runs', run.id, { seenAt: new Date().toISOString() }) : run);
  });

  app.get('/v1/runs/:id/steps', async (c) => {
    const query = parseListQueryWithWhere(c.req.query(), ['agentId', 'conversationId', 'runId', 'status', 'kind', 'parentId', 'ids']);
    const page = await deps.store.list('steps', {
      ...query,
      where: { ...query.where, runId: c.req.param('id') },
    });
    return c.json({ items: page.items, nextCursor: page.nextCursor });
  });
}

/** Stop one run (and, for a run stopped here, its live children). Returns 'signalled' or the final row. */
export async function stopRunTruthfully(deps: AgentdDeps, current: Run, by: StopActor = 'owner'): Promise<'signalled' | 'failed' | Run> {
  const runId = current.id;
  if (TERMINAL_RUN_STATUSES.has(current.status)) return current;
  // Written before the signal: the run reads as stopped by whoever asked first, whichever process finishes the stop.
  await recordRunStop(deps.store, runId, by);
  const state = await deps.enqueuer.runState?.(runId).catch(() => undefined);
  // Only a run nothing will finalize (no workflow invocation left) is stopped here. A live or unknown
  // run whose cancel could not be sent is left untouched: marking it stopped and freeing the chat
  // would let a second run start beside a workflow that is still executing.
  if (state !== 'none') {
    try {
      await deps.enqueuer.stopRun(runId);
      return 'signalled';
    } catch {
      return 'failed';
    }
  }
  {
    const run = await deps.store.patch('runs', runId, { status: 'stopped', finishedAt: new Date().toISOString() });
    await deps.store.emit(runTerminalEvent(run));
    await closeRunTasks(deps.store, run);
    await expirePendingRequests(deps.store, runId).catch(() => undefined);
    for (const child of await liveChildren(deps, runId)) await stopRunTruthfully(deps, child, by).catch(() => undefined);
    await emitAgentStatus(deps.store, run.agentId);
    // Free the chat: if this run is still the session's active run, queued messages start now.
    const childKey: unknown = Reflect.get(run, 'childSessionKey');
    const key = typeof childKey === 'string' && childKey.length > 0 ? childKey : run.conversationId ? sessionKey(run.agentId, run.conversationId) : undefined;
    if (key !== undefined) await deps.enqueuer.releaseSession?.(key, runId).catch(() => undefined);
    return run;
  }
}

/**
 * Stop-all for one agent: every run it has that is not finished (running, queued, or parked on a
 * request), children included, each through the per-run stop path above. A run whose stop could not
 * be delivered is not counted. Returns how many stops were issued.
 */
export async function stopAgentRuns(deps: AgentdDeps, agentId: string): Promise<number> {
  let stopped = 0;
  for (const status of ['running', 'queued', 'waiting_for_input']) {
    const page = await deps.store.list('runs', { where: { agentId, status }, limit: 200 });
    for (const listed of page.items) {
      // A parent's stop may already have stopped this child: re-read instead of counting it twice.
      const current = await deps.store.get('runs', listed.id);
      if (!current || TERMINAL_RUN_STATUSES.has(current.status)) continue;
      if ((await stopRunTruthfully(deps, current)) !== 'failed') stopped += 1;
    }
  }
  return stopped;
}

async function liveChildren(deps: AgentdDeps, parentRunId: string): Promise<Run[]> {
  const out: Run[] = [];
  let cursor: string | undefined;
  do {
    const page = await deps.store.list('runs', { where: { parentId: parentRunId }, limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    for (const run of page.items) if (!TERMINAL_RUN_STATUSES.has(run.status)) out.push(run);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

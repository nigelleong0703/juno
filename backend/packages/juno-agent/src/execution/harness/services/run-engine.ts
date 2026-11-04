import { TerminalError } from '@agent-desktop/durable';
import { z } from 'zod';
import type { Store } from '../../../contracts/index.js';
import { runUsageSchema } from '@agent-desktop/public-contracts';
import type { Agent, Run, RunEngineSnapshot } from '@agent-desktop/public-contracts';
import type { RunCancellation } from './cancel.js';
import { createPiAdapter, PI_ENGINE_VERSION } from '../engines/pi.js';
import { createEngineRegistry, type EngineAdapter, type EngineRegistry } from '../engines/registry.js';
import { resolveRunEngine } from '../engines/selection.js';
import type { RunInput } from './run-types.js';
import { runKindFor, runTitleFor } from '../logic/busy.js';
import { nobodyWaitingOf, originOfWake, rootOriginOf } from '../logic/run-origin.js';
import { expirePendingRequests } from '../../subagent-run-input';
import { emitAgentStatus } from '../../agent-status.js';
import { putRunPreservingSubagent } from './run-reservation.js';
import { runStartedEvent, runTerminalEvent } from './agui-events.js';
import { closeRunTasks, emitRunTask } from '../../../modules/tasks/agent-tasks.js';
import { previewOfWake } from '../../../modules/tasks/routines/preview.js';

export function defaultRegistry(): EngineRegistry {
  return createEngineRegistry([createPiAdapter()]);
}

/**
 * The title of the task a completion wake (task_done, or a child's hand_back) reports on: the child run's own title, else the
 * background task's. Undefined for every other wake or when the task is gone, so the run title never falls back to the raw result.
 */
async function reportedTaskTitle(store: Store, input: RunInput): Promise<string | undefined> {
  const first = input.wakeEvents[0];
  const taskId = first?.payload['taskId'];
  if ((first?.kind !== 'task_done' && first?.kind !== 'hand_back') || typeof taskId !== 'string' || taskId === '') return undefined;
  const title = (await store.get('runs', taskId))?.title ?? (await store.get('backgroundTasks', taskId))?.title;
  return title === undefined || title.trim() === '' ? undefined : title;
}

async function newRun(store: Store, input: RunInput, runId: string, engine?: RunEngineSnapshot): Promise<Run & { nobodyWaiting?: boolean; preview?: true }> {
  const now = new Date().toISOString();
  const origin = originOfWake(input.conversationId, input.wakeEvents[0]);
  const rootOrigin = await rootOriginOf(store, origin, input.wakeEvents[0]);
  const nobodyWaiting = await nobodyWaitingOf(store, input.wakeEvents[0]);
  const preview = await previewOfWake(store, input.wakeEvents[0]);
  return {
    ...(nobodyWaiting ? { nobodyWaiting } : {}),
    ...(preview ? { preview } : {}),
    id: runId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    origin,
    ...(rootOrigin === undefined ? {} : { rootOrigin }),
    ...(origin.type === 'routine' ? { routineId: origin.routineId } : {}),
    // H-77: title and kind come from the wake that started the run.
    title: runTitleFor(input.wakeEvents, await reportedTaskTitle(store, input)),
    status: 'running',
    kind: runKindFor(input.wakeEvents[0]?.kind ?? 'user_message'),
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: now,
    lastActivityAt: now,
    ...(engine === undefined ? {} : { engine }),
  };
}

/** Narrow durable surface the start sequence needs; tests drive it with an in-memory fake. */
export interface RunStartContext {
  runInit(action: () => Promise<RunEngineSnapshot>): Promise<RunEngineSnapshot>;
  runFail(action: () => Promise<void>): Promise<void>;
  releaseSession(sessionKey: string, runId: string): Promise<void>;
}

function selectionMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Snapshot a legacy run (journaled before engine selection existed) carries. */
function legacySnapshot(): RunEngineSnapshot {
  return { id: 'pi', version: PI_ENGINE_VERSION };
}

async function failRunStart(
  ctx: RunStartContext, store: Store, input: RunInput, runId: string,
  message: string, engine: RunEngineSnapshot | undefined, cancelled: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  await ctx.runFail(async () => {
    await expirePendingRequests(store, runId);
    const finished = await putRunPreservingSubagent(store, {
      ...(await newRun(store, input, runId, engine)),
      status: cancelled ? 'stopped' : 'failed',
      finishedAt: now,
      error: message,
    }, false);
    await store.emit(runTerminalEvent(finished));
    await closeRunTasks(store, finished);
    await emitAgentStatus(store, finished.agentId);
  });
  await ctx.releaseSession(input.sessionKey, runId);
}

/** Resolve the engine, journal its snapshot, and validate it against the adapter. Terminal
 * selection failures finalize a failed (or stopped) Run and release the Session. */
export async function startEngineForRun(
  ctx: RunStartContext,
  store: Store,
  registry: EngineRegistry,
  agent: Agent | null,
  input: RunInput,
  runId: string,
  cancellation: Pick<RunCancellation, 'peek'>,
): Promise<{ adapter: EngineAdapter; snapshot: RunEngineSnapshot }> {
  let adapter: EngineAdapter;
  let snapshot: RunEngineSnapshot;
  try {
    // Shared pi engine: legacy agent engine/model data is ignored.
    void agent;
    const resolved = resolveRunEngine(registry);
    adapter = resolved.adapter;
    snapshot = resolved.snapshot;
  } catch (error) {
    const message = selectionMessage(error);
    await failRunStart(ctx, store, input, runId, message, undefined, await cancellation.peek());
    throw new TerminalError(message);
  }

  const journaled = await ctx.runInit(async () => {
    const created = await putRunPreservingSubagent(store, await newRun(store, input, runId, snapshot), true);
    await store.emit(runStartedEvent(created));
    await emitRunTask(store, created, true);
    await emitAgentStatus(store, created.agentId);
    return snapshot;
  });
  // On resume the journaled snapshot replays while the adapter resolves fresh: an exact
  // id+version match is required, or the Run would continue on a different engine build.
  const effective = journaled ?? legacySnapshot();
  if (effective.id !== adapter.id || effective.version !== adapter.version) {
    const message = 'engine changed mid-run: journaled ' + effective.id + '@' + effective.version + ', resolved ' + adapter.id + '@' + adapter.version;
    await failRunStart(ctx, store, input, runId, message, effective, await cancellation.peek());
    throw new TerminalError(message);
  }
  return { adapter, snapshot: effective };
}

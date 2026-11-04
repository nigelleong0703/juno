import { LIMITS, type BackgroundTask, type ListPage, type Store, type WakeEvent } from '../../contracts/index.js';

/** Chain limits for background work (see LIMITS.chain). */
export const MAX_BACKGROUND_GENERATIONS = LIMITS.chain.maxBackgroundGenerations;
export const MAX_BACKGROUND_PER_CHAIN = LIMITS.chain.maxBackgroundRuns;

/** Where and how a background child reports back (H-69): the spawning session plus its chain position. */
export interface BackgroundSpawn {
  chainId: string;
  generation: number;
}

/**
 * Refuse a background start past the chain's generation cap or its total. The total counts notifying
 * child runs and notifying shell / MCP / wait_for records of the chain (H-72/H-73), so every kind that
 * wakes the session shares one budget against loops.
 */
export async function backgroundCapRefusal(store: Store, conversationId: string, notify: BackgroundSpawn): Promise<'background_limit' | undefined> {
  if (notify.generation > MAX_BACKGROUND_GENERATIONS) return 'background_limit';
  let inChain = 0;
  let cursor: string | undefined;
  do {
    const page = await store.list('runs', { where: { conversationId, kind: 'background' }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    for (const run of page.items) {
      const target: unknown = Reflect.get(run, 'notifyParent');
      if (typeof target !== 'object' || target === null) continue;
      // A completion steered into a still-running run leaves ctx.wake at the original message, so the
      // generation alone could reset; the per-chain total closes that path.
      if (Reflect.get(target, 'chainId') === notify.chainId) inChain += 1;
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  let taskCursor: string | undefined;
  do {
    const page: ListPage<BackgroundTask> = await store.list('backgroundTasks', { where: { conversationId }, limit: 100, ...(taskCursor === undefined ? {} : { cursor: taskCursor }) });
    for (const task of page.items) {
      if (task.notify && task.chainId === notify.chainId) inChain += 1;
    }
    taskCursor = page.nextCursor;
  } while (taskCursor !== undefined);
  return inChain >= MAX_BACKGROUND_PER_CHAIN ? 'background_limit' : undefined;
}

/** The chain position a background start made by this run would have (the same rule child spawns use). */
export function backgroundSpawnOf(wake: Pick<WakeEvent, 'kind' | 'payload' | 'hop'>, runId: string): BackgroundSpawn {
  return { chainId: wake.hop?.chainId ?? runId, generation: nextBackgroundGeneration(wake) };
}

/**
 * H-75: the background generation a new background task started now would have. A run woken by a
 * task_done continues that chain one generation deeper; any other run starts at 1. Every background
 * kind (child, shell, event, mcp) uses this and refuses past MAX_BACKGROUND_GENERATIONS.
 */
export function nextBackgroundGeneration(wake: Pick<WakeEvent, 'kind' | 'payload'>): number {
  const prior = wake.kind === 'task_done' && typeof wake.payload['generation'] === 'number' ? wake.payload['generation'] : 0;
  return prior + 1;
}

export const BACKGROUND_LIMIT_TEXT = 'background task limit reached: this chain already went ' + String(MAX_BACKGROUND_GENERATIONS) + ' background generations deep; finish without starting another background task';

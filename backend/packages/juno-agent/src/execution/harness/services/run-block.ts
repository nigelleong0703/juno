import type { RunBlockCause, Store } from '../../../contracts/index.js';
import type { BlockCause } from './task-hooks.js';

/** The cause the task list shows for each reason the todo gate blocks a run. */
export function runBlockCause(cause: BlockCause): RunBlockCause {
  if (cause === 'waiting') return 'needs_input';
  if (cause === 'stalled') return 'no_progress';
  return cause;
}

/**
 * Record why a run will end `blocked`: the readable reason in `error` and the cause as data, in one write.
 * The task list (BACKEND 6.5) reads `blockCause`; it never parses the text.
 */
export async function markRunBlocked(store: Store, runId: string, cause: RunBlockCause, error: string): Promise<void> {
  await store.patch('runs', runId, { error, blockCause: cause });
}

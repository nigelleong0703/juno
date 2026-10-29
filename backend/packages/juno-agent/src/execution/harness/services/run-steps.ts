import type { Doc, Store } from '../../../contracts/index.js';
import { emitRunTask } from '../../../modules/tasks/agent-tasks.js';

/**
 * H-88: append a finished step to its run under the run row lock, so concurrent appends never drop each other.
 * Idempotent per step id: the caller runs inside a journaled effect that re-executes when a crash lands
 * between this write and the journal entry, and the replay must not list the step twice.
 */
export async function appendRunStep(store: Store, runId: string, step: Doc<'steps'>): Promise<void> {
  const run = await store.tx(async (tx) => {
    const current = tx.getForUpdate === undefined ? await tx.get('runs', runId) : await tx.getForUpdate('runs', runId);
    const steps = current?.steps ?? [];
    return tx.patch('runs', runId, { steps: steps.some((s) => s.id === step.id) ? steps.map((s) => (s.id === step.id ? step : s)) : [...steps, step] });
  });
  // A subagent's (or routine run's) latest step is its task's progress line.
  await emitRunTask(store, run);
}

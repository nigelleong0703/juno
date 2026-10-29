import type { RestatePromise } from '@agent-desktop/durable';
import type { Store, TaskDonePayload, WakeEvent } from '../../../contracts/index.js';
import { taskDoneWake } from './completion-wake.js';

/** H-69/H-70: a background child (spawned with notify) reports its end to the session that spawned it. */
export interface NotifyParent {
  ownerId: string;
  agentId: string;
  conversationId: string;
  chainId: string;
  /** Background generation of this child within its chain (1 = spawned by a user-started run). */
  generation: number;
}

export function readNotifyParent(run: unknown): NotifyParent | undefined {
  if (typeof run !== 'object' || run === null) return undefined;
  const value: unknown = Reflect.get(run, 'notifyParent');
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (key: string): unknown => Reflect.get(value, key);
  const strings = ['ownerId', 'agentId', 'conversationId', 'chainId'].map(field);
  const generation = field('generation');
  if (!strings.every((s) => typeof s === 'string' && s.length > 0) || typeof generation !== 'number') return undefined;
  return { ownerId: String(strings[0]), agentId: String(strings[1]), conversationId: String(strings[2]), chainId: String(strings[3]), generation };
}

/**
 * Send the parent exactly one `task_done` for this child's terminal state. The read is journaled, the
 * wake id is `<childRunId>:done` (Session dedupes on it) and the send itself is journaled by Restate,
 * so a replay or retry never reports twice. Non-background runs and missing send support are no-ops.
 */
export async function notifyBackgroundParent(
  ctx: { run<T>(name: string, action: () => Promise<T>): RestatePromise<T>; sendWake?: (wake: WakeEvent) => void },
  store: Store,
  runId: string,
  status: TaskDonePayload['status'],
): Promise<void> {
  // A stopped child was stopped on purpose (user Stop, child_cancel, the parent's own end): waking the
  // parent for it would make the agent speak again after the user stopped it.
  if (ctx.sendWake === undefined || status === 'stopped') return;
  const wake = await ctx.run('child-notify:' + status, async () => {
    const row = await store.get('runs', runId);
    const target = readNotifyParent(row);
    if (target === undefined) return null;
    const result = row !== null && typeof Reflect.get(row, 'childResult') === 'string' ? String(Reflect.get(row, 'childResult')) : '';
    // The stored result is already bounded; a longer one is named by its artifact ref instead of cut.
    const ref = row !== null && typeof Reflect.get(row, 'childResultRef') === 'string' ? String(Reflect.get(row, 'childResultRef')) : undefined;
    const summary = (result || 'Child task ' + status + ' with no reported result.') + (ref === undefined ? '' : '\n[full result kept as artifact ' + ref + '; read it with output_read]');
    return taskDoneWake(
      { ownerId: target.ownerId, agentId: target.agentId, conversationId: target.conversationId, hop: { chainId: target.chainId, depth: 0 } },
      { taskId: runId, taskKind: 'child', status, summary, generation: target.generation, ...(ref === undefined ? {} : { resultRef: ref }), ...(typeof Reflect.get(row ?? {}, 'parentRunId') === 'string' ? { originRunId: String(Reflect.get(row ?? {}, 'parentRunId')) } : {}) },
      new Date().toISOString(),
    );
  });
  if (wake !== null) ctx.sendWake(wake);
}

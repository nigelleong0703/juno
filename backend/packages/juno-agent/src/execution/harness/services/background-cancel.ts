import { RestatePromise } from '@agent-desktop/durable';
import type { Store } from '../../../contracts/index.js';
import { trackBackgroundCall, untrackBackgroundCall } from '../../../modules/tasks/background-registry.js';
import { createRunCancellation } from './cancel.js';

/** Stop is durable in the task row; the local abort signal only makes the same decision faster. */
export function backgroundCancellation(store: Store, taskId: string) {
  const signal = trackBackgroundCall(taskId);
  let resolveStop: (stopped: boolean) => void = () => {};
  const stopped = RestatePromise.resolve(new Promise<boolean>((resolve) => { resolveStop = resolve; }));
  const cancellation = createRunCancellation({
    peek: async () => signal.aborted || (await store.get('backgroundTasks', taskId))?.status === 'stopped',
    get: () => stopped,
  });
  const abort = (): void => { cancellation.abort(); resolveStop(true); };
  signal.addEventListener('abort', abort, { once: true });
  const check = async (): Promise<boolean> => {
    if (await cancellation.peek()) abort();
    return cancellation.state.cancelled;
  };
  const timer = setInterval(() => { void check().catch(() => {}); }, 250);
  timer.unref?.();
  return {
    cancellation, check,
    close(): void { clearInterval(timer); signal.removeEventListener('abort', abort); untrackBackgroundCall(taskId); },
  };
}

/**
 * A cap on the tool calls in flight to one connection. Read tools of a connector run concurrently when one model reply asks for
 * several (run-tools.ts executeParallelToolCalls); this keeps one server from being flooded by a long reply or by several runs
 * of the same owner. Calls past the cap wait their turn in the process (they are not failed), and a stop frees a waiting call.
 */
export const MCP_CALLS_PER_CONNECTION = 4;

export interface CallLimiter {
  run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

interface Slot {
  active: number;
  waiting: Array<() => void>;
}

export function createCallLimiter(limit: number = MCP_CALLS_PER_CONNECTION): CallLimiter {
  const slots = new Map<string, Slot>();

  function acquire(key: string, signal: AbortSignal | undefined): Promise<void> {
    const slot = slots.get(key) ?? { active: 0, waiting: [] };
    slots.set(key, slot);
    if (slot.active < limit) {
      slot.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const turn = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const at = slot.waiting.indexOf(turn);
        if (at >= 0) slot.waiting.splice(at, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('the call was stopped while waiting for the connection'));
      };
      slot.waiting.push(turn);
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function release(key: string): void {
    const slot = slots.get(key);
    if (slot === undefined) return;
    const next = slot.waiting.shift();
    // The turn passes to the next waiting call without freeing the slot.
    if (next !== undefined) next();
    else {
      slot.active -= 1;
      if (slot.active === 0) slots.delete(key);
    }
  }

  return {
    async run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await acquire(key, signal);
      try {
        return await task();
      } finally {
        release(key);
      }
    },
  };
}

/**
 * Wait for a row another process writes (BACKEND 2.2c): read it every `intervalMs` until it has an answer, the time is up or the
 * run is stopped. Used where a worker asks the coordinator for something (an iPhone call, a Discord voice tool) and the answer
 * can only come back through the database.
 */
export type PollOutcome<T> = { kind: 'value'; value: T } | { kind: 'timeout' } | { kind: 'aborted' };

export async function pollFor<T>(
  read: () => Promise<T | undefined>,
  options: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal },
): Promise<PollOutcome<T>> {
  const deadline = Date.now() + options.timeoutMs;
  const interval = options.intervalMs ?? 200;
  for (;;) {
    if (options.signal?.aborted === true) return { kind: 'aborted' };
    const value = await read();
    if (value !== undefined) return { kind: 'value', value };
    const left = deadline - Date.now();
    if (left <= 0) return { kind: 'timeout' };
    await sleep(Math.min(interval, left), options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

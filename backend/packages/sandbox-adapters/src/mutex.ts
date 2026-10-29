/**
 * A tiny keyed mutex. The executor uses it to serialize the two operations that must not race:
 * creating the shared VM (two first-use requests must not create two sandboxes) and allocating one
 * agent's display (a double-click must not boot two Xvfb on the same display).
 */
export interface KeyedMutex {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function createKeyedMutex(): KeyedMutex {
  const tails = new Map<string, Promise<void>>();
  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      tails.set(key, tail);
      await previous;
      try {
        return await fn();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}

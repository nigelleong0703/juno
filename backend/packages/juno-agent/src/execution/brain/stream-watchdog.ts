import { ModelTurnError } from './model-turn-error.js';

/** Bound absent progress independently of whether the transport honors abort. */
export function createStreamWatchdog(parent: AbortSignal, firstMs: number, idleMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectFailure: (reason: unknown) => void = () => undefined;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  void failure.catch(() => undefined);
  function fail(reason: unknown) {
    if (controller.signal.aborted) return;
    rejectFailure(reason);
    controller.abort(reason);
    if (timer !== undefined) clearTimeout(timer);
  }
  function arm(ms: number, first: boolean) {
    if (timer !== undefined) clearTimeout(timer);
    if (controller.signal.aborted) return;
    timer = setTimeout(() => fail(new ModelTurnError(
      first ? 'first_response_timeout' : 'stream_idle_timeout',
      first ? 'Model response timed out before any progress. Please retry.' : 'Model stream timed out without further progress. Please retry.',
    )), ms);
  }
  const abort = () => fail(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener('abort', abort, { once: true });
  arm(firstMs, true);
  return {
    signal: controller.signal,
    progress: () => arm(idleMs, false),
    wait: <T>(promise: PromiseLike<T>): Promise<T> => Promise.race([Promise.resolve(promise), failure]),
    close() {
      if (timer !== undefined) clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    },
  };
}

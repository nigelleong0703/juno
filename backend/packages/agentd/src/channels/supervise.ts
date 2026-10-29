/**
 * The one row supervisor of the channel runners: a platform that keeps a connection per channel row (Telegram's long poll, the Feishu
 * socket, a Discord gateway) only says how to serve one row (`run`); this keeps one `run` going for every live row of its kind.
 * The rows are rescanned every 30 seconds, so a connect starts serving and a disconnect (the row gone, or marked `invalid_token`)
 * aborts the row's signal. A `run` that returns or crashes is started again by the next rescan. Stopping aborts every signal.
 */
import { createLogger } from '@agent-desktop/log';
import type { ChannelRow } from '@agent-desktop/contracts';
import type { ChannelRunnerContext } from './runners.js';

const log = createLogger({ service: 'agentd' });

const RESCAN_MS = 30_000;

/** Resolves after `ms`, or at once when the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Resolves when the signal aborts (a connection that lives as long as its row). */
export function untilAborted(signal: AbortSignal): Promise<void> {
  return signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

export interface RowSupervision {
  /** The channel rows of this kind are served. */
  kind: string;
  /** Names the loop in the log ("telegram poll", "discord gateway"). */
  label: string;
  /** Rows that are not served even though they are live (default: all live rows). */
  include?(row: ChannelRow): boolean;
  /** Serves one row until `signal` aborts; returning early ends it until the next rescan. */
  run(rowId: string, signal: AbortSignal): Promise<void>;
}

/** Starts serving the rows; the returned function stops it. */
export function superviseRows(ctx: ChannelRunnerContext, spec: RowSupervision): () => void {
  const loops = new Map<string, AbortController>();
  const rescan = async (): Promise<void> => {
    const page = await ctx.store.list('channels', { where: { kind: spec.kind }, limit: 500 });
    const live = new Set(page.items.filter((row) => row.status !== 'invalid_token' && (spec.include?.(row) ?? true)).map((row) => row.id));
    for (const [id, controller] of loops) {
      if (!live.has(id)) { controller.abort(); loops.delete(id); }
    }
    for (const id of live) {
      if (loops.has(id)) continue;
      const controller = new AbortController();
      loops.set(id, controller);
      void spec.run(id, controller.signal)
        .catch((err: unknown) => log.error({ err, channel: id }, spec.label + ' loop crashed'))
        .finally(() => { if (loops.get(id) === controller) loops.delete(id); });
    }
  };
  const scan = (): void => { void rescan().catch((err: unknown) => log.warn({ err }, spec.label + ' channel rescan failed')); };
  scan();
  const timer = setInterval(scan, RESCAN_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    for (const controller of loops.values()) controller.abort();
    loops.clear();
  };
}

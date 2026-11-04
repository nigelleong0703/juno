import type { EventBus } from '@agent-desktop/contracts';
import { createLogger } from '@agent-desktop/log';
import { coalescingLive, createLiveRuns, type LiveRunSink, type LiveRuns } from 'juno-agent/execution/live-runs';

const log = createLogger({ service: 'agentd' });

/**
 * Live run text (BACKEND voice/streaming): one in-process hub per process. A process that runs everything (`all`) hands text from its
 * runs to its HTTP stream in memory and never touches the database for it. Only a split deployment needs a transport: a worker's runs
 * publish into a coalescing sink that crosses over NOTIFY in batches, and the coordinator relays what arrives into its own hub.
 */
export async function wireLive(bus: EventBus, mode: { coordinator: boolean; executes: boolean }): Promise<{ live: LiveRuns; sink: LiveRunSink; stop: () => Promise<void> }> {
  const live = createLiveRuns((error) => log.warn({ err: error }, 'live run text subscriber failed'));
  if (mode.coordinator && mode.executes) return { live, sink: live, stop: async () => undefined };
  if (mode.coordinator) {
    const off = await bus.subscribeLive?.((event) => live.publish(event));
    return { live, sink: live, stop: async () => { off?.(); } };
  }
  const publishLive = bus.publishLive?.bind(bus);
  const sink = coalescingLive({
    send: async (batch) => { await publishLive?.(batch); },
    onError: (error) => log.warn({ err: error }, 'live run text not relayed to the coordinator'),
  });
  return { live, sink, stop: sink.stop };
}

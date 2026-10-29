import type { AgentEvent, EventSource, Unsubscribe } from '@agent-desktop/client';

export type EventSink = (event: AgentEvent) => void;

/**
 * Fans one shared live stream out to every attached sink. The stream is opened when the first sink
 * attaches and closed when the last one detaches, so an idle client holds no connection. The client
 * keeps its resume cursor across those restarts, so events are not lost between turns.
 */
export class EventHub {
  private readonly sinks = new Set<EventSink>();
  private stopStream: Unsubscribe | null = null;

  constructor(private readonly source: EventSource) {}

  attach(sink: EventSink): Unsubscribe {
    this.sinks.add(sink);
    this.stopStream ??= this.source.subscribe((event) => this.dispatch(event));
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.sinks.delete(sink);
      if (this.sinks.size === 0 && this.stopStream !== null) {
        const stop = this.stopStream;
        this.stopStream = null;
        stop();
      }
    };
  }

  private dispatch(event: AgentEvent): void {
    for (const sink of [...this.sinks]) sink(event);
  }
}

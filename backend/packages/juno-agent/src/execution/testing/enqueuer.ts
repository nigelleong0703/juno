/**
 * Host-equivalent recording enqueuer for runtime tests.
 *
 * Unlike the db-semantics Noop in testing/store.ts, this records call arguments and supports
 * startChildRun, matching the host RestateEnqueuer's test double. Tests that only need a silent
 * enqueuer keep using the store fixture; tests asserting dispatch use this one.
 */
import type { ChildRunStart, Enqueuer, Store, WakeEvent } from '../../contracts/index.js';

export class RecordingEnqueuer implements Enqueuer {
  calls: Array<{ method: string; args: unknown[] }> = [];

  constructor(private store?: Store) {}

  async enqueue(event: WakeEvent): Promise<{ accepted: boolean; reason?: string }> {
    this.calls.push({ method: 'enqueue', args: [event] });
    return { accepted: true };
  }

  async stopRun(runId: string): Promise<void> {
    this.calls.push({ method: 'stopRun', args: [runId] });
  }

  async resolveAwakeable(awakeableId: string, value: unknown): Promise<void> {
    this.calls.push({ method: 'resolveAwakeable', args: [awakeableId, value] });
  }

  async scheduleRoutine(routineId: string): Promise<void> {
    this.calls.push({ method: 'scheduleRoutine', args: [routineId] });
  }

  async routineResultsRead(receipt: unknown): Promise<void> {
    this.calls.push({ method: 'routineResultsRead', args: [receipt] });
  }

  async startChildRun(input: ChildRunStart): Promise<void> {
    this.calls.push({ method: 'startChildRun', args: [input.runId] });
  }
}

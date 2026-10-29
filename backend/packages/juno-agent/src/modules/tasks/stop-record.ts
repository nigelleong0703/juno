/**
 * Who asked for a stop (BACKEND 6.5). A stop is a request that the run itself honours later, so the requester is written
 * on the row where the request is made; the task list reads it once the run is `stopped`. The first requester wins: an owner's
 * stop of a parent is not relabelled "system" when the platform then cascades it to the children.
 */
import { patchWhen, type StopActor, type Store } from '../../contracts/index.js';

const ENDED = new Set(['completed', 'failed', 'stopped', 'blocked']);

export async function recordRunStop(store: Store, runId: string, by: StopActor): Promise<void> {
  await patchWhen(store, 'runs', runId, (run) => !ENDED.has(run.status) && run.stoppedBy === undefined, { stoppedBy: by }).catch(() => undefined);
}

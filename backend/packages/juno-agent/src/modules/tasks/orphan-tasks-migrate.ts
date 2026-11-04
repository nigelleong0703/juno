/**
 * One-time settling of shell tasks that are still `running` in the registry although their process is gone (BACKEND 6.5).
 * Before every process was watched, a process started without notifyOnExit that exited (or whose computer was later replaced,
 * e.g. the backend moved from the local Docker computer to the server's) kept its row `running` forever, and the agent
 * page showed "Working…" for it. Each running shell row is read once on its computer: a finished process ends the row
 * as it finished, a handle the computer does not know ends it as failed with the orphan outcome. A computer that cannot be
 * reached leaves its rows alone (counted). A marker row makes later boots skip all of it. Pass the raw (unscoped) store.
 */
import type { Store } from '../../contracts/index.js';
import type { ComputerClient } from '../../ports/computer/index.js';
import { inOwnerScope } from '../../execution/execution-owner.js';
import { getRow, newRow, putRow } from '../home/mirror.js';
import { listAll } from '../memory/util.js';
import { isUnknownProcess, settleShellTask } from './background-registry.js';

export const MARKER = '__migrations/orphan-shell-tasks-v1';

export interface OrphanTasksMigration { skipped: boolean; settled: number; stillRunning: number; unreachable: number }

export async function migrateOrphanShellTasks(store: Store, computer: ComputerClient | undefined): Promise<OrphanTasksMigration> {
  if ((await getRow(store, 'system', MARKER)) !== null) return { skipped: true, settled: 0, stillRunning: 0, unreachable: 0 };
  const readProcess = computer?.readProcess?.bind(computer);
  // Without a computer client nothing can be proven either way: leave the rows, and let the next boot with one do it.
  if (readProcess === undefined) return { skipped: true, settled: 0, stillRunning: 0, unreachable: 0 };
  let settled = 0;
  let stillRunning = 0;
  let unreachable = 0;
  for (const task of await listAll(store, 'backgroundTasks')) {
    if (task.kind !== 'shell' || task.status !== 'running' || task.handle === undefined) continue;
    const handle = task.handle;
    const seen = await inOwnerScope(task.ownerId, async () => {
      try {
        const out = await readProcess(task.agentId, { handle, maxBytes: 4 }, AbortSignal.timeout(20_000), task.computer);
        return { state: out.state, exitCode: out.exitCode };
      } catch (error) {
        return isUnknownProcess(error) ? { state: 'expired' } : null;
      }
    });
    if (seen === null) { unreachable += 1; continue; }
    if (seen.state === 'running') { stillRunning += 1; continue; }
    await inOwnerScope(task.ownerId, () => settleShellTask(store, task.id, seen));
    settled += 1;
  }
  await putRow(store, newRow('system', MARKER, '', 'platform', new Date().toISOString()));
  return { skipped: false, settled, stillRunning, unreachable };
}

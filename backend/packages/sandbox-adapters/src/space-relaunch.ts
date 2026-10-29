/**
 * After a computer is created or cold-started (BACKEND §7.11) the apps its agents published are not running: processes live
 * in memory, the app folders are on durable storage. For every published Space the platform starts the app again as its agent
 * (the `start` recorded by `space_publish`) and registers it again (listener check, gateway route, firewall rule), the same
 * steps as the first publish. A Space that fails to come back stays "not listening" on its card; nothing else is affected.
 */
import { createLogger } from '@agent-desktop/log';
import type { SpaceRecord, Store } from '@agent-desktop/contracts';
import type { StartedContext } from './linked-provider.js';
import { shq } from './shq.js';
import { registerSpace } from './spaces.js';

const log = createLogger({ service: 'sandbox-spaces' });
/** The only start commands the platform runs for an app: the spaces skill's `start` / `dev` for a valid slug. */
const START = /^\/opt\/juno\/skills\/spaces\/spaces_tool\.py (start|dev) [a-z0-9][a-z0-9-]{0,40}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
const UP_WAIT_MS = 45_000;

export interface RelaunchDeps {
  /** The owner's own store. */
  store: Store;
  gatewayKey(computerId: string): string;
}

async function published(store: Store): Promise<SpaceRecord[]> {
  const rows: SpaceRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await store.list('spaces', { where: { status: 'published' }, limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    rows.push(...result.items);
    cursor = result.nextCursor;
    if (cursor === undefined) break;
  }
  return rows;
}

export async function relaunchSpaces(deps: RelaunchDeps, context: StartedContext): Promise<void> {
  for (const row of await published(deps.store)) {
    const start = row.start;
    if (start === undefined || !START.test(start) || !SLUG.test(row.slug)) {
      log.warn({ spaceId: row.id }, 'space has no valid start command; not relaunched');
      continue;
    }
    const registration = { agentId: row.agentId, spaceId: row.id, port: row.port, gatewayKey: deps.gatewayKey(context.binding.sandboxId) };
    try {
      // Already up (a resume that lost nothing): just make sure it is wired.
      if (await registerSpace(context.root, registration).then(() => true, () => false)) continue;
      const agent = await context.asAgent(row.agentId);
      const dir = `/workspace/spaces/${row.slug}`;
      await agent.run(`cd ${shq(dir)} && { setsid nohup ${start} >/tmp/space-${row.slug}.log 2>&1 </dev/null & }`, { timeoutMs: 20_000, signal: context.signal });
      const deadline = Date.now() + UP_WAIT_MS;
      for (;;) {
        try {
          await registerSpace(context.root, registration);
          break;
        } catch (error) {
          if (Date.now() > deadline || context.signal.aborted) throw error;
          await new Promise((done) => setTimeout(done, 1_000));
        }
      }
      log.info({ spaceId: row.id, slug: row.slug }, 'space relaunched');
    } catch (error) {
      log.warn({ err: error, spaceId: row.id }, 'space could not be relaunched');
    }
  }
}

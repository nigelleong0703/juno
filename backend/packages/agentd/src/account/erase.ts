/**
 * Deleting an account and everything of it (BACKEND §5.2c, M-PROD-2). One `DELETE /v1/account` signs the user out everywhere, then
 * a resumable job removes, in this order:
 *
 *  1. close      sessions, password row, device codes, reset tokens (the user can no longer sign in or call anything)
 *  2. stop       live runs of every conversation; every channel disconnected on its platform and its row removed (no wake can arrive)
 *  3. forget     the durable runner's rows for the owner's sessions, runs and timers
 *  4. blobs      uploaded / produced / screenshot bytes in the blob store, except bytes another account's rows still name
 *  5. agents     each agent with its chat, goals, calendar, feed, routines and home mirror, and `agent.deleted` for every open device
 *  6. conversations  what is left (groups, system chats) with `conversation.deleted`
 *  7. computer   computerd removes the computers, the durable storage (volumes / JuiceFS objects and metadata), state files, paired Mac
 *  8. rows       every remaining row of the owner in every collection, and the owner's event log (the delete events stay)
 *  9. forget again, then the user row and, last, the "deleting" marker
 *
 * The marker (`accountDeletions`, id = owner id) is written before step 2 and lists the steps already finished. Every step is safe to
 * run again, a failure is retried with a growing delay for as long as it takes, and a restart finishes whatever the marker still lists
 * (`resume`). Everything runs for one owner id given by the caller; nothing here reads an owner from a request body.
 */
import type { BlobStore, Collection, Doc, Enqueuer, EventBus, Store } from '@agent-desktop/contracts';
import { blobKeysUsedByOthers, closeAuthAccount, deleteAuthUser, deleteOwnerEvents, deleteOwnerRows, type DbStore } from '@agent-desktop/db';
import type { DurableDb, Runner } from '@agent-desktop/durable';
import { createLogger } from '@agent-desktop/log';
import type { ChannelRegistry } from '../channels/registry.js';
import type { ComputerdClient } from '../computerd.js';
import { runWithOwner } from '../owner-scope.js';
import { deleteAgentCascade } from '../routes/agents.js';
import { deleteConversationCascade, stopLiveRuns } from '../routes/conversation-delete.js';
import type { AgentdDeps } from '../routes/index.js';

const log = createLogger({ service: 'agentd' });

/** Events the owner's other open devices still have to read after the wipe (what to drop locally). */
const KEPT_EVENT_TYPES = ['agent.deleted', 'conversation.deleted'];
const COMPUTER_ERASE_BUDGET_MS = 10 * 60_000;

export interface AccountEraser {
  /**
   * Delete the account of `ownerId`: start (or join) the job and wait up to `waitMs` for it. `deleted` = everything is gone;
   * `deleting` = the sign-in is already closed and the job carries on in the background (and across restarts).
   */
  erase(ownerId: string, waitMs?: number): Promise<'deleted' | 'deleting'>;
  /** At boot: finish every deletion the marker table still lists. Returns how many were taken up. */
  resume(): Promise<number>;
  /** Stop retrying (shutdown); the marker is untouched, so the next boot resumes. */
  stop(): void;
}

export interface AccountEraserOptions {
  /** The raw store; the job scopes it to the one owner itself. */
  store: DbStore;
  /** Raw SQL for the bulk deletes (rows, events, sign-in rows, blob references). */
  raw: DurableDb;
  bus: EventBus;
  enqueuer: Enqueuer;
  config?: AgentdDeps['config'];
  computerd?: ComputerdClient;
  blobs: BlobStore;
  /** The chat platforms the loaded plugins registered, to disconnect the owner's channels on their side. */
  channels: ChannelRegistry;
  /** The durable runner, to forget the owner's session / run / timer rows; absent when there is none. */
  runner?: Runner;
  /** Delay before retry number `attempt`; tests shorten it. */
  retryDelayMs?: (attempt: number) => number;
}

/** Every row of one collection of a scoped store, page by page (the store only ever returns its owner's rows). */
async function* rowsOf<C extends Collection>(store: Store, collection: C): AsyncGenerator<Doc<C>> {
  let cursor: string | undefined;
  do {
    const page = await store.list(collection, { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    yield* page.items;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

/** Every `blobKey` string anywhere in a stored document (uploads, artifact files, transcript image blocks). */
export function collectBlobKeys(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > 12 || typeof value !== 'object' || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectBlobKeys(item, into, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'blobKey' && typeof item === 'string' && item.startsWith('blobs/')) into.add(item);
    else collectBlobKeys(item, into, depth + 1);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

export function createAccountEraser(options: AccountEraserOptions): AccountEraser {
  const { store, raw } = options;
  const jobs = new Map<string, Promise<void>>();
  let stopped = false;
  const retryDelay = options.retryDelayMs ?? ((attempt: number) => Math.min(10 * 60_000, 15_000 * 2 ** (attempt - 1)));

  const scoped = (ownerId: string): Store => {
    if (ownerId.trim() === '' || !store.forOwner) throw new Error('an owner id and an owner-scoped store are required');
    return store.forOwner(ownerId);
  };
  const depsFor = (ownerId: string): AgentdDeps => ({
    store: scoped(ownerId),
    bus: options.bus,
    enqueuer: options.enqueuer,
    channels: options.channels,
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.computerd === undefined ? {} : { computerd: options.computerd }),
  });

  async function begin(ownerId: string) {
    const owned = scoped(ownerId);
    const existing = await owned.get('accountDeletions', ownerId);
    if (existing) return existing;
    const agentIds: string[] = [];
    for await (const agent of rowsOf(owned, 'agents')) agentIds.push(agent.id);
    const now = new Date().toISOString();
    log.info({ owner: ownerId, agents: agentIds.length }, 'account deletion started');
    return owned.put('accountDeletions', { id: ownerId, ownerId, startedAt: now, updatedAt: now, agentIds, done: [], attempts: 0 });
  }

  /** Step 1; also run before the request answers, so a user who got an answer can no longer sign in. */
  async function close(ownerId: string): Promise<void> {
    const closed = await closeAuthAccount(raw, ownerId);
    log.info({ owner: ownerId, ...closed }, 'account deletion: sign-in closed');
  }

  const steps: Array<{ name: string; run(ownerId: string, deps: AgentdDeps): Promise<Record<string, unknown>> }> = [
    {
      name: 'stop',
      async run(ownerId, deps) {
        let conversations = 0;
        for await (const conversation of rowsOf(deps.store, 'conversations')) {
          const stopped = await stopLiveRuns(deps, conversation.id);
          if (!stopped.ok) throw new Error(`${stopped.code}: ${stopped.message}`);
          conversations += 1;
        }
        let channels = 0;
        for await (const row of rowsOf(deps.store, 'channels')) {
          // A platform whose plugin is off cannot clean up on its side; the row still goes.
          await deps.channels.get(row.kind)?.connector.disconnect(deps, row);
          await deps.store.delete('channels', row.id);
          channels += 1;
        }
        return { conversations, channels };
      },
    },
    {
      name: 'forget',
      async run(ownerId, deps) {
        if (options.runner === undefined) return { skipped: 'no durable runner' };
        const marker = await deps.store.get('accountDeletions', ownerId);
        const exact = new Set<string>([ownerId]);
        for await (const run of rowsOf(deps.store, 'runs')) exact.add(run.id);
        for await (const routine of rowsOf(deps.store, 'routines')) exact.add(routine.id);
        for await (const item of rowsOf(deps.store, 'agentCalendar')) exact.add(item.id);
        for await (const task of rowsOf(deps.store, 'backgroundTasks')) exact.add(task.id);
        const prefixes = new Set<string>((marker?.agentIds ?? []).map((id) => `${id}:`));
        for await (const agent of rowsOf(deps.store, 'agents')) prefixes.add(`${agent.id}:`);
        return { invocations: await options.runner.forget({ exact: [...exact], prefixes: [...prefixes] }) };
      },
    },
    {
      name: 'blobs',
      async run(ownerId, deps) {
        const keys = new Set<string>();
        for (const collection of ['library', 'artifactFiles', 'documentDrafts', 'transcripts'] as const) {
          for await (const row of rowsOf(deps.store, collection)) collectBlobKeys(row, keys);
        }
        const sharedWithOthers = await blobKeysUsedByOthers(raw, ownerId, [...keys]);
        let deleted = 0;
        for (const key of keys) {
          if (sharedWithOthers.has(key)) continue;
          await options.blobs.delete(key);
          deleted += 1;
        }
        return { found: keys.size, deleted, keptBecauseShared: sharedWithOthers.size };
      },
    },
    {
      name: 'agents',
      async run(ownerId, deps) {
        const ids: string[] = [];
        for await (const agent of rowsOf(deps.store, 'agents')) ids.push(agent.id);
        for (const id of ids) {
          const deleted = await deleteAgentCascade(deps, ownerId, id);
          if (!deleted.ok && deleted.status !== 404) throw new Error(`${deleted.code}: ${deleted.message}`);
        }
        return { agents: ids.length };
      },
    },
    {
      name: 'conversations',
      async run(ownerId, deps) {
        const ids: string[] = [];
        for await (const conversation of rowsOf(deps.store, 'conversations')) ids.push(conversation.id);
        for (const id of ids) {
          const deleted = await deleteConversationCascade(deps, ownerId, id);
          if (!deleted.ok && deleted.status !== 404) throw new Error(`${deleted.code}: ${deleted.message}`);
        }
        return { conversations: ids.length };
      },
    },
    {
      name: 'computer',
      async run() {
        if (options.computerd?.eraseOwner === undefined) return { skipped: 'no computerd' };
        return { ...(await options.computerd.eraseOwner(AbortSignal.timeout(COMPUTER_ERASE_BUDGET_MS))) };
      },
    },
    {
      name: 'rows',
      async run(ownerId) {
        const tables = await deleteOwnerRows(raw, ownerId);
        const events = await deleteOwnerEvents(raw, ownerId, KEPT_EVENT_TYPES);
        return { rows: Object.values(tables).reduce((sum, n) => sum + n, 0), tables, events };
      },
    },
    {
      // Stopping and deleting can leave fresh durable rows behind (a released session, a cancelled run); the agents are gone, so only prefixes and the owner key remain.
      name: 'forget-again',
      async run(ownerId, deps) {
        if (options.runner === undefined) return { skipped: 'no durable runner' };
        const marker = await deps.store.get('accountDeletions', ownerId);
        return { invocations: await options.runner.forget({ exact: [ownerId], prefixes: (marker?.agentIds ?? []).map((id) => `${id}:`) }) };
      },
    },
  ];

  /** One pass over the steps the marker has not listed yet, then the user row and the marker. Throws on the first failure. */
  async function pass(ownerId: string): Promise<boolean> {
    const deps = depsFor(ownerId);
    let marker = await deps.store.get('accountDeletions', ownerId);
    if (!marker) return false;
    for (const step of steps) {
      if (marker.done.includes(step.name)) continue;
      const result = await runWithOwner(ownerId, () => step.run(ownerId, deps));
      log.info({ owner: ownerId, step: step.name, ...result }, 'account deletion: step done');
      marker = await deps.store.patch('accountDeletions', ownerId, { done: [...marker.done, step.name], updatedAt: new Date().toISOString() });
    }
    const userRemoved = await deleteAuthUser(raw, ownerId);
    await deps.store.delete('accountDeletions', ownerId);
    log.info({ owner: ownerId, userRemoved }, 'account deleted');
    return true;
  }

  /** Run passes until one succeeds; a failed pass is noted on the marker and retried after a growing delay. */
  async function drive(ownerId: string): Promise<void> {
    for (let attempt = 1; !stopped; attempt += 1) {
      try {
        await pass(ownerId);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn({ owner: ownerId, attempt, err: error }, 'account deletion step failed; will retry');
        await scoped(ownerId).patch('accountDeletions', ownerId, { attempts: attempt, lastError: message.slice(0, 500), updatedAt: new Date().toISOString() }).catch(() => undefined);
        await sleep(retryDelay(attempt));
      }
    }
  }

  function start(ownerId: string): Promise<void> {
    const running = jobs.get(ownerId);
    if (running) return running;
    const job = drive(ownerId).finally(() => jobs.delete(ownerId));
    jobs.set(ownerId, job);
    return job;
  }

  return {
    async erase(ownerId, waitMs = 6_000) {
      await begin(ownerId);
      await close(ownerId);
      const job = start(ownerId).then(() => 'deleted' as const);
      return Promise.race([job, sleep(waitMs).then(() => 'deleting' as const)]);
    },

    async resume() {
      let taken = 0;
      for await (const marker of rowsOf(store, 'accountDeletions')) {
        const ownerId = marker.ownerId ?? marker.id;
        log.warn({ owner: ownerId, done: marker.done }, 'finishing an interrupted account deletion');
        await close(ownerId).catch((error: unknown) => log.warn({ owner: ownerId, err: error }, 'could not close the sign-in yet; the job will retry'));
        void start(ownerId);
        taken += 1;
      }
      return taken;
    },

    stop() {
      stopped = true;
    },
  };
}

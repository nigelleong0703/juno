/**
 * computerd's allocation core: the durable binding (single-flight, so two first-use requests never
 * create two VMs) and the per-agent display lease (serialized, so a double-click never boots two
 * Xvfb on one display). It owns the pool so the facade only deals with the public operations.
 */
import type { Store, ScreenDoc, E2bBinding } from '@agent-desktop/contracts';
import { screenPorts } from '@agent-desktop/contracts';
import { isTimeZone, settingsIdFor } from '@agent-desktop/public-contracts';
import type { ComputerProvider, ComputerHostSpec, PoolEntry, ScreenPool } from '@agent-desktop/sandbox-adapters';
import { createKeyedMutex, noScreen, notAllowed } from '@agent-desktop/sandbox-adapters';
import type { ComputerStateStore } from '../../infrastructure/computer-state.js';

export interface AllocatorOptions {
  store: Store;
  provider: ComputerProvider;
  pool: ScreenPool;
  state: ComputerStateStore;
  ownerId: string;
  host: ComputerHostSpec;
  secretsFor(computerId: string, agentId: string): { controlPassword: string; viewPassword: string };
  onPoolChange?: () => void;
}

export interface Allocator {
  ensureBinding(signal: AbortSignal): Promise<E2bBinding>;
  readScreen(agentId: string): Promise<ScreenDoc | null>;
  /**
   * Describe what already exists for an agent without creating anything. The agent row is
   * still verified (a foreign or unknown id is refused), but no binding, screen or lease is
   * claimed. Nulls are a truthful nothing-there, never an allocation.
   */
  readAssigned(agentId: string): Promise<{ binding: E2bBinding | null; screen: ScreenDoc | null }>;
  /** Resolve an agent's screen, allocating (and starting its display) on first use. */
  resolve(agentId: string, signal: AbortSignal): Promise<{ binding: E2bBinding; screen: ScreenDoc }>;
}

const screenId = (computerId: string, agentId: string) => `scr-${computerId}-${agentId}`;

export function createAllocator(opts: AllocatorOptions): Allocator {
  const { store, provider, pool, state, ownerId, host } = opts;
  const notify = opts.onPoolChange ?? (() => undefined);
  const mutex = createKeyedMutex();

  async function readScreen(agentId: string): Promise<ScreenDoc | null> {
    await assertAgent(agentId);
    return findScreen(agentId);
  }

  /**
   * The agent's screen row under the active binding, WITHOUT the agent check. Only for internal
   * bookkeeping about another holder of the pool (an evicted or deleted agent): asserting that
   * agent would fail the caller's own action with "unknown agent <someone else>".
   */
  async function findScreen(agentId: string): Promise<ScreenDoc | null> {
    const binding = state.get();
    // A passive read never allocates: without an active binding there is truthfully no screen.
    // The agent id alone is not a lookup key — one agent id spans every provider binding kept in
    // this store (retired remote rows stay for switchback), so the active sandbox scopes every
    // lookup. Pages are walked so a retired row can never crowd the live one out of one page.
    if (!binding) return null;
    let cursor: string | undefined;
    for (;;) {
      const page = await store.list('screens', {
        where: { agentId },
        limit: 20,
        ...(cursor ? { cursor } : {}),
      });
      const match = page.items.find(
        (screen) =>
          screen.ownerId === ownerId &&
          screen.agentId === agentId &&
          screen.computerId === binding.sandboxId,
      );
      if (match) return match;
      if (!page.nextCursor) return null;
      cursor = page.nextCursor;
    }
  }

  /**
   * A screen may only ever be created for a real agent of this deployment. This is the identity
   * check that stops an arbitrary \`x-agent-id\` from conjuring a display; a genuine agent's first
   * screen action is allowed to boot its display on demand (there is no separate "open the UI
   * first" step for a fresh agent).
   */
  async function assertAgent(agentId: string): Promise<void> {
    const agent = await store.get('agents', agentId);
    if (!agent) throw notAllowed(`unknown agent ${agentId}`);
    // Single-user v1 keeps one owner, but a row that names a different creator must never get a
    // screen here (defense in depth for the multi-tenant path).
    const createdBy = agent.createdBy;
    if (createdBy !== undefined && createdBy !== opts.ownerId) {
      throw notAllowed(`agent ${agentId} belongs to another owner`);
    }
  }

  function ensureBinding(signal: AbortSignal): Promise<E2bBinding> {
    return mutex.run('computer', async () => {
      const existing = state.get();
      // A stored binding is returned WITHOUT connecting: the computer view is a passive read, and
      // connecting would resume a paused sandbox and renew its idle timeout, so polling would keep
      // the VM awake forever. Active operations reach the sandbox themselves through `ensureScreen`.
      if (existing) return existing;
      const created = await provider.create(host, signal);
      state.set(created);
      return created;
    });
  }

  async function stopEvicted(entry: PoolEntry, binding: E2bBinding): Promise<void> {
    await provider.stopScreen(binding, entry.displayNo, new AbortController().signal).catch(() => undefined);
    // The evicted holder may be an agent that was deleted since; its row is looked up, never asserted.
    const existing = await findScreen(entry.agentId).catch(() => null);
    if (existing) await store.patch('screens', existing.id, { state: 'stopped' }).catch(() => undefined);
  }

  /**
   * Free the displays of agents that no longer exist before a new agent takes a display, so a
   * deleted agent never costs a live agent its display (and its row is dropped, not stopped).
   */
  async function pruneDeleted(binding: E2bBinding): Promise<void> {
    let changed = false;
    for (const entry of pool.entries()) {
      if (await store.get('agents', entry.agentId)) continue;
      pool.release(entry.agentId);
      changed = true;
      await provider.stopScreen(binding, entry.displayNo, new AbortController().signal).catch(() => undefined);
      const row = await findScreen(entry.agentId).catch(() => null);
      if (row) await store.delete('screens', row.id).catch(() => undefined);
    }
    if (changed) notify();
  }

  async function allocate(agentId: string, signal: AbortSignal): Promise<ScreenDoc> {
    await assertAgent(agentId);
    const binding = await ensureBinding(signal);
    if (!pool.entries().some((entry) => entry.agentId === agentId)) await pruneDeleted(binding);
    const lease = pool.lease(agentId);
    // Persist only when the display map actually changed; a plain touch must not write on every action.
    if (lease.created || lease.evicted) notify();
    if (lease.evicted) await stopEvicted(lease.evicted, binding);

    // The screen runs in the owner's reported timezone (settings.general.timezone, set by their
    // device); COMPUTER_TIMEZONE is only the fallback until a client has reported one.
    const timezone = (await ownerTimeZone(store, ownerId)) ?? host.timezone;
    const handle = await provider.ensureScreen(
      binding,
      {
        agentId, displayNo: lease.displayNo, resolution: host.resolution,
        ...(timezone === undefined ? {} : { timezone }),
        ...opts.secretsFor(binding.sandboxId, agentId),
      },
      signal,
    );

    const existing = await findScreen(agentId);
    const ports = screenPorts(handle.displayNo);
    const doc: ScreenDoc = {
      id: existing?.id ?? screenId(binding.sandboxId, agentId),
      ownerId,
      computerId: binding.sandboxId,
      agentId,
      displayNo: handle.displayNo,
      state: handle.state,
      title: existing?.title ?? `${agentId} screen`,
      resolution: host.resolution,
      lastUsedAt: new Date().toISOString(),
      lastVncPort: ports.vnc,
      lastWebPort: ports.web,
      ...(existing?.screenshotRef ? { screenshotRef: existing.screenshotRef } : {}),
    };
    // The agent id is the lookup key for every later action, so it must be indexed (Postgres keeps
    // only the derived columns; the memory store keeps what it is given).
    return store.put('screens', doc, { agentId, status: doc.state });
  }

  return {
    ensureBinding,
    readScreen,
    async readAssigned(agentId) {
      await assertAgent(agentId);
      const binding = state.get();
      if (!binding) return { binding: null, screen: null };
      return { binding, screen: await readScreen(agentId) };
    },
    // Always re-run the ensure path, even for an agent that already has a screen row. After a
    // restart or a pause the provider's in-process screen set is empty, so skipping ensure would
    // leave every later action with \`no_screen\`. \`allocate\` re-leases the same display and
    // re-starts only what is missing, so this is cheap when the display is already up.
    async resolve(agentId, signal) {
      return mutex.run(`screen:${agentId}`, async () => {
        await assertAgent(agentId);
        const binding = await ensureBinding(signal);
        return { binding, screen: await allocate(agentId, signal) };
      });
    },
  };
}

export { noScreen };

/** The owner's reported IANA timezone, or undefined when unset, invalid, or unreadable. */
async function ownerTimeZone(store: Store, ownerId: string): Promise<string | undefined> {
  const row: unknown = await store.get('settings', settingsIdFor(ownerId)).catch(() => undefined);
  const general = typeof row === 'object' && row !== null ? Reflect.get(row, 'general') : undefined;
  const value = typeof general === 'object' && general !== null ? Reflect.get(general, 'timezone') : undefined;
  return typeof value === 'string' && isTimeZone(value) ? value : undefined;
}

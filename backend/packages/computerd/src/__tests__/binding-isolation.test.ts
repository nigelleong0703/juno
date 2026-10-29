/**
 * Provider binding isolation: one agent id spans a remote and a local binding in the same store,
 * and each binding must keep its own screen id, controller and listing. Switching providers never
 * overwrites, leaks or remaps the other binding's rows; a restart looks the same rows up again.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { agentSchema } from '@agent-desktop/public-contracts';
import { createFakeProvider, createScreenPool } from '@agent-desktop/sandbox-adapters';
import { createLifecycle, type Lifecycle } from '../modules/computers/lifecycle.js';
import { createComputerStateStore } from '../infrastructure/computer-state.js';

const owner = 'qa-binding';
const at = '2026-01-01T00:00:00.000Z';

function agentDoc() {
  return agentSchema.parse({
    id: 'agent-a',
    name: 'QA',
    handle: 'qa',
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'QA',
    status: 'idle',
    section: 'Personal',
    pinned: false,
    lastActivity: '',
    unreadCount: 0,
    model: {
      planner: { provider: 'test', model: 'test' },
      computer: { provider: 'test', model: 'test' },
      fast: { provider: 'test', model: 'test' },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdBy: owner,
    createdAt: at,
    updatedAt: at,
  });
}

const host = {
  template: 'test',
  resolution: '1280x800',
  timeoutMs: 1000,
  ramGb: 2,
  vcpu: 2,
  idlePauseMinutes: 30,
};

async function setup() {
  const scoped = createMemoryStore().forOwner?.(owner);
  if (!scoped) throw new Error('scoped store required');
  await scoped.put('agents', agentDoc());
  // A fresh pool/state over the same rows models a computerd restart with the same binding file.
  const lifecycle = (sandboxId: string): Lifecycle =>
    createLifecycle({
      store: scoped,
      provider: createFakeProvider({ sandboxId }),
      pool: createScreenPool(4),
      state: createComputerStateStore('', { sandboxId, template: 'test' }),
      ownerId: owner,
      host: { ...host },
      secret: 'qa',
    });
  return { store: scoped, lifecycle };
}

describe('provider binding isolation', () => {
  it('keeps separate screen ids, controllers and listings per active sandbox', async () => {
    const { store, lifecycle } = await setup();
    const remote = lifecycle('remote-vm');
    const local = lifecycle('local-vm');
    const signal = new AbortController().signal;

    const first = await remote.ensureScreen('agent-a', signal);
    await remote.takeOver('agent-a', { via: 'api' });
    const second = await local.ensureScreen('agent-a', signal);

    // A local allocation is a new deterministic id; it never overwrites the remote row.
    expect(second.id).not.toBe(first.id);
    expect(second.computerId).toBe('local-vm');
    const preserved = await store.get('screens', first.id);
    expect(preserved?.computerId).toBe('remote-vm');
    // Who holds a screen is its control row, not the screen row.
    expect(preserved).not.toHaveProperty('controller');
    expect((await store.get('controls', `screen:${first.id}`))?.holder).toBe('user');

    expect((await remote.getScreen('agent-a'))?.controller).toBe('user');
    expect((await local.getScreen('agent-a'))?.controller).toBe('agent');

    const remoteList = await remote.listScreens();
    const localList = await local.listScreens();
    expect(remoteList).toHaveLength(1);
    expect(localList).toHaveLength(1);
    expect(remoteList[0]?.id).toBe(first.id);
    expect(localList[0]?.id).toBe(second.id);

    // A screen id only resolves under its own binding: cross-binding ticket lookups are rejected
    // while the rows themselves stay stored for switchback.
    expect(await local.findById(first.id)).toBeNull();
    expect(await remote.findById(second.id)).toBeNull();
    expect((await remote.findById(first.id))?.id).toBe(first.id);
    expect((await local.findById(second.id))?.id).toBe(second.id);

    // After a restart (fresh pools, same binding seeds) each side looks up its own row again.
    const revivedRemote = lifecycle('remote-vm');
    const revivedLocal = lifecycle('local-vm');
    expect((await revivedRemote.getScreen('agent-a'))?.id).toBe(first.id);
    expect((await revivedLocal.getScreen('agent-a'))?.id).toBe(second.id);
    expect((await revivedRemote.listScreens())).toHaveLength(1);
    expect((await revivedLocal.listScreens())).toHaveLength(1);
  });

  it('reads nothing without a binding and never allocates on a passive read', async () => {
    const scoped = createMemoryStore().forOwner?.(owner);
    if (!scoped) throw new Error('scoped store required');
    await scoped.put('agents', agentDoc());
    const unbound = createLifecycle({
      store: scoped,
      provider: createFakeProvider({ sandboxId: 'never-used' }),
      pool: createScreenPool(4),
      state: createComputerStateStore('', null),
      ownerId: owner,
      host: { ...host },
      secret: 'qa',
    });
    expect(await unbound.getScreen('agent-a')).toBeNull();
    expect(await unbound.listScreens()).toEqual([]);
    expect((await scoped.list('screens', {})).items).toHaveLength(0);
    // Even a stored row from a retired binding never resolves without an active binding.
    await scoped.put(
      'screens',
      {
        id: 'scr-remote-vm-agent-a',
        ownerId: owner,
        computerId: 'remote-vm',
        agentId: 'agent-a',
        displayNo: 1,
        state: 'live',
        title: 'agent-a screen',
        resolution: '1280x800',
        lastUsedAt: at,
        lastVncPort: 5901,
        lastWebPort: 6081,
      },
      { agentId: 'agent-a', status: 'live' },
    );
    expect(await unbound.findById('scr-remote-vm-agent-a')).toBeNull();
  });
});

/**
 * Recovery across a pause/restart. The provider forgets its running displays when the process
 * restarts or the sandbox pauses, so \`resolve\` must re-run \`ensureScreen\` for an agent that already
 * has a screen row — otherwise every later action fails with \`no_screen\`.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { createFakeProvider, createScreenPool, MAX_LIVE_SCREENS, type PoolEntry } from '@agent-desktop/sandbox-adapters';
import type { Agent } from '@agent-desktop/public-contracts';
import { createLifecycle } from '../modules/computers/lifecycle.js';
import { createComputerStateStore } from '../infrastructure/computer-state.js';

function agent(id: string): Agent {
  return {
    id,
    name: id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'tester',
    status: 'idle',
    section: 'Work',
    pinned: false,
    lastActivity: '',
    unreadCount: 0,
    model: {
      planner: { provider: 'scripted', model: 'x' },
      computer: { provider: 'scripted', model: 'x' },
      fast: { provider: 'scripted', model: 'x' },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function build(seed: PoolEntry[] = []) {
  const store = createMemoryStore();
  await store.put('agents', agent('agent-a'));
  const provider = createFakeProvider();
  const pool = createScreenPool(MAX_LIVE_SCREENS, seed);
  const lifecycle = createLifecycle({
    store,
    provider,
    pool,
    state: createComputerStateStore('', { sandboxId: 'sbx-1', template: 'desktop-debian' }),
    ownerId: 'owner-1',
    host: { template: 'desktop-debian', resolution: '1280x800', timeoutMs: 1000, ramGb: 2, vcpu: 2, idlePauseMinutes: 30 },
    secret: 's',
  });
  return { lifecycle, provider, pool, store };
}

describe('screen recovery', () => {
  it('re-boots an existing agent display after the provider forgets it (pause/restart)', async () => {
    const { lifecycle, provider } = await build();
    const signal = new AbortController().signal;
    await lifecycle.requireAgentControl('agent-a', signal);
    expect(provider.screens.size).toBe(1);

    // A pause (or process restart) drops the provider's running displays but keeps the screen row.
    provider.screens.clear();
    const resolved = await lifecycle.requireAgentControl('agent-a', signal);
    expect(provider.screens.size).toBe(1);
    expect(resolved.screen.displayNo).toBe(1);

    const shot = await provider.act({ sandboxId: 'sbx-1', template: 't' }, 'agent-a', resolved.screen.displayNo, { kind: 'screenshot' }, signal);
    expect(shot.screenshot?.displayNo).toBe(1);
  });

  // Live regression: the owner's pool still held four deleted agents, so a new agent's first action
  // evicted one and then asserted THAT agent, failing with "unknown agent agt-1791343612733".
  it("a new agent's first action is not failed by deleted agents still holding displays", async () => {
    const stale = ['agt-1791343612733', 'agt-1791344789882', 'agt-1791352716768', 'agt-gone'];
    const seed = stale.map((agentId, i) => ({ displayNo: i + 1, agentId, lastUsedAt: i }));
    const { lifecycle, provider, pool, store } = await build(seed);
    await store.put('screens', {
      id: 'scr-sbx-1-agt-1791343612733', ownerId: 'owner-1', computerId: 'sbx-1', agentId: 'agt-1791343612733',
      displayNo: 1, state: 'live', title: 'old', resolution: '1280x800', lastUsedAt: '', lastVncPort: 5901, lastWebPort: 6081,
    }, { agentId: 'agt-1791343612733', status: 'live' });

    const resolved = await lifecycle.requireAgentControl('agent-a', new AbortController().signal);
    expect(resolved.screen.agentId).toBe('agent-a');
    expect(pool.entries().map((entry) => entry.agentId)).toEqual(['agent-a']);
    expect(provider.screens.size).toBe(1);
    expect(await store.get('screens', 'scr-sbx-1-agt-1791343612733')).toBeNull();
  });
});

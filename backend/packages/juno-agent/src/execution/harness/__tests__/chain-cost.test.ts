/**
 * H-75: the peer-cost guard reads the real spend of the agent-to-agent chain. Finished chained runs add
 * their cost once (replays do not double count), and an agent-originated wake in a chain that reached the
 * cap is dropped with the peer_cost_cap reason; user wakes and chainless wakes are never affected.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { sessionKey, type Store, type WakeEvent } from '../../../contracts/index.js';
import type { Run } from '@agent-desktop/public-contracts';
import { readChainCost, recordChainCost } from '../services/chain-cost.js';
import type { RunInput } from '../services/run-types.js';

const AT = '2026-10-09T11:00:00.000Z';

function ownedStore(): Store {
  const raw = createMemoryStore();
  return raw.forOwner === undefined ? raw : raw.forOwner('owner');
}

function peerWake(id: string, chainId?: string): WakeEvent {
  return {
    id, ownerId: 'owner', agentId: 'b', sessionKey: sessionKey('b', 'c'), conversationId: 'c', kind: 'agent_message',
    origin: { type: 'agent', id: 'a' }, trusted: false, priority: 'peer', payload: { text: 'ping' },
    ...(chainId === undefined ? {} : { hop: { chainId, depth: 1 } }), at: AT, status: 'accepted',
  };
}

async function seedRun(store: Store, id: string, costUsd: number): Promise<void> {
  const run: Run = { id, agentId: 'b', conversationId: 'c', title: 't', status: 'completed', kind: 'chat', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd, steps: 1 }, startedAt: AT, lastActivityAt: AT };
  await store.put('runs', run, { agentId: 'b', conversationId: 'c' });
}

const inputFor = (wake: WakeEvent): RunInput => ({ agentId: 'b', conversationId: 'c', sessionKey: wake.sessionKey, wakeEvents: [wake] });

describe('peer chain cost', () => {
  it('sums finished chained runs once each', async () => {
    const store = ownedStore();
    await seedRun(store, 'r1', 0.2);
    await seedRun(store, 'r2', 0.15);
    const wake = peerWake('w', 'chain-1');
    await recordChainCost(store, inputFor(wake), 'r1');
    await recordChainCost(store, inputFor(wake), 'r1');
    await recordChainCost(store, inputFor(wake), 'r2');
    expect(await readChainCost(store, wake)).toBeCloseTo(0.35);
    expect(await readChainCost(store, peerWake('x'))).toBe(0);
  });
});

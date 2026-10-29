import { describe, it, expect } from 'vitest';
import { checkHop, checkPeerCost, checkRate } from './guards.js';
import { LIMITS, type WakeEvent } from '../../../contracts/index.js';

function wake(overrides: Partial<WakeEvent> = {}): WakeEvent {
  return {
    id: 'w1', ownerId: 'u1', agentId: 'a1', sessionKey: 'key', conversationId: 'c1', kind: 'agent_message',
    origin: { type: 'agent' }, trusted: false, priority: 'peer', payload: {}, at: new Date().toISOString(),
    status: 'accepted', hop: { chainId: 'chain_1', depth: 1 }, ...overrides,
  };
}

describe('session guards', () => {
  it('drops a wake past the chain hop depth', () => {
    expect(checkHop(wake({ hop: { chainId: 'c', depth: LIMITS.chain.maxHopDepth } })).kind).toBe('ok');
    const dropped = checkHop(wake({ hop: { chainId: 'c', depth: LIMITS.chain.maxHopDepth + 1 } }));
    expect(dropped.kind === 'drop' ? dropped.reason : '').toBe('hop_limit');
  });

  it('drops agent-originated wakes once the chain spend reaches its budget', () => {
    expect(checkPeerCost(wake(), LIMITS.chain.maxCostUsd - 0.01).kind).toBe('ok');
    expect(checkPeerCost(wake(), LIMITS.chain.maxCostUsd).kind).toBe('drop');
    expect(checkPeerCost(wake({ origin: { type: 'user' }, kind: 'user_message' }), 99).kind).toBe('ok');
  });

  it('defers non-user starts past the per-minute rate and never limits the user', () => {
    const now = 1_000_000;
    const full = Array.from({ length: LIMITS.session.maxAutoStartsPerMinute }, (_, i) => now - 50_000 + i);
    const webhook = wake({ kind: 'webhook', origin: { type: 'automation' }, priority: 'background' });
    expect(checkRate(webhook, { now, recentStarts: full.slice(1) }).kind).toBe('ok');
    expect(checkRate(webhook, { now, recentStarts: full })).toEqual({ kind: 'defer', untilMs: now - 50_000 + 60_000, reason: 'flood_cap' });
    expect(checkRate(wake({ origin: { type: 'user' }, priority: 'user', kind: 'user_message' }), { now, recentStarts: full }).kind).toBe('ok');
  });
});

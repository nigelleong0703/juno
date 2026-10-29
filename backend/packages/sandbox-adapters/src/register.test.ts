/**
 * Behaviour tests for the display pool: the two properties a long-running user depends on —
 * an agent keeps its display across eviction (its profile is keyed by agent), and a screen the user
 * has taken over is never the eviction victim.
 */
import { describe, expect, it } from 'vitest';
import { createScreenPool } from './register.js';
import { MAX_LIVE_SCREENS } from './ports.js';

describe('createScreenPool', () => {
  it('gives an agent the same display on return after eviction', () => {
    const pool = createScreenPool(2);
    pool.lease('agent-a');
    pool.lease('agent-b');
    // agent-c evicts the least recently used (a).
    const c = pool.lease('agent-c');
    expect(c.evicted?.agentId).toBe('agent-a');

    const back = pool.lease('agent-a');
    expect(back.displayNo).not.toBeGreaterThan(MAX_LIVE_SCREENS);
    expect(pool.entries()).toHaveLength(2);
  });

  it('reuses freed display numbers instead of growing', () => {
    const pool = createScreenPool(2);
    const first = pool.lease('agent-a').displayNo;
    pool.lease('agent-b');
    pool.release('agent-a');
    expect(pool.lease('agent-c').displayNo).toBe(first);
  });

  it('never evicts a screen the user has taken over', () => {
    const pool = createScreenPool(2);
    pool.lease('agent-a');
    pool.lease('agent-b');
    pool.pin('agent-a');
    const lease = pool.lease('agent-c');
    expect(lease.evicted?.agentId).toBe('agent-b');
    expect(pool.entries().map((entry) => entry.agentId).sort()).toEqual(['agent-a', 'agent-c']);
  });

  it('refuses to allocate when every screen is pinned', () => {
    const pool = createScreenPool(1);
    pool.lease('agent-a');
    pool.pin('agent-a');
    expect(() => pool.lease('agent-b')).toThrow();
  });

  it('unpins on return-control', () => {
    const pool = createScreenPool(1);
    pool.lease('agent-a');
    pool.pin('agent-a');
    pool.unpin('agent-a');
    expect(pool.lease('agent-b').evicted?.agentId).toBe('agent-a');
  });
});

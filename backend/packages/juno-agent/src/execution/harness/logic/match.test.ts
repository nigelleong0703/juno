import { describe, it, expect } from 'vitest';
import { matchesFilter, matchSubscriptions, type ExternalEvent } from './match.js';
import type { Subscription } from '../../../contracts/index.js';

describe('webhook matching', () => {
  it('matches exact string filters', () => {
    const filter = { source: 'github', type: 'pr.merged' };
    const event: ExternalEvent = { id: 'e1', source: 'github', type: 'pr.merged' };
    expect(matchesFilter(filter, event)).toBe(true);
  });

  it('ignores case in strings', () => {
    const filter = { source: 'GitHub' };
    const event: ExternalEvent = { id: 'e1', source: 'github', type: 'pr.merged' };
    expect(matchesFilter(filter, event)).toBe(true);
  });

  it('matches array filters (any-of)', () => {
    const filter = { type: ['pr.merged', 'pr.opened'] };
    const event: ExternalEvent = { id: 'e1', source: 'github', type: 'pr.merged' };
    expect(matchesFilter(filter, event)).toBe(true);
  });

  it('checks presence with *', () => {
    const filter = { repo: '*' };
    const event: ExternalEvent = { id: 'e1', source: 'github', type: 'pr.merged', repo: 'myrepo' };
    expect(matchesFilter(filter, event)).toBe(true);

    const empty: ExternalEvent = { id: 'e1', source: 'github', type: 'pr.merged' };
    expect(matchesFilter(filter, empty)).toBe(false);
  });

  it('matches subscriptions and filters expired', () => {
    const now = Date.now();
    const subs: Subscription[] = [
      {
        id: 's1',
        agentId: 'a1',
        conversationId: 'c1',
        filter: { source: 'github', type: 'pr.merged' },
        expiresAt: new Date(now + 60000).toISOString(),
        createdAt: new Date().toISOString(),
      },
      {
        id: 's2',
        agentId: 'a2',
        conversationId: 'c2',
        filter: { source: 'github', type: 'push' },
        expiresAt: new Date(now - 60000).toISOString(),
        createdAt: new Date().toISOString(),
      },
    ];

    const event: ExternalEvent = { id: 'e1', source: 'github', type: 'pr.merged' };
    const matched = matchSubscriptions(subs, event, now);
    expect(matched.length).toBe(1);
    expect(matched[0]!.id).toBe('s1');
  });
});

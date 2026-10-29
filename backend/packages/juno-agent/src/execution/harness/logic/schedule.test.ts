import { describe, it, expect } from 'vitest';
import { nextRunAt, missedRuns } from './schedule.js';
import type { RoutineTrigger } from '@agent-desktop/public-contracts';

describe('routine scheduling', () => {
  it('returns null for invalid cron', () => {
    const trigger: RoutineTrigger = { kind: 'schedule', cron: 'invalid', tz: 'UTC', human: 'bad' };
    const now = new Date();
    const next = nextRunAt(trigger, now);
    expect(next).toBeNull();
  });

  it('finds missed runs in window', () => {
    const trigger: RoutineTrigger = { kind: 'schedule', cron: '0 9 * * *', tz: 'UTC', human: '9am daily' };
    const from = new Date('2026-10-01T08:00:00Z');
    const to = new Date('2026-10-05T10:00:00Z');
    const missed = missedRuns(trigger, from, to);
    expect(missed.length).toBeGreaterThan(0);
  });
});

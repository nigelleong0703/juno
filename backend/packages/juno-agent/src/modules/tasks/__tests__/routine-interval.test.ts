/** H-89: a routine schedule must not fire more often than the minimum interval (default 5 minutes). */
import { describe, expect, it } from 'vitest';
import { routineIntervalRefusal } from '../routines/interval.js';

const schedule = (cron: string) => ({ kind: 'schedule' as const, cron, human: cron, tz: 'UTC' });

describe('routine minimum interval', () => {
  it('refuses a schedule that fires every few seconds or every minute', () => {
    expect(routineIntervalRefusal(schedule('*/5 * * * * *'), 5 * 60_000)).toMatch(/at most once every 5 minutes/);
    expect(routineIntervalRefusal(schedule('* * * * *'), 5 * 60_000)).toBeDefined();
  });
  it('accepts hourly and daily schedules, and non-schedule triggers', () => {
    expect(routineIntervalRefusal(schedule('0 * * * *'), 5 * 60_000)).toBeUndefined();
    expect(routineIntervalRefusal(schedule('0 9 * * 1-5'), 5 * 60_000)).toBeUndefined();
    expect(routineIntervalRefusal({ kind: 'webhook', url: 'https://x', secretMasked: 'w' }, 5 * 60_000)).toBeUndefined();
  });
  it('reports an invalid cron instead of crashing', () => {
    expect(routineIntervalRefusal(schedule('not a cron'), 5 * 60_000)).toMatch(/not a valid cron/);
  });
});

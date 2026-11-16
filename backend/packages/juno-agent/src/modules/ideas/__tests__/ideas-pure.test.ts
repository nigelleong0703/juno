import { describe, expect, it } from 'vitest';
import { jobMinute } from '../../memory/jobs/schedule.js';
import { blockedReason, ideaKey, type IdeaFacts } from '../cooldown.js';
import { missingCapabilities, type AgentCapabilities } from '../gate.js';
import { nextIdeasAt } from '../schedule.js';

const caps = (over: Partial<AgentCapabilities> = {}): AgentCapabilities => ({ tools: new Set(['web_fetch', 'send_message', 'files.write', 'gmail_send_email', 'gmail_read_thread', 'shop_buy']), mcpTools: new Set(['gmail_send_email', 'gmail_read_thread', 'shop_buy']), computer: true, ...over });

describe('capability gate', () => {
  it('keeps an idea whose tools are all there and drops the ones that are not', () => {
    expect(missingCapabilities([], caps())).toEqual([]);
    expect(missingCapabilities(['web_fetch', 'files.write'], caps())).toEqual([]);
    expect(missingCapabilities(['web_fetch', 'marketplace_haggle'], caps())).toEqual(['the agent has no tool marketplace_haggle']);
  });

  it('refuses computer tools when the user has no computer', () => {
    expect(missingCapabilities(['files.write'], caps({ computer: false }))).toEqual(['files.write needs a computer and there is none']);
    expect(missingCapabilities(['web_fetch'], caps({ computer: false }))).toEqual([]);
  });

  it('applies the permission tiers', () => {
    const never = caps({ tiers: { send: 'never', purchase: 'never' } });
    expect(missingCapabilities(['gmail_send_email'], never)).toHaveLength(1);
    expect(missingCapabilities(['send_message'], never)).toHaveLength(1);
    expect(missingCapabilities(['shop_buy'], never)).toHaveLength(1);
    expect(missingCapabilities(['gmail_read_thread'], never)).toEqual([]);
    expect(missingCapabilities(['gmail_send_email'], caps({ tiers: { send: 'ask' } }))).toEqual([]);
    expect(missingCapabilities([], caps({ tiers: { reachOut: 'off' } }))).toHaveLength(1);
  });
});

describe('idea dedupe', () => {
  const now = new Date('2026-10-15T08:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const earlier = (status: IdeaFacts['status'], ageDays: number, over: Partial<IdeaFacts> = {}): IdeaFacts =>
    ({ text: 'Draft a note to Priya', topic: 'priya-move', key: ideaKey('priya-move', 'draft'), status, updatedAt: new Date(now.getTime() - ageDays * day).toISOString(), ...over });
  const again = { text: 'Write Priya about the move', topic: 'Priya move', key: ideaKey('Priya move', 'draft') };

  it('catches a reworded duplicate by its key, and lets a different action on the same topic through', () => {
    expect(blockedReason(again, [earlier('open', 0)], now)).toBe('already waiting');
    expect(blockedReason({ ...again, key: ideaKey('priya-move', 'remind') }, [earlier('open', 0)], now)).toBeUndefined();
    expect(blockedReason({ text: 'Book flights', topic: 'tokyo', key: ideaKey('tokyo', 'book') }, [earlier('open', 0)], now)).toBeUndefined();
  });

  it('never re-offers what was accepted or marked useful', () => {
    expect(blockedReason(again, [earlier('accepted', 400)], now)).toBe('already handled');
    expect(blockedReason(again, [earlier('accepted', 90, { outcome: 'useful' })], now)).toBe('already handled');
  });

  it('keeps a dismissed idea away for 60 days, a snoozed one and its topic for 14', () => {
    expect(blockedReason(again, [earlier('dismissed', 59)], now)).toBe('dismissed');
    expect(blockedReason(again, [earlier('dismissed', 61)], now)).toBeUndefined();
    expect(blockedReason(again, [earlier('dismissed', 13, { outcome: 'not_now' })], now)).toBe('snoozed for now');
    expect(blockedReason({ ...again, key: ideaKey('priya-move', 'remind') }, [earlier('dismissed', 13, { outcome: 'not_now' })], now)).toBe('snoozed for now');
    expect(blockedReason(again, [earlier('dismissed', 15, { outcome: 'not_now' })], now)).toBeUndefined();
    expect(blockedReason(again, [], now, ['priya move'])).toBe('its topic was snoozed');
  });

  it('re-offers an ignored idea once after 14 days, and not a second time for 60', () => {
    expect(blockedReason(again, [earlier('dismissed', 10, { outcome: 'ignored' })], now)).toBe('shown and ignored');
    expect(blockedReason(again, [earlier('dismissed', 15, { outcome: 'ignored' })], now)).toBeUndefined();
    const twice = [earlier('dismissed', 15, { outcome: 'ignored' }), earlier('dismissed', 40, { outcome: 'ignored' })];
    expect(blockedReason(again, twice, now)).toBe('shown and ignored');
  });

  it('falls back to topic or title for an idea from before keys existed', () => {
    const old: IdeaFacts = { text: 'Reply to Priya!', topic: 'priya-move', status: 'open', updatedAt: now.toISOString() };
    expect(blockedReason({ text: 'reply to priya' }, [old], now)).toBe('already waiting');
    expect(blockedReason(again, [old], now)).toBe('already waiting');
    expect(blockedReason({ text: 'Book flights', topic: 'tokyo' }, [old], now)).toBeUndefined();
  });
});

describe('daily schedule', () => {
  it('fires in the user\'s morning, once a day, strictly in the future', () => {
    const minute = jobMinute('owner-1');
    const now = new Date('2026-10-14T20:00:00Z');
    const shanghai = nextIdeasAt(now, 'owner-1', 'Asia/Shanghai');
    expect(shanghai.toISOString()).toBe(new Date(Date.UTC(2026, 9, 15, 0, minute)).toISOString());
    expect(nextIdeasAt(shanghai, 'owner-1', 'Asia/Shanghai').getTime() - shanghai.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(nextIdeasAt(now, 'owner-1').toISOString()).toBe(new Date(Date.UTC(2026, 9, 15, 8, minute)).toISOString());
    expect(nextIdeasAt(now, 'owner-1', 'Not/AZone').toISOString()).toBe(nextIdeasAt(now, 'owner-1').toISOString());
    const newYork = nextIdeasAt(new Date('2026-10-15T11:00:00Z'), 'owner-1', 'America/New_York');
    expect(newYork.toISOString()).toBe(new Date(Date.UTC(2026, 9, 15, 12, minute)).toISOString());
  });

  it('runs at the owner\'s chosen local time in their zone, across a DST change and a zone change, and keeps the default when none is set', () => {
    // 21:30 Shanghai (UTC+8) is 13:30 UTC.
    expect(nextIdeasAt(new Date('2026-10-14T20:00:00Z'), 'owner-1', 'Asia/Shanghai', '21:30').toISOString()).toBe('2026-10-15T13:30:00.000Z');
    // Already past today: tomorrow.
    expect(nextIdeasAt(new Date('2026-10-15T14:00:00Z'), 'owner-1', 'Asia/Shanghai', '21:30').toISOString()).toBe('2026-10-16T13:30:00.000Z');
    // New York leaves daylight time on 2026-11-01: 07:00 local is 11:00 UTC before, 12:00 UTC after.
    expect(nextIdeasAt(new Date('2026-10-31T13:00:00Z'), 'owner-1', 'America/New_York', '07:00').toISOString()).toBe('2026-11-01T12:00:00.000Z');
    expect(nextIdeasAt(new Date('2026-10-30T13:00:00Z'), 'owner-1', 'America/New_York', '07:00').toISOString()).toBe('2026-10-31T11:00:00.000Z');
    // The same wall-clock time after moving zones is a different instant.
    expect(nextIdeasAt(new Date('2026-10-14T20:00:00Z'), 'owner-1', 'Europe/Amsterdam', '07:00').toISOString()).toBe('2026-10-15T05:00:00.000Z');
    // Never set, or not a valid HH:MM: today's behaviour.
    expect(nextIdeasAt(new Date('2026-10-14T20:00:00Z'), 'owner-1', 'Asia/Shanghai', undefined).toISOString()).toBe(nextIdeasAt(new Date('2026-10-14T20:00:00Z'), 'owner-1', 'Asia/Shanghai').toISOString());
    expect(nextIdeasAt(new Date('2026-10-14T20:00:00Z'), 'owner-1', 'Asia/Shanghai', '25:99').toISOString()).toBe(nextIdeasAt(new Date('2026-10-14T20:00:00Z'), 'owner-1', 'Asia/Shanghai').toISOString());
  });
});

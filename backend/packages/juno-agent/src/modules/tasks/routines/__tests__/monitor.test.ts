import { describe, expect, it } from 'vitest';
import type { CheckTrigger } from '@agent-desktop/public-contracts';
import type { ToolResult } from '../../../../contracts/index.js';
import {
  applyFailure, evaluate, mergeSeen, MONITOR_DISABLE_AFTER, MONITOR_RECONNECT_GIVE_UP_MS, MONITOR_SEEN_MAX, nextCheckDelayMs, pickPath, specProblem, unseen,
} from '../monitor.js';

const reply = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const spec = (change: Partial<CheckTrigger> = {}): CheckTrigger => ({ kind: 'check', everyMinutes: 30, human: 'Every 30 minutes', tool: 'list_issues', args: {}, ...change });
const issues = (...ids: number[]): ToolResult => reply(JSON.stringify({ data: { issues: ids.map((id) => ({ id, title: 'Issue ' + String(id) })) } }));

describe('monitor spec', () => {
  it('needs an id field with items, and a pattern with below', () => {
    expect(specProblem(spec({ items: 'data.issues' }))).toMatch(/`id` is required/);
    expect(specProblem(spec({ below: 50 }))).toMatch(/needs a `pattern`/);
    expect(specProblem(spec({ pattern: '(' }))).toMatch(/not a valid regular expression/);
    expect(specProblem(spec({ items: 'data.issues', id: 'id' }))).toBeUndefined();
    expect(specProblem(spec({ pattern: 'Price: \\$([0-9.]+)', below: 50 }))).toBeUndefined();
  });

  it('follows dot paths into objects and lists', () => {
    expect(pickPath({ a: { b: [{ c: 7 }] } }, 'a.b.0.c')).toBe(7);
    expect(pickPath([1, 2], '')).toEqual([1, 2]);
    expect(pickPath({ a: 1 }, 'a.b')).toBeUndefined();
  });
});

describe('monitor list results', () => {
  it('turns the items at the path into candidates with their ids', () => {
    const result = evaluate(spec({ items: 'data.issues', id: 'id' }), issues(3, 2, 1));
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.candidates.map((candidate) => candidate.id)).toEqual(['3', '2', '1']);
  });

  it('explains a path that does not lead to a list, and a missing id field', () => {
    expect(evaluate(spec({ items: 'data.nope', id: 'id' }), issues(1))).toMatchObject({ ok: false, error: expect.stringContaining('not a list') });
    expect(evaluate(spec({ items: 'data.issues', id: 'number' }), issues(1))).toMatchObject({ ok: false, error: expect.stringContaining('no item has an `id` field') });
    expect(evaluate(spec({ items: 'x', id: 'id' }), reply('plain text'))).toMatchObject({ ok: false, error: expect.stringContaining('not JSON') });
  });

  it('keeps only the items a pattern matches, and refuses a list too long to remember', () => {
    const only = evaluate(spec({ items: 'data.issues', id: 'id', pattern: 'Issue 2' }), issues(1, 2, 3));
    expect(only.ok && only.candidates.map((candidate) => candidate.id)).toEqual(['2']);
    const tooMany = evaluate(spec({ items: 'data.issues', id: 'id' }), issues(...Array.from({ length: MONITOR_SEEN_MAX + 1 }, (_, i) => i)));
    expect(tooMany).toMatchObject({ ok: false, error: expect.stringContaining('narrow') });
  });

  it('reports only what has not been seen', () => {
    const result = evaluate(spec({ items: 'data.issues', id: 'id' }), issues(4, 3, 2));
    expect(result.ok && unseen(result.candidates, ['3', '2']).map((candidate) => candidate.id)).toEqual(['4']);
  });

  it('keeps the seen set within the bound and never drops the current items', () => {
    const old = Array.from({ length: MONITOR_SEEN_MAX }, (_, i) => 'old' + String(i));
    const merged = mergeSeen(old, ['new1', 'new2']);
    expect(merged).toHaveLength(MONITOR_SEEN_MAX);
    expect(merged.slice(-2)).toEqual(['new1', 'new2']);
    expect(merged).not.toContain('old0');
    expect(mergeSeen(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('monitor pages', () => {
  it('wakes on any change to the page when there is no pattern', () => {
    const first = evaluate(spec({ tool: 'web_fetch' }), reply('Title: Shop\n\nPrice: $59'));
    const same = evaluate(spec({ tool: 'web_fetch' }), reply('Title: Shop\n\nPrice: $59'));
    const changed = evaluate(spec({ tool: 'web_fetch' }), reply('Title: Shop\n\nPrice: $49'));
    const id = (e: ReturnType<typeof evaluate>): string | undefined => (e.ok ? e.candidates[0]?.id : undefined);
    expect(id(first)).toBe(id(same));
    expect(id(first)).not.toBe(id(changed));
  });

  it('matches "price under X" with a number comparison', () => {
    const under = spec({ tool: 'web_fetch', pattern: 'Price:\\s*\\$([0-9.,]+)', below: 50 });
    expect(evaluate(under, reply('Price: $59.00'))).toEqual({ ok: true, candidates: [] });
    expect(evaluate(under, reply('no price here'))).toEqual({ ok: true, candidates: [] });
    const hit = evaluate(under, reply('Price: $49.99 today'));
    expect(hit.ok && hit.candidates).toHaveLength(1);
    expect(evaluate(under, reply('Price: $1,299.00'))).toEqual({ ok: true, candidates: [] });
  });
});

describe('monitor failures', () => {
  it('backs off with each failure up to six hours', () => {
    expect(nextCheckDelayMs(30, 0)).toBe(30 * 60_000);
    expect(nextCheckDelayMs(30, 1)).toBe(60 * 60_000);
    expect(nextCheckDelayMs(30, 10)).toBe(6 * 3_600_000);
    expect(nextCheckDelayMs(24 * 60, 3)).toBe(24 * 60 * 60_000);
  });

  it('tells the owner once at the third failure and stops at ten', () => {
    const now = new Date('2026-10-22T10:00:00Z');
    expect(applyFailure({ failures: 1 }, false, now)).toMatchObject({ failures: 2, notify: false });
    expect(applyFailure({ failures: 2 }, false, now)).toMatchObject({ failures: 3, notify: true });
    expect(applyFailure({ failures: 2, notifiedAt: 'x' }, false, now).notify).toBe(false);
    expect(applyFailure({ failures: MONITOR_DISABLE_AFTER - 1 }, false, now).stop).toBe('failures');
  });

  it('gives a signed-out connector 72 hours, however many checks fail meanwhile', () => {
    const start = new Date('2026-10-22T10:00:00Z');
    const first = applyFailure({ failures: 0 }, true, start);
    expect(first.brokenSince).toBe(start.toISOString());
    const late = applyFailure({ failures: 20, brokenSince: first.brokenSince ?? '' }, true, new Date(start.getTime() + MONITOR_RECONNECT_GIVE_UP_MS - 1000));
    expect(late.stop).toBeUndefined();
    const over = applyFailure({ failures: 21, brokenSince: first.brokenSince ?? '' }, true, new Date(start.getTime() + MONITOR_RECONNECT_GIVE_UP_MS));
    expect(over.stop).toBe('reconnect');
  });
});

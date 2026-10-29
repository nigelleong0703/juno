/** The food diary tools: validation, summed totals, local-time parsing, owner scoping and day boundaries in the user's timezone. */
import { describe, expect, it } from 'vitest';
import { settingsIdFor, type MealItem } from '@agent-desktop/public-contracts';
import type { Store, Tool, ToolContext } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { toolContext } from '../../../execution/brain/__tests__/agent-resources.fixtures.js';
import { createMealDeleteTool, createMealLogTool, createMealSummaryTool, createMealUpdateTool } from '../../tools/tools/mealTools.js';
import { parseEatenAt } from '../index.js';

const ownerStore = (owner: string): Store => {
  const mem = createMemoryStore();
  const scoped = mem.forOwner?.(owner);
  if (scoped === undefined) throw new Error('test store lacks forOwner');
  return scoped;
};

async function call(tool: Tool, ctx: ToolContext, args: unknown): Promise<{ text: string; isError: boolean }> {
  const result = await tool.execute(args, ctx);
  const part = result.content[0];
  return { text: part?.type === 'text' ? part.text : '', isError: result.isError === true };
}

const rice = { name: 'Chicken rice', portion: '1 plate', kcal: 600, proteinG: 28, carbsG: 80, fatG: 20, sodiumMg: 900 };
const tea = { name: 'Iced lime tea', portion: '350 ml', kcal: 90, proteinG: 0, carbsG: 22, fatG: 0 };

async function withZone(store: Store, timezone: string): Promise<void> {
  await store.put('settings', { id: settingsIdFor('owner-1'), general: { launchAtLogin: false, language: 'en', timezone } } as never);
}

describe('meal_log', () => {
  it('stores the entry with totals summed from the items, and refuses bad arguments', async () => {
    const store = ownerStore('owner-1');
    const ctx = toolContext(store, 'agent-a');
    const ok = await call(createMealLogTool(), ctx, { mealType: 'lunch', description: 'Chicken rice and lime tea', items: [rice, tea], source: 'text' });
    expect(ok.isError).toBe(false);
    expect(ok.text).toMatch(/690 kcal/);
    const [row] = (await store.list('meals')).items;
    expect(row).toMatchObject({ agentId: 'agent-a', mealType: 'lunch', confidence: 'estimate', source: 'text', totals: { kcal: 690, proteinG: 28, carbsG: 102, fatG: 20, sodiumMg: 900 } });
    expect(row?.totals.fiberG).toBeUndefined();

    for (const bad of [
      { mealType: 'brunch', description: 'x', items: [rice], source: 'text' },
      { mealType: 'lunch', description: 'x', items: [], source: 'text' },
      { mealType: 'lunch', description: 'x', items: [{ ...rice, kcal: -1 }], source: 'text' },
      { mealType: 'lunch', description: 'x', items: [rice] },
      { mealType: 'lunch', description: 'x', items: [rice], source: 'text', eatenAt: 'lunchtime' },
      { mealType: 'lunch', description: 'x', items: [rice], source: 'photo', photoFileId: 'missing' },
    ]) expect((await call(createMealLogTool(), ctx, bad)).isError).toBe(true);
    expect((await store.list('meals')).items).toHaveLength(1);
  });

  it('reads a bare local time on the user\'s clock', async () => {
    const store = ownerStore('owner-1');
    await withZone(store, 'Asia/Singapore');
    await call(createMealLogTool(), toolContext(store, 'agent-a'), { mealType: 'dinner', description: 'Laksa', items: [rice], source: 'text', eatenAt: '2026-10-19T19:30' });
    expect((await store.list('meals')).items[0]?.eatenAt).toBe('2026-10-19T11:30:00.000Z');
  });
});

describe('parseEatenAt', () => {
  it('handles offsets, zones, daylight saving and nonsense', () => {
    expect(parseEatenAt('2026-10-19T12:30:00+08:00', undefined)).toBe('2026-10-19T04:30:00.000Z');
    expect(parseEatenAt('2026-10-19T12:30', 'Asia/Singapore')).toBe('2026-10-19T04:30:00.000Z');
    expect(parseEatenAt('2026-07-01T12:00', 'America/New_York')).toBe('2026-07-01T16:00:00.000Z');
    expect(parseEatenAt('2026-12-01T12:00', 'America/New_York')).toBe('2026-12-01T17:00:00.000Z');
    expect(parseEatenAt('2026-10-19T12:30', undefined)).toBe('2026-10-19T12:30:00.000Z');
    expect(parseEatenAt('2026-02-31', undefined)).toBeUndefined();
    expect(parseEatenAt('yesterday', undefined)).toBeUndefined();
  });
});

describe('meal_update and meal_delete', () => {
  it('re-sums totals on new items, patches fields, deletes, and cannot touch another owner\'s entry', async () => {
    const mem = createMemoryStore();
    const mine = mem.forOwner?.('owner-1');
    const theirs = mem.forOwner?.('owner-2');
    if (mine === undefined || theirs === undefined) throw new Error('test store lacks forOwner');
    const ctx = toolContext(mine, 'agent-a');
    await call(createMealLogTool(), ctx, { mealType: 'lunch', description: 'Chicken rice', items: [rice], source: 'text' });
    const id = (await mine.list('meals')).items[0]?.id ?? '';
    await theirs.put('meals', { id: 'meal-other', ownerId: 'owner-2', eatenAt: '2026-10-19T04:00:00.000Z', mealType: 'lunch', description: 'x', items: [], totals: { kcal: 1, proteinG: 0, carbsG: 0, fatG: 0 }, confidence: 'estimate', source: 'text', createdAt: '2026-10-19T04:00:00.000Z' } as never);

    const updated = await call(createMealUpdateTool(), ctx, { id, items: [{ ...rice, portion: 'small', kcal: 450 }], confidence: 'user', mealType: 'dinner' });
    expect(updated.isError).toBe(false);
    expect(await mine.get('meals', id)).toMatchObject({ mealType: 'dinner', confidence: 'user', totals: { kcal: 450 } });
    expect((await call(createMealUpdateTool(), ctx, { id, kcal: 5 })).isError).toBe(true);
    expect((await call(createMealUpdateTool(), ctx, { id: 'meal-other', description: 'hacked' })).isError).toBe(true);
    expect((await call(createMealDeleteTool(), ctx, { id: 'meal-other' })).isError).toBe(true);
    expect((await theirs.get('meals', 'meal-other'))?.description).toBe('x');

    expect((await call(createMealDeleteTool(), ctx, { id })).isError).toBe(false);
    expect(await mine.get('meals', id)).toBeNull();
  });
});

describe('meal_summary', () => {
  it('groups by the user\'s local day, not UTC, and sums per day', async () => {
    const store = ownerStore('owner-1');
    await withZone(store, 'Asia/Singapore');
    const ctx = toolContext(store, 'agent-a');
    const log = (eatenAt: string, description: string, item: MealItem = rice) =>
      call(createMealLogTool(), ctx, { mealType: 'snack', description, items: [item], source: 'text', eatenAt });
    // 00:30 SGT on the 20th is 16:30Z on the 19th: it belongs to the 20th for this user.
    await log('2026-10-20T00:30:00+08:00', 'Midnight supper');
    await log('2026-10-19T12:30:00+08:00', 'Lunch', rice);
    await log('2026-10-19T15:00:00+08:00', 'Tea', tea);
    const day19 = await call(createMealSummaryTool(), ctx, { from: '2026-10-19', to: '2026-10-19' });
    expect(day19.text).toMatch(/2026-10-19: 690 kcal/);
    expect(day19.text).not.toMatch(/Midnight supper/);
    const both = await call(createMealSummaryTool(), ctx, { from: '2026-10-19', to: '2026-10-20' });
    expect(both.text).toMatch(/2026-10-20: 600 kcal/);
    expect(both.text).toMatch(/00:30 snack: Midnight supper/);
    expect(both.text).toMatch(/Across 2 logged days: 645 kcal\/day/);
    expect((await call(createMealSummaryTool(), ctx, { from: '2026-10-21', to: '2026-10-22' })).text).toMatch(/No meals logged/);
  });

  it('refuses bad ranges and never shows another owner\'s meals', async () => {
    const mem = createMemoryStore();
    const mine = mem.forOwner?.('owner-1');
    const theirs = mem.forOwner?.('owner-2');
    if (mine === undefined || theirs === undefined) throw new Error('test store lacks forOwner');
    await theirs.put('meals', { id: 'meal-other', ownerId: 'owner-2', eatenAt: '2026-10-19T04:00:00.000Z', mealType: 'lunch', description: 'secret', items: [], totals: { kcal: 1, proteinG: 0, carbsG: 0, fatG: 0 }, confidence: 'estimate', source: 'text', createdAt: '2026-10-19T04:00:00.000Z' } as never);
    const ctx = toolContext(mine, 'agent-a');
    expect((await call(createMealSummaryTool(), ctx, { from: '2026-10-19', to: '2026-10-19' })).text).not.toMatch(/secret/);
    expect((await call(createMealSummaryTool(), ctx, { from: '2026-10-20', to: '2026-10-19' })).isError).toBe(true);
    expect((await call(createMealSummaryTool(), ctx, { from: '2026-01-01', to: '2026-12-31' })).isError).toBe(true);
    expect((await call(createMealSummaryTool(), ctx, { from: 'today', to: 'today' })).isError).toBe(true);
  });
});

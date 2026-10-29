/** GET /v1/meals: the owner's own diary, newest first, bounded by instants; never another owner's rows. */
import { describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import { mealSchema, type Meal } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders } from '../../__tests__/test-app.js';

const meal = (id: string, owner: string, eatenAt: string): Meal & { ownerId: string } => ({
  id, ownerId: owner, eatenAt, mealType: 'lunch', description: id,
  items: [{ name: 'Rice', portion: '1 bowl', kcal: 200, proteinG: 4, carbsG: 44, fatG: 1 }],
  totals: { kcal: 200, proteinG: 4, carbsG: 44, fatG: 1 }, confidence: 'estimate', source: 'text', createdAt: eatenAt,
});

describe('GET /v1/meals', () => {
  async function setup() {
    const mem = createMemoryStore();
    const store = (owner: string) => {
      const scoped = mem.forOwner?.(owner);
      if (scoped === undefined) throw new Error('test store lacks forOwner');
      return scoped;
    };
    await store('owner-a').put('meals', meal('m1', 'owner-a', '2026-10-18T04:00:00.000Z'));
    await store('owner-a').put('meals', meal('m2', 'owner-a', '2026-10-19T04:00:00.000Z'));
    await store('owner-b').put('meals', meal('m3', 'owner-b', '2026-10-19T05:00:00.000Z'));
    return createTestApp({ store: mem, bus: mem.eventBus, enqueuer: new NoopEnqueuer() });
  }
  const get = async (path: string, owner: string) => (await setup()).request(path, { headers: ownerHeaders(owner, true) });

  it('lists only the caller\'s meals, newest first, in the public shape', async () => {
    const body = await (await get('/v1/meals', 'owner-a')).json() as { items: unknown[]; nextCursor: string | null };
    expect(mealSchema.array().parse(body.items).map((m) => m.id)).toEqual(['m2', 'm1']);
    const other = await (await get('/v1/meals', 'owner-b')).json() as { items: Array<{ id: string }> };
    expect(other.items.map((m) => m.id)).toEqual(['m3']);
  });

  it('bounds by from (inclusive) and to (exclusive) and refuses a bad instant', async () => {
    const ranged = await (await get('/v1/meals?from=2026-10-19T00:00:00.000Z&to=2026-10-20T00:00:00.000Z', 'owner-a')).json() as { items: Array<{ id: string }> };
    expect(ranged.items.map((m) => m.id)).toEqual(['m2']);
    const exclusive = await (await get('/v1/meals?to=2026-10-19T04:00:00.000Z', 'owner-a')).json() as { items: Array<{ id: string }> };
    expect(exclusive.items.map((m) => m.id)).toEqual(['m1']);
    expect((await get('/v1/meals?from=yesterday', 'owner-a')).status).toBe(400);
  });
});

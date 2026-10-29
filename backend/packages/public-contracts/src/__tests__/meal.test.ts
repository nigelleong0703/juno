import { describe, expect, it } from 'vitest';
import { mealSchema } from '../models/meal.js';

const valid = {
  id: 'meal-1', eatenAt: '2026-10-19T04:30:00.000Z', mealType: 'lunch', description: 'Chicken rice',
  items: [{ name: 'Chicken rice', portion: '1 plate', kcal: 600, proteinG: 28, carbsG: 80, fatG: 20, sodiumMg: 900 }],
  totals: { kcal: 600, proteinG: 28, carbsG: 80, fatG: 20, sodiumMg: 900 }, confidence: 'estimate', source: 'photo', createdAt: '2026-10-19T04:31:00.000Z',
};

describe('mealSchema', () => {
  it('parses a diary entry with optional nutrients and photo', () => {
    expect(mealSchema.parse({ ...valid, photoFileId: 'file-1' }).totals.sodiumMg).toBe(900);
  });

  it('refuses unknown types, negative numbers and a time without an offset', () => {
    expect(mealSchema.safeParse({ ...valid, mealType: 'brunch' }).success).toBe(false);
    expect(mealSchema.safeParse({ ...valid, totals: { ...valid.totals, kcal: -1 } }).success).toBe(false);
    expect(mealSchema.safeParse({ ...valid, eatenAt: '2026-10-19T12:30' }).success).toBe(false);
    expect(mealSchema.safeParse({ ...valid, source: 'guess' }).success).toBe(false);
  });
});

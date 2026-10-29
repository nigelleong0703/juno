import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

export const mealTypeSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'drink']);
export type MealType = z.infer<typeof mealTypeSchema>;

/** How sure the numbers are: the agent's guess from a photo or words, a nutrition label, or the user's own figures. */
export const mealConfidenceSchema = z.enum(['estimate', 'label', 'user']);
export type MealConfidence = z.infer<typeof mealConfidenceSchema>;

/** What the entry was made from. */
export const mealSourceSchema = z.enum(['photo', 'text', 'label']);
export type MealSource = z.infer<typeof mealSourceSchema>;

/**
 * Nutrients in the units Apple Health's dietary types use (kcal = dietaryEnergyConsumed, grams = dietaryProtein, dietaryCarbohydrates,
 * dietaryFatTotal, dietaryFiber, dietarySugar; sodium in mg = dietarySodium), so an app can write a meal to Health without converting.
 */
export const mealNutrientsSchema = z.object({
  kcal: z.number().min(0),
  proteinG: z.number().min(0),
  carbsG: z.number().min(0),
  fatG: z.number().min(0),
  fiberG: z.number().min(0).optional(),
  sugarG: z.number().min(0).optional(),
  sodiumMg: z.number().min(0).optional(),
});
export type MealNutrients = z.infer<typeof mealNutrientsSchema>;

/** One thing eaten, with its portion in words ("1 plate", "250 ml") and its own numbers. */
export const mealItemSchema = mealNutrientsSchema.extend({
  name: z.string().min(1),
  portion: z.string().min(1),
});
export type MealItem = z.infer<typeof mealItemSchema>;

/** One entry of the food diary the agent keeps. `totals` is always the sum of `items`. */
export const mealSchema = z.object({
  id: idSchema,
  agentId: idSchema.optional(),
  /** When it was eaten (UTC instant; the agent reads it on the user's own clock). */
  eatenAt: isoDateTimeSchema,
  mealType: mealTypeSchema,
  description: z.string().min(1),
  items: z.array(mealItemSchema),
  totals: mealNutrientsSchema,
  /** The library file id of the photo this was estimated from. */
  photoFileId: idSchema.optional(),
  confidence: mealConfidenceSchema,
  source: mealSourceSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema.optional(),
});
export type Meal = z.infer<typeof mealSchema>;

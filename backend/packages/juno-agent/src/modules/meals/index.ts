// The food diary: totals from items, the user's local clock, and the compact day-by-day summary meal_summary returns.
import type { Meal, MealNutrients } from '@agent-desktop/public-contracts';
import { localDate, localTime } from '../home/paths.js';

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The sum of the items' nutrients; an optional nutrient is present only when at least one item reports it. */
export function sumNutrients(items: readonly MealNutrients[]): MealNutrients {
  const total: MealNutrients = { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  for (const item of items) {
    total.kcal += item.kcal;
    total.proteinG += item.proteinG;
    total.carbsG += item.carbsG;
    total.fatG += item.fatG;
    for (const key of ['fiberG', 'sugarG', 'sodiumMg'] as const) {
      const value = item[key];
      if (value !== undefined) total[key] = (total[key] ?? 0) + value;
    }
  }
  const out: MealNutrients = { kcal: round1(total.kcal), proteinG: round1(total.proteinG), carbsG: round1(total.carbsG), fatG: round1(total.fatG) };
  for (const key of ['fiberG', 'sugarG', 'sodiumMg'] as const) {
    const value = total[key];
    if (value !== undefined) out[key] = round1(value);
  }
  return out;
}

/** The UTC offset of `zone` at `at`, in minutes (east positive). */
function offsetMinutes(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return Math.round((Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

const OFFSET_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * An eatenAt value as a UTC ISO instant. A value with Z or an offset is taken as given; a bare local time
 * ("2026-10-19T12:30") is read on the user's own clock in `zone` (UTC when unknown). Undefined when it is not a time.
 */
export function parseEatenAt(value: string, zone: string | undefined): string | undefined {
  const text = value.trim();
  if (OFFSET_SUFFIX.test(text)) {
    const at = new Date(text);
    return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (m === null) return undefined;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? '12'), Number(m[5] ?? '0'), Number(m[6] ?? '0'));
  if (Number.isNaN(wall) || new Date(wall).getUTCMonth() !== Number(m[2]) - 1) return undefined;
  try {
    // Two passes settle the offset when the wall time sits next to a daylight-saving change.
    let at = wall - offsetMinutes(new Date(wall), zone ?? 'UTC') * 60000;
    at = wall - offsetMinutes(new Date(at), zone ?? 'UTC') * 60000;
    return new Date(at).toISOString();
  } catch {
    return undefined;
  }
}

const kcal = (n: number): string => String(Math.round(n));
const macros = (t: MealNutrients): string => `P ${kcal(t.proteinG)}g C ${kcal(t.carbsG)}g F ${kcal(t.fatG)}g`;

/** Per-day totals and each meal (time, type, description, kcal, id) for the local dates `from`..`to` inclusive. */
export function summarizeMeals(meals: readonly Meal[], from: string, to: string, zone: string | undefined): string {
  const byDay = new Map<string, Meal[]>();
  for (const meal of meals) {
    const day = localDate(new Date(meal.eatenAt), zone);
    if (day < from || day > to) continue;
    byDay.set(day, [...(byDay.get(day) ?? []), meal]);
  }
  if (byDay.size === 0) return `No meals logged from ${from} to ${to}.`;
  const lines: string[] = [];
  const days = [...byDay.keys()].sort();
  for (const day of days) {
    const list = (byDay.get(day) ?? []).sort((a, b) => a.eatenAt.localeCompare(b.eatenAt));
    const total = sumNutrients(list.map((m) => m.totals));
    const extras = [total.fiberG === undefined ? '' : ` fiber ${kcal(total.fiberG)}g`, total.sugarG === undefined ? '' : ` sugar ${kcal(total.sugarG)}g`, total.sodiumMg === undefined ? '' : ` sodium ${kcal(total.sodiumMg)}mg`].join('');
    lines.push(`${day}: ${kcal(total.kcal)} kcal, ${macros(total)}${extras} (${String(list.length)} ${list.length === 1 ? 'entry' : 'entries'})`);
    for (const m of list) lines.push(`  ${localTime(new Date(m.eatenAt), zone)} ${m.mealType}: ${m.description} - ${kcal(m.totals.kcal)} kcal, ${macros(m.totals)} [${m.confidence}] id ${m.id}`);
  }
  if (days.length > 1) {
    const all = sumNutrients([...byDay.values()].flat().map((m) => m.totals));
    lines.push(`Across ${String(days.length)} logged days: ${kcal(all.kcal / days.length)} kcal/day on average, ${macros({ ...all, proteinG: all.proteinG / days.length, carbsG: all.carbsG / days.length, fatG: all.fatG / days.length })} per day.`);
  }
  return lines.join('\n');
}

import type { Subscription } from '../../../contracts/index.js';

export interface ExternalEvent {
  id: string;
  source: string;
  type: string;
  data?: Record<string, unknown>;
  [field: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const lookup = (event: ExternalEvent, path: string): unknown => {
  const walk = (root: unknown): unknown =>
    path.split('.').reduce<unknown>((acc, key) => (isRecord(acc) ? acc[key] : undefined), root);
  const top = walk(event);
  return top !== undefined ? top : walk(event.data);
};

const equals = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (typeof a === 'number' || typeof b === 'number') return String(a) === String(b);
  if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
};

export function matchesFilter(filter: Record<string, unknown>, event: ExternalEvent): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = lookup(event, key);
    if (expected === '*') return actual !== undefined;
    if (Array.isArray(expected)) return expected.some((e) => equals(e, actual));
    return equals(expected, actual);
  });
}

export const isExpired = (sub: Pick<Subscription, 'expiresAt'>, now: number): boolean => {
  const expiresAt = Date.parse(sub.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
};

export function matchSubscriptions(subs: readonly Subscription[], event: ExternalEvent, now: number): Subscription[] {
  return subs.filter((s) => !isExpired(s, now) && matchesFilter(s.filter, event));
}

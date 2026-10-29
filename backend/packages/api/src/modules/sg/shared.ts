/** What the Singapore tool sets (modules/sg-mcp.ts) share: a tiny cache, Singapore time, and the tool shape. */

export type Args = Record<string, unknown>;

export interface SgContext {
  /** JSON from a government API, cached for `ttlMs` so a chatty agent does not burn the deployment's rate limit. */
  getJson(url: string, ttlMs: number, headers?: Record<string, string>): Promise<unknown>;
  /** Any slow-to-build value (a paginated list), cached under `key`. */
  memo<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  now(): Date;
}

export interface SgTool {
  name: string;
  /** The human name of the tool (MCP `title`). */
  title: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  run(ctx: SgContext, args: Args): Promise<string>;
}

export const MINUTE = 60_000;

export const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

export const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? (value as Record<string, unknown>[]) : []);

export const rec = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** How many results the caller asked for, within 1..max. */
export const limitOf = (args: Args, fallback: number, max: number): number =>
  typeof args.limit === 'number' ? Math.min(max, Math.max(1, Math.trunc(args.limit))) : fallback;

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false });
const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short' });

/** "14:05" in Singapore time, whatever offset the source used; the input as-is when it is not a time. */
export function sgTime(value: unknown): string {
  const date = new Date(typeof value === 'string' ? value : NaN);
  return Number.isNaN(date.getTime()) ? String(value ?? '') : clock.format(date);
}

/** "Mon 19 Oct" in Singapore time. */
export function sgDay(value: unknown): string {
  const date = new Date(typeof value === 'string' ? value : NaN);
  return Number.isNaN(date.getTime()) ? String(value ?? '') : day.format(date);
}

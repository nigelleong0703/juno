/** What the Microsoft Graph tool sets (Outlook, Calendar, To Do, OneDrive, Contacts, Teams) share. Output is compact text. */
import { clip, str, type Api, type Args, type Query } from '../google/shared.js';

export const MS_PAGE = {
  maxResults: { type: 'integer', minimum: 1, maximum: 50, description: 'How many results (default 10).' },
  pageToken: { type: 'string', description: 'The pageToken a previous call printed, for the next page.' },
};
export const MS_ZONE = { timeZone: { type: 'string', description: 'IANA time zone for the times shown and entered, e.g. Asia/Singapore (default UTC).' } };

export const size = (args: Args): string => String(typeof args.maxResults === 'number' ? Math.min(50, Math.max(1, Math.trunc(args.maxResults))) : 10);

/** A valid IANA zone name from the args, else undefined (times then stay ISO UTC). */
export function zoneOf(args: Args): string | undefined {
  const zone = str(args.timeZone);
  if (zone === undefined) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** Graph returns UTC dateTimes without an offset (we ask for UTC); shown as `2026-10-20 09:00` in the zone, else ISO. */
export function when(value: unknown, zone: string | undefined): string {
  if (typeof value !== 'string' || value === '') return '';
  const iso = /(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : value.replace(/(\.\d{3})\d*$/, '$1') + 'Z';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  if (zone === undefined) return date.toISOString().replace('.000Z', 'Z');
  return new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date) + ' ' + zone;
}

const HAS_OFFSET = /(Z|[+-]\d\d:?\d\d)$/;

/** The instant a typed time means: with an offset as written, without one the wall time in `zone` (default UTC). */
export function instantOf(value: string, zone: string | undefined): Date | undefined {
  const text = /^\d{4}-\d\d-\d\d$/.test(value) ? value + 'T00:00:00' : value;
  if (HAS_OFFSET.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const wall = new Date(text + 'Z');
  if (Number.isNaN(wall.getTime())) return undefined;
  if (zone === undefined) return wall;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(wall).map((part) => [part.type, Number(part.value)]));
  const shown = Date.UTC(parts.year ?? 0, (parts.month ?? 1) - 1, parts.day ?? 1, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  return new Date(wall.getTime() - (shown - wall.getTime()));
}

/** A time the agent typed as Graph's `{dateTime, timeZone}`, always UTC. */
export function graphTime(value: string, zone: string | undefined): { dateTime: string; timeZone: string } {
  const date = instantOf(value, zone);
  if (date === undefined) throw new Error('Not a date and time: ' + value);
  return { dateTime: date.toISOString().replace('Z', ''), timeZone: 'UTC' };
}

export const person = (value: unknown): string => {
  const address = typeof value === 'object' && value !== null ? Reflect.get(value, 'emailAddress') : undefined;
  if (typeof address !== 'object' || address === null) return '';
  const name = Reflect.get(address, 'name');
  const mail = Reflect.get(address, 'address');
  return typeof name === 'string' && name !== '' && name !== mail ? name + ' <' + String(mail) + '>' : String(mail ?? '');
};

export const people = (value: unknown): string => (Array.isArray(value) ? value.map(person).filter((entry) => entry !== '').join(', ') : '');

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** A message/event body as plain text: Graph is asked for text (Prefer header), HTML is stripped when it comes anyway. */
export function bodyText(body: unknown, limit: number): string {
  if (typeof body !== 'object' || body === null) return '';
  const content = Reflect.get(body, 'content');
  if (typeof content !== 'string') return '';
  return clip(Reflect.get(body, 'contentType') === 'html' ? htmlToText(content) : content.trim(), limit);
}

export const rows = (body: Record<string, unknown>): Record<string, unknown>[] => (Array.isArray(body.value) ? (body.value as Record<string, unknown>[]) : []);

/** The `@odata.nextLink` as an opaque token: the path and query only, so a later call can never be pointed at another host. */
export function nextToken(body: Record<string, unknown>): string | undefined {
  const link = body['@odata.nextLink'];
  if (typeof link !== 'string') return undefined;
  try {
    const url = new URL(link);
    return url.pathname.replace(/^\/(v1\.0|beta)/, '') + url.search;
  } catch {
    return undefined;
  }
}

export interface Listed {
  items: Record<string, unknown>[];
  /** The line telling the agent how to get the next page, or ''. */
  more: string;
}

/** One page: the first call sends `path` + `query`, a later one the token a previous call returned. */
export async function listPage(api: Api, args: Args, path: string, query: Query): Promise<Listed> {
  const token = str(args.pageToken);
  if (token !== undefined && (!token.startsWith('/') || token.startsWith('//'))) throw new Error('pageToken is not one this server gave out');
  const body = token === undefined ? await api(path, query) : await api(token);
  const next = nextToken(body);
  return { items: rows(body), more: next === undefined ? '' : '\nMore results: pageToken=' + next };
}

export const none = (what: string): string => 'No ' + what + '.';

export const escapeOData = (value: string): string => value.replace(/'/g, "''");

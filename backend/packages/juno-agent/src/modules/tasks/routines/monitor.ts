/**
 * Agent-created monitors (BACKEND 3.6.3): the pure part. A monitor is a routine whose trigger is a `check`: every so often the
 * server makes one read-only tool call and compares what came back with what it has already seen. Nothing here touches the
 * network, the store's wake path or the model: spec checks, picking items out of a result, new-item detection, the bounded
 * seen set, and the failure and expiry rules.
 */
import { createHash } from 'node:crypto';
import type { CheckTrigger } from '@agent-desktop/public-contracts';
import type { ToolResult } from '../../../contracts/index.js';

export const MONITOR_MAX_ACTIVE = 10;
export const MONITOR_SEEN_MAX = 500;
export const MONITOR_WAKES_PER_HOUR = 30;
export const MONITOR_WAKES_PER_DAY = 200;
export const MONITOR_LIFETIME_DAYS = 30;
/** Failures in a row before the owner is told (once), and before the monitor turns itself off. */
export const MONITOR_NOTIFY_AFTER = 3;
export const MONITOR_DISABLE_AFTER = 10;
/** A monitor whose connector needs a new sign-in is turned off after this long. */
export const MONITOR_RECONNECT_GIVE_UP_MS = 72 * 3_600_000;
const MAX_BACKOFF_MS = 6 * 3_600_000;
/** How many new items one wake shows the model; the rest are counted. */
export const MONITOR_SHOWN_ITEMS = 20;
const ITEM_TEXT_MAX = 600;
const PAGE_TEXT_MAX = 400_000;
const PATTERN_MAX = 200;

/** Minutes between checks: at least 15 (the test stack lowers the floor with MONITOR_MIN_INTERVAL_MS). */
export function minMonitorIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env['MONITOR_MIN_INTERVAL_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
}

export interface Candidate {
  id: string;
  text: string;
}

export type Evaluation = { ok: true; candidates: Candidate[] } | { ok: false; error: string };

function compile(pattern: string): RegExp | string {
  if (pattern.length > PATTERN_MAX) return 'pattern is longer than ' + String(PATTERN_MAX) + ' characters';
  try {
    return new RegExp(pattern, 'i');
  } catch (error) {
    return 'pattern is not a valid regular expression: ' + (error instanceof Error ? error.message : String(error));
  }
}

/** A message when the spec cannot work, else undefined. The tool and the interval are checked by the caller. */
export function specProblem(spec: CheckTrigger): string | undefined {
  if (spec.items !== undefined && (spec.id === undefined || spec.id.trim() === '')) return '`id` is required when `items` is given: name the field that identifies one item';
  if (spec.items === undefined && spec.id !== undefined) return '`id` only applies with `items`';
  if (spec.below !== undefined && spec.items !== undefined) return '`below` only applies to a page (no `items`)';
  if (spec.below !== undefined && spec.pattern === undefined) return '`below` needs a `pattern` whose first group captures the number';
  if (spec.pattern !== undefined) {
    const compiled = compile(spec.pattern);
    if (typeof compiled === 'string') return compiled;
  }
  return undefined;
}

/** Follow a dot path ("data.issues", "0.id") into parsed JSON. "" and "$" name the value itself. */
export function pickPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.').map((segment) => segment.trim()).filter((segment) => segment !== '' && segment !== '$')) {
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object' && current !== null) {
      current = Reflect.get(current, part);
    } else {
      return undefined;
    }
  }
  return current;
}

function resultText(result: ToolResult): string {
  return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function typeName(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  return Array.isArray(value) ? 'a list' : typeof value;
}

function itemId(item: unknown, field: string): string | undefined {
  const value = pickPath(item, field);
  return typeof value === 'string' && value !== '' ? value.slice(0, 200) : typeof value === 'number' ? String(value) : undefined;
}

function describeItem(item: unknown): string {
  const text = typeof item === 'string' ? item : JSON.stringify(item) ?? '';
  return text.length > ITEM_TEXT_MAX ? text.slice(0, ITEM_TEXT_MAX) + '...' : text;
}

function listCandidates(spec: CheckTrigger, items: string, text: string): Evaluation {
  const parsed = parseJson(text);
  if (parsed === undefined) return { ok: false, error: 'the tool result is not JSON, so `items` cannot point into it. It starts: ' + text.slice(0, 200) };
  const list = pickPath(parsed, items);
  if (!Array.isArray(list)) return { ok: false, error: '`items` ' + JSON.stringify(items) + ' leads to ' + typeName(list) + ', not a list. The result starts: ' + text.slice(0, 200) };
  const filter = spec.pattern === undefined ? undefined : compile(spec.pattern);
  if (typeof filter === 'string') return { ok: false, error: filter };
  const field = spec.id ?? '';
  const candidates: Candidate[] = [];
  const known = new Set<string>();
  let withoutId = 0;
  for (const item of list) {
    const id = itemId(item, field);
    if (id === undefined) {
      withoutId += 1;
      continue;
    }
    const shown = describeItem(item);
    if (known.has(id) || (filter !== undefined && !filter.test(typeof item === 'string' ? item : JSON.stringify(item) ?? ''))) continue;
    known.add(id);
    candidates.push({ id, text: shown });
  }
  if (list.length > 0 && withoutId === list.length) return { ok: false, error: 'no item has an `id` field named ' + JSON.stringify(field) + '. The first item is ' + describeItem(list[0]) };
  if (candidates.length > MONITOR_SEEN_MAX) return { ok: false, error: 'the list has more than ' + String(MONITOR_SEEN_MAX) + ' matching items; narrow the tool arguments (for example to unread or recent ones)' };
  return { ok: true, candidates };
}

function pageCandidates(spec: CheckTrigger, text: string): Evaluation {
  const page = text.length > PAGE_TEXT_MAX ? text.slice(0, PAGE_TEXT_MAX) : text;
  let shown = page.slice(0, ITEM_TEXT_MAX * 2);
  let hashed = page;
  if (spec.pattern !== undefined) {
    const re = compile(spec.pattern);
    if (typeof re === 'string') return { ok: false, error: re };
    const match = re.exec(page);
    if (match === null) return { ok: true, candidates: [] };
    if (spec.below !== undefined) {
      const number = Number((match[1] ?? match[0]).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)?.[0]);
      if (!Number.isFinite(number)) return { ok: false, error: 'the pattern matched ' + JSON.stringify(match[0]) + ' but its first group is not a number' };
      if (!(number < spec.below)) return { ok: true, candidates: [] };
    }
    hashed = match[0];
    const from = Math.max(0, match.index - 150);
    shown = page.slice(from, match.index + match[0].length + 150);
  }
  return { ok: true, candidates: [{ id: createHash('sha1').update(hashed).digest('hex').slice(0, 16), text: shown }] };
}

/** Turn one tool result into the items that currently match the spec. */
export function evaluate(spec: CheckTrigger, result: ToolResult): Evaluation {
  const text = resultText(result);
  return spec.items === undefined ? pageCandidates(spec, text) : listCandidates(spec, spec.items, text);
}

/** The candidates that have not been seen yet. */
export function unseen(candidates: readonly Candidate[], seen: readonly string[]): Candidate[] {
  const known = new Set(seen);
  return candidates.filter((candidate) => !known.has(candidate.id));
}

/** Everything seen so far plus the current candidates, bounded: the oldest ids go first and the current ones always stay. */
export function mergeSeen(seen: readonly string[], current: readonly string[]): string[] {
  const keep = new Set(current);
  return [...seen.filter((id) => !keep.has(id)), ...keep].slice(-MONITOR_SEEN_MAX);
}

/** Delay before the next check: the interval, doubled for each failure in a row, never more than six hours (or the interval itself if longer). */
export function nextCheckDelayMs(everyMinutes: number, failures: number): number {
  const base = Math.round(everyMinutes * 60_000);
  return Math.min(base * 2 ** Math.min(failures, 10), Math.max(base, MAX_BACKOFF_MS));
}

export interface FailureOutcome {
  failures: number;
  brokenSince?: string;
  /** Tell the owner now (the third failure in a row, once). */
  notify: boolean;
  stop?: 'failures' | 'reconnect';
}

/**
 * One failed check. A connector that needs a new sign-in is given 72 hours (the owner may be away); anything else is given
 * ten tries. The owner hears about it once, at the third failure in a row.
 */
export function applyFailure(prev: { failures: number; notifiedAt?: string; brokenSince?: string }, reconnect: boolean, now: Date): FailureOutcome {
  const failures = prev.failures + 1;
  const brokenSince = reconnect ? (prev.brokenSince ?? now.toISOString()) : undefined;
  const stop = reconnect
    ? (now.getTime() - Date.parse(brokenSince ?? now.toISOString()) >= MONITOR_RECONNECT_GIVE_UP_MS ? 'reconnect' : undefined)
    : (failures >= MONITOR_DISABLE_AFTER ? 'failures' : undefined);
  return {
    failures,
    ...(brokenSince === undefined ? {} : { brokenSince }),
    notify: failures === MONITOR_NOTIFY_AFTER && prev.notifiedAt === undefined,
    ...(stop === undefined ? {} : { stop }),
  };
}

/** Whether the connector looks signed out rather than the check being wrong. */
export function looksLikeReconnect(message: string): boolean {
  return /unauthori[sz]ed|\b40[13]\b|forbidden|expired|re-?auth|reconnect|sign in again|invalid_grant|disconnected|not available for this agent/i.test(message);
}

/** What the model is shown for the new items: a count and a bounded list. */
export function itemsText(items: readonly Candidate[], total: number): string {
  const lines = items.map((item, index) => String(index + 1) + '. ' + item.text);
  const more = total - items.length;
  return lines.join('\n') + (more > 0 ? '\n... and ' + String(more) + ' more' : '');
}

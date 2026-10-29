/**
 * The owner's proactive rules and the proactive log, against the store (BACKEND §5.10). Rules are read from and written to the
 * one home file by code only; the log is what makes the daily cap and the silence rule count "what was actually posted".
 */
import { randomUUID } from 'node:crypto';
import type { Store, WakeEvent } from '../../contracts/index.js';
import type { ProactiveLogRow } from '../../contracts/storage.js';
import { readOwnerTimeZone } from '../../execution/brain/context.js';
import { docOwner } from '../../execution/execution-owner.js';
import { getRow } from '../home/mirror.js';
import { PROACTIVE_FILE, localDate } from '../home/paths.js';
import type { HomeDeps } from '../home/service.js';
import { editHomeFile } from '../memory/files.js';
import { listAll } from '../memory/util.js';
import { addRule, keepRule, parseRules, renderRules, rulesText, type NewRule, type PrefRule } from './rules.js';

/** Unsolicited messages one owner gets per day: the ideas notice, goal check-ins and silence questions together. User-made triggers do not count. */
export const DAILY_CAP = 3;
const COUNTED: ReadonlySet<ProactiveLogRow['kind']> = new Set(['daily-check', 'goal-checkin', 'silence-question']);

/** The owner's local date for `now`. */
export async function todayFor(store: Store, ownerId: string, now: Date): Promise<string> {
  return localDate(now, await readOwnerTimeZone(store, ownerId));
}

/** The rules in the owner's file (an old free-text file is read as `never` / `tell` rules). */
export async function readRules(store: Store, ownerId: string): Promise<PrefRule[]> {
  return parseRules((await getRow(store, ownerId, PROACTIVE_FILE))?.content ?? '').rules;
}

/**
 * Changes the rules through `change` and writes the file in the fixed format (which also converts an old free-text file, once).
 * `change` may run more than once when the owner edits at the same moment; the result of the run that was written is returned.
 */
export async function updateRules<T>(deps: HomeDeps, ownerId: string, change: (rules: PrefRule[]) => { rules: PrefRule[]; result: T }): Promise<T> {
  let outcome: { result: T } | undefined;
  await editHomeFile(deps, { ownerId, path: PROACTIVE_FILE }, (content) => {
    const parsed = parseRules(content);
    const next = change(parsed.rules);
    outcome = { result: next.result };
    return !parsed.legacy && JSON.stringify(next.rules) === JSON.stringify(parsed.rules) ? null : renderRules(next.rules);
  });
  if (outcome === undefined) throw new Error('rules were not updated');
  return outcome.result;
}

/** Writes the one-time conversion of an old free-text file; a file already in the new format is left alone. */
export async function migrateRules(deps: HomeDeps, ownerId: string): Promise<void> {
  const row = await getRow(deps.store, ownerId, PROACTIVE_FILE);
  if (row !== null && parseRules(row.content).legacy) await updateRules(deps, ownerId, (rules) => ({ rules, result: undefined }));
}

export async function recordRule(deps: HomeDeps, ownerId: string, input: NewRule, now: Date): Promise<{ rule: PrefRule; added: boolean }> {
  const today = await todayFor(deps.store, ownerId, now);
  return updateRules(deps, ownerId, (rules) => {
    const next = addRule(rules, input, today);
    return { rules: next.rules, result: { rule: next.rule, added: next.added } };
  });
}

export async function removeRule(deps: HomeDeps, ownerId: string, id: string): Promise<boolean> {
  return updateRules(deps, ownerId, (rules) => ({ rules: rules.filter((rule) => rule.id !== id), result: rules.some((rule) => rule.id === id) }));
}

/** Keeps a soft rule (its review date moves 90 days on); undefined when there is no such rule or it has no review date. */
export async function keepRuleById(deps: HomeDeps, ownerId: string, id: string, now: Date): Promise<PrefRule | undefined> {
  const today = await todayFor(deps.store, ownerId, now);
  return updateRules(deps, ownerId, (rules) => {
    const kept = keepRule(rules, id, today);
    return { rules: kept?.rules ?? rules, result: kept?.rule };
  });
}

/**
 * The owner's rules as text to append to the wake of an automatic run that decides whether to message them (never the frozen
 * prefix of the system prompt). '' when they have none. A more specific instruction in a trigger the owner made wins over a topic rule;
 * those triggers do not use this.
 */
export async function rulesForWake(store: Store, ownerId: string, now: Date): Promise<string> {
  const rules = await readRules(store, ownerId);
  return rulesText(rules, await todayFor(store, ownerId, now));
}

// --- the log ---------------------------------------------------------------

/** The owner's log rows, newest first; `kinds` limits which. */
export async function ownerLog(store: Store, ownerId: string, kinds?: readonly ProactiveLogRow['kind'][]): Promise<ProactiveLogRow[]> {
  const rows = kinds?.length === 1 ? await listAll(store, 'proactiveLog', { where: { kind: kinds[0] ?? null }, orderBy: 'at', order: 'desc' }, 500) : await listAll(store, 'proactiveLog', { orderBy: 'at', order: 'desc' }, 500);
  return rows.filter((row) => docOwner(row) === ownerId && (kinds === undefined || kinds.includes(row.kind))).sort((a, b) => b.at.localeCompare(a.at));
}

export async function logProactive(store: Store, row: Omit<ProactiveLogRow, 'id'> & { id?: string }): Promise<ProactiveLogRow> {
  return store.put('proactiveLog', { ...row, id: row.id ?? 'plog-' + randomUUID() });
}

/**
 * What an automatic run's final reply counts as against the daily cap, or undefined when it does not count: the ideas notice
 * (`daily-check`) and a scheduled goal check-in (`goal-checkin`). A user-made trigger (routine, monitor, reminder), a "Check now",
 * a plan and a deadline reminder never count.
 */
export function countedKind(events: readonly WakeEvent[]): 'daily-check' | 'goal-checkin' | undefined {
  const first = events[0];
  if (first?.kind !== 'goal_checkin') return undefined;
  const reason = first.payload['reason'];
  return reason === 'proactive' ? 'daily-check' : reason === 'scheduled' ? 'goal-checkin' : undefined;
}

/** Whether the owner may still get an unsolicited message today; the caller drops the reply (and logs it) when not. */
export async function hasRoomToPost(store: Store, ownerId: string, now = new Date()): Promise<boolean> {
  return (await roomOn(store, ownerId, await todayFor(store, ownerId, now))) > 0;
}

/** Records that the run's reply was really posted; the wake id makes a repeat a no-op. */
export async function logPosted(store: Store, input: { kind: 'daily-check' | 'goal-checkin'; wake: WakeEvent; runId?: string; now?: Date }): Promise<void> {
  const { wake } = input;
  const now = input.now ?? new Date();
  const topic = typeof wake.payload['title'] === 'string' && input.kind === 'goal-checkin' ? wake.payload['title'] : undefined;
  await logProactive(store, {
    id: 'plog-' + wake.id, ownerId: wake.ownerId, kind: input.kind, agentId: wake.agentId, conversationId: wake.conversationId,
    ...(input.runId === undefined ? {} : { runId: input.runId }), ...(topic === undefined ? {} : { topic }), date: await todayFor(store, wake.ownerId, now), at: now.toISOString(),
  });
}

/** Unsolicited messages already posted to the owner on `date` (their local date). */
export async function postedOn(store: Store, ownerId: string, date: string): Promise<number> {
  return (await ownerLog(store, ownerId, [...COUNTED])).filter((row) => row.date === date).length;
}

/** How many more unsolicited messages the owner may get on `date`. */
export async function roomOn(store: Store, ownerId: string, date: string): Promise<number> {
  return Math.max(0, DAILY_CAP - (await postedOn(store, ownerId, date)));
}

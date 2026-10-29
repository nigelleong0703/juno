/**
 * The owner's proactive rules (BACKEND §5.10): what the agent may message about unprompted. They live in one home file,
 * `PROACTIVE_PREFERENCES.md`, in a fixed format only this code writes (the agent has no file access to it; it records a rule
 * with `preference_note`, the app with its buttons and the rules API). Pure: parse, render, add, remove, review, match.
 *
 *   ## Don't tell me
 *   - Cricket scores | id: 3fa9c1d2 | scope: topic | date: 2026-10-23 | source: "stop telling me about cricket"
 *   ## Less of
 *   - Daily word | id: 91bb04ee | scope: type | date: 2026-10-23 | review: 2027-01-21 | source: "You tapped Less like this on the Feed post \"Serendipity\""
 *
 * A rule is one line; `source` is last and a JSON string so the owner's words can hold anything. `dont` is hard (`never`, no
 * expiry); `less` is soft and has a review date, after which it is listed as due for review but keeps applying until the owner
 * keeps or deletes it.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ProactiveRule, ProactiveRuleKind, ProactiveRuleScope } from '@agent-desktop/public-contracts';
import { normalizeKey } from '../ideas/cooldown.js';

export const REVIEW_DAYS = 90;
const MAX_TEXT = 200;
const MAX_SOURCE = 300;
/** Where a rule written before this format came from (one-time migration of a free-text file). */
export const LEGACY_SOURCE = 'From your old preferences file';
const LEGACY_DATE = '2026-10-23';

/** The rule as stored in the file; the public `ProactiveRule` adds `strength` and `dueForReview`. */
export interface PrefRule {
  id: string;
  kind: ProactiveRuleKind;
  scope: ProactiveRuleScope;
  text: string;
  source: string;
  date: string;
  review?: string;
}

const SECTIONS: Record<ProactiveRuleKind, string> = { tell: 'Tell me', dont: "Don't tell me", less: 'Less of', where: 'Where and how' };
const KIND_ORDER: readonly ProactiveRuleKind[] = ['tell', 'dont', 'less', 'where'];
const HEADER = '# Proactive preferences\n\n*Rules you set, in your words or with the buttons. Change or remove them in the app.*\n';
const LINE = /^- (.+?) \| id: ([0-9a-z]+) \| scope: (topic|type|frequency) \| date: (\d{4}-\d{2}-\d{2})(?: \| review: (\d{4}-\d{2}-\d{2}))? \| source: ("(?:[^"\\]|\\.)*")$/;

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, ' ').trim().slice(0, max);

/** The rule's text as it is stored: one line, no separator characters. */
export const cleanRuleText = (text: string): string => oneLine(text.replace(/\|/g, '/'), MAX_TEXT);

export const strengthOf = (rule: PrefRule): 'never' | 'less' | undefined => (rule.kind === 'dont' ? 'never' : rule.kind === 'less' ? 'less' : undefined);

export function addDays(date: string, days: number): string {
  const at = new Date(date + 'T00:00:00Z');
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** A soft rule whose review date has come: still applied, listed for the owner to keep or delete. */
export const dueForReview = (rule: PrefRule, today: string): boolean => rule.review !== undefined && rule.review <= today;

export function toPublicRule(rule: PrefRule, today: string): ProactiveRule {
  const strength = strengthOf(rule);
  return { id: rule.id, kind: rule.kind, scope: rule.scope, ...(strength === undefined ? {} : { strength }), text: rule.text, source: rule.source, date: rule.date, ...(rule.review === undefined ? {} : { review: rule.review }), dueForReview: dueForReview(rule, today) };
}

function parseLine(line: string): PrefRule | undefined {
  const match = LINE.exec(line);
  if (match === null) return undefined;
  const [, text, id, scope, date, review, source] = match;
  let words: unknown;
  try {
    words = JSON.parse(source ?? '""');
  } catch {
    return undefined;
  }
  return { id: id ?? '', kind: 'tell', scope: scope as ProactiveRuleScope, text: text ?? '', source: typeof words === 'string' ? words : '', date: date ?? '', ...(review === undefined ? {} : { review }) };
}

/** A file written before this format: free text under "Tell me about / Never tell me about / How". Its lines become rules. */
function parseLegacy(content: string): PrefRule[] {
  const rules: PrefRule[] = [];
  let kind: ProactiveRuleKind = 'tell';
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      const title = (heading[1] ?? '').toLowerCase();
      kind = title.startsWith('never') ? 'dont' : title.startsWith('how') ? 'where' : 'tell';
      continue;
    }
    // Empty lines and the template's italic hints are not rules.
    if (line === '' || /^\*[^*].*\*$/.test(line)) continue;
    const text = cleanRuleText(line.replace(/^[-*+]\s+/, ''));
    if (text === '') continue;
    rules.push({ id: 'l' + createHash('sha1').update(kind + text).digest('hex').slice(0, 7), kind, scope: 'topic', text, source: LEGACY_SOURCE, date: LEGACY_DATE });
  }
  return rules;
}

/** The rules a file holds, and whether it was in the old free-text form (it is rewritten in this format on the next write). */
export function parseRules(content: string): { rules: PrefRule[]; legacy: boolean } {
  if (content.trim() === '') return { rules: [], legacy: false };
  if (!/^## (?:Tell me|Don't tell me|Less of|Where and how)\s*$/m.test(content)) return { rules: parseLegacy(content), legacy: true };
  const rules: PrefRule[] = [];
  let kind: ProactiveRuleKind | undefined;
  for (const line of content.split('\n')) {
    const section = /^## (.*?)\s*$/.exec(line);
    if (section !== null) {
      kind = KIND_ORDER.find((candidate) => SECTIONS[candidate] === section[1]);
      continue;
    }
    const rule = kind === undefined ? undefined : parseLine(line.trimEnd());
    if (rule !== undefined && kind !== undefined) rules.push({ ...rule, kind });
  }
  return { rules, legacy: false };
}

export function renderRules(rules: readonly PrefRule[]): string {
  const parts = [HEADER];
  for (const kind of KIND_ORDER) {
    parts.push('## ' + SECTIONS[kind]);
    for (const rule of rules.filter((candidate) => candidate.kind === kind)) {
      parts.push('- ' + rule.text + ' | id: ' + rule.id + ' | scope: ' + rule.scope + ' | date: ' + rule.date + (rule.review === undefined ? '' : ' | review: ' + rule.review) + ' | source: ' + JSON.stringify(rule.source));
    }
    parts.push('');
  }
  return parts.join('\n');
}

export interface NewRule { kind: ProactiveRuleKind; scope: ProactiveRuleScope; text: string; source: string }

/** Adds a rule; the same kind, scope and text again changes nothing and returns the one already there. */
export function addRule(rules: readonly PrefRule[], input: NewRule, today: string): { rules: PrefRule[]; rule: PrefRule; added: boolean } {
  const text = cleanRuleText(input.text);
  const existing = rules.find((rule) => rule.kind === input.kind && rule.scope === input.scope && normalizeKey(rule.text) === normalizeKey(text));
  if (existing !== undefined) return { rules: [...rules], rule: existing, added: false };
  const rule: PrefRule = {
    id: randomUUID().replace(/-/g, '').slice(0, 8), kind: input.kind, scope: input.scope, text, source: oneLine(input.source, MAX_SOURCE), date: today,
    ...(input.kind === 'less' ? { review: addDays(today, REVIEW_DAYS) } : {}),
  };
  return { rules: [...rules, rule], rule, added: true };
}

/** Keeps a soft rule: its review date moves 90 days on from today. Undefined when there is no such rule or it has no review date. */
export function keepRule(rules: readonly PrefRule[], id: string, today: string): { rules: PrefRule[]; rule: PrefRule } | undefined {
  const found = rules.find((rule) => rule.id === id);
  if (found === undefined || found.review === undefined) return undefined;
  const rule = { ...found, review: addDays(today, REVIEW_DAYS) };
  return { rules: rules.map((candidate) => (candidate.id === id ? rule : candidate)), rule };
}

const STOP_WORDS = new Set(['about', 'anything', 'tell', 'telling', 'dont', 'stop', 'never', 'more', 'less', 'news', 'again', 'update', 'updates', 'with', 'from', 'that', 'this', 'the', 'and', 'for', 'any', 'all', 'me', 'my']);

/** The words of a rule that say what it is about. */
const contentWords = (text: string): string[] => normalizeKey(text).split(' ').filter((word) => word.length >= 3 && !STOP_WORDS.has(word));

/**
 * Whether a candidate (an idea's topic, title and reason) is what a topic rule is about: every content word of the rule is in it.
 * Cheap on purpose: the model also reads the rules, this only makes a hard `never` independent of the model.
 */
export function ruleMatches(rule: PrefRule, candidate: string): boolean {
  const words = contentWords(rule.text);
  const haystack = normalizeKey(candidate);
  return words.length > 0 && words.every((word) => haystack.includes(word));
}

/** The hard rules (`dont`, about a topic or a type) that a candidate runs against, or undefined when none does. */
export function blockingRule(rules: readonly PrefRule[], candidate: string): PrefRule | undefined {
  return rules.find((rule) => rule.kind === 'dont' && rule.scope !== 'frequency' && ruleMatches(rule, candidate));
}

/** The rules as text for a wake or a job prompt; '' when there are none. */
export function rulesText(rules: readonly PrefRule[], today: string): string {
  if (rules.length === 0) return '';
  const line = (rule: PrefRule): string => '- ' + rule.text + ' (' + rule.scope + (dueForReview(rule, today) ? ', due for review: still applies' : '') + ')';
  const group = (kind: ProactiveRuleKind, title: string): string[] => {
    const own = rules.filter((rule) => rule.kind === kind);
    return own.length === 0 ? [] : [title, ...own.map(line)];
  };
  return [
    "The person's proactive preferences. These are rules they set about what you may message them about unprompted; apply them to this message:",
    ...group('dont', 'NEVER message about (hard rules, no exceptions):'),
    ...group('less', 'Much less of (send only when clearly important):'),
    ...group('tell', 'They want to hear about:'),
    ...group('where', 'Where and how to tell them:'),
  ].join('\n');
}

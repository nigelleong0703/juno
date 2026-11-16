/**
 * ALIGNMENT_SYNTHESIS.md, the learned reply style (BACKEND §5.4, §5.7.6): what the model proposes is checked by code before it is
 * written, and what is already in the file is checked again every night.
 *
 * A rule is kept only when it is about HOW to answer (kind `manner` and a facet: language, length, tone, format, punctuation, emoji,
 * stopping, asking), names no date, time or one-off event, and rests on evidence the code verified: a quote that really occurs in a
 * message the user wrote, cited by message id, or the evidence of an active memory claim. A fact about the user goes to memory (the
 * claims path decides whether it is new); a one-off task is dropped. Every rule that is dropped is reported, never silently.
 */
import { agentNameInHeading, agentSectionHeading, agentSectionId, ruleTags, splitRuleTags } from '@agent-desktop/public-contracts';
import type { MemoryEvidence } from '@agent-desktop/public-contracts';
import { z } from 'zod';
import type { MemoryClaimDoc } from '../../../contracts/memory.js';
import type { Store } from '../../../contracts/index.js';
import { normalizeClaimText, verifyEvidence } from '../evidence.js';
import { sourceItemOf } from './gather.js';
import { jsonObjectIn } from './model-json.js';

/** Bump to check every owner's stored synthesis once more at the next nightly run. */
export const ALIGNMENT_VERSION = 1;

export const KINDS = ['manner', 'fact', 'task'] as const;
/** What a manner rule is about; a rule about anything else is not a reply style. */
export const FACETS = ['language', 'length', 'tone', 'format', 'punctuation', 'emoji', 'stopping', 'asking'] as const;
/** The shortest quote (letters and digits only) that can back a rule. */
const MIN_QUOTE = 3;
const TO_CONFIRM = /^##[ \t]+to confirm[ \t]*$/i;
const LAST_UPDATED = /^\W*last updated/i;

const proposalShape = z.object({
  text: z.string().trim().min(1).max(400),
  kind: z.enum(KINDS),
  facet: z.enum(FACETS).optional(),
  /** Absent: the rule is for every agent. */
  agentId: z.string().min(1).optional(),
  claimId: z.string().min(1).optional(),
  evidence: z.array(z.object({ itemId: z.string().min(1), quote: z.string().min(1) })).default([]),
});
type RuleProposal = z.infer<typeof proposalShape>;

/** The model's answer: the rules (each still to be checked) and the things to ask the user about. Undefined when it is not that JSON. */
export function parseAlignmentAnswer(text: string): { rules: unknown[]; confirm: string[] } | undefined {
  const answer = z.object({ rules: z.array(z.unknown()), confirm: z.array(z.string()).optional() }).safeParse(jsonObjectIn(text));
  if (!answer.success) return undefined;
  return { rules: answer.data.rules, confirm: (answer.data.confirm ?? []).map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length > 0).slice(0, 8) };
}

/**
 * Words that tie a sentence to a moment or an event, not to a manner of answering: a date, a clock time, a weekday or month, "today",
 * "this time", a schedule ("every morning", "daily"). Deliberately blunt: a rule it wrongly refuses comes back the next night with a
 * better wording, a one-off task that gets in is read in every conversation.
 */
const ONE_OFF = [
  /\b\d{4}-\d{1,2}-\d{1,2}\b/, /\b\d{1,2}[:：]\d{2}\b/, /\b\d{1,2}\s?(?:am|pm)\b/i,
  /\b(?:mon|tues?|wednes|thurs?|fri|satur|sun)day\b/i, /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  /\b(?:today|tonight|tomorrow|yesterday|this time|just now|right now|once|daily|weekly|every (?:day|week|morning|evening|night)|schedule[ds]?|remind(?:er|ers|s)?)\b/i,
  /\d+\s*[点點时時号號日月]/, /(?:星期|周|礼拜)[一二三四五六日天]/, /今天|今晚|明天|昨天|刚才|这次|当天|每天|每周|每晚|每日|每个月|提醒|定时/,
];

/** Why the sentence is about a moment or an event rather than a manner of answering, or undefined. */
export const oneOffReason = (text: string): string | undefined => (ONE_OFF.some((pattern) => pattern.test(text)) ? 'names a date, a time, a schedule or a one-off event' : undefined);

export interface GateContext {
  /** The agents of the owner: a rule for any other agent is dropped. */
  agentIds: ReadonlySet<string>;
  /** Every claim of the owner by id. */
  claims: ReadonlyMap<string, MemoryClaimDoc>;
  /** Messages the user wrote, by item id (and nothing else: an assistant's text or someone else's words are not here). */
  sources: ReadonlyMap<string, string>;
}

/** A rule that passed the gate. `claimId` / `sourceId` are the evidence it rests on, written to its line. */
export interface AcceptedRule {
  text: string;
  agentId?: string;
  claimId?: string;
  sourceId?: string;
}

/** A fact about the user found among the proposed rules, with the quotes that back it: it belongs to memory. */
export interface FoundFact {
  text: string;
  evidence: MemoryEvidence[];
}

export interface Rejection {
  text: string;
  reason: string;
}

/** The evidence of an active claim that holds up against the user's own messages. */
const claimEvidence = (claim: MemoryClaimDoc | undefined, sources: ReadonlyMap<string, string>): MemoryEvidence[] =>
  claim === undefined || claim.status !== 'active' ? [] : verifyEvidence(claim.evidence, sources);

const realQuote = (entry: MemoryEvidence): boolean => normalizeClaimText(entry.quote).length >= MIN_QUOTE;

/** The ids of every message the evidence of `rules` and of `claimIds` points at: what `loadUserSources` must read before the gate runs. */
export function evidenceItemIds(rules: readonly unknown[], claims: ReadonlyMap<string, MemoryClaimDoc>): Set<string> {
  const ids = new Set<string>();
  for (const raw of rules) {
    const rule = proposalShape.safeParse(raw);
    if (!rule.success) continue;
    for (const entry of rule.data.evidence) ids.add(entry.itemId);
    for (const entry of claims.get(rule.data.claimId ?? '')?.evidence ?? []) ids.add(entry.itemId);
  }
  return ids;
}

/** The messages `ids` name that the owner wrote, by id. A missing item, an assistant's message or someone else's words are left out. */
export async function loadUserSources(store: Store, ownerId: string, ids: Iterable<string>): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const id of new Set(ids)) {
    const item = await store.get('items', id);
    const source = item === null ? undefined : sourceItemOf(item, ownerId);
    if (source?.role === 'user') sources.set(id, source.text);
  }
  return sources;
}

/** Checks the model's proposed rules. Returns the ones to write, the facts to hand to memory, and every rejection with its reason. */
export function gateRules(proposals: readonly unknown[], context: GateContext): { kept: AcceptedRule[]; facts: FoundFact[]; rejected: Rejection[] } {
  const kept: AcceptedRule[] = [];
  const facts: FoundFact[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();
  for (const raw of proposals) {
    const parsed = proposalShape.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ text: typeof (raw as { text?: unknown } | null)?.text === 'string' ? String((raw as { text: string }).text) : '(malformed rule)', reason: 'malformed' });
      continue;
    }
    const rule: RuleProposal = parsed.data;
    const claim = rule.claimId === undefined ? undefined : context.claims.get(rule.claimId);
    const reject = (reason: string): void => void rejected.push({ text: rule.text, reason });
    const evidence = [...verifyEvidence(rule.evidence, context.sources), ...claimEvidence(claim, context.sources)].filter(realQuote);
    if (rule.kind === 'task') reject('a one-off task, not a way of answering');
    else if (evidence.length === 0) reject('no quote of the user\'s own words backs it');
    else if (rule.kind === 'fact') facts.push({ text: rule.text, evidence: evidence.slice(0, 3) });
    else if (rule.facet === undefined) reject('not about language, length, tone, format, punctuation, emoji, stopping or asking');
    else if (claim?.status === 'retracted') reject('rests on a claim the user retracted');
    else if (oneOffReason(rule.text) !== undefined) reject(oneOffReason(rule.text) ?? '');
    else if (rule.agentId !== undefined && !context.agentIds.has(rule.agentId)) reject('written for an agent that does not exist');
    else if (seen.has(normalizeClaimText(rule.text) + '|' + (rule.agentId ?? ''))) reject('said twice');
    else {
      seen.add(normalizeClaimText(rule.text) + '|' + (rule.agentId ?? ''));
      const sourceId = evidence[0]?.itemId;
      kept.push({ text: rule.text, ...(rule.agentId === undefined ? {} : { agentId: rule.agentId }), ...(claim?.status === 'active' ? { claimId: claim.id } : {}), ...(sourceId === undefined ? {} : { sourceId }) });
    }
  }
  return { kept, facts, rejected };
}

/** The file as it is written: shared rules first, then one canonical section per agent that has rules, then what to confirm. */
export function renderAlignment(input: { rules: readonly AcceptedRule[]; confirm: readonly string[]; agents: ReadonlyArray<{ id: string; name: string }>; date: string }): string {
  const line = (rule: AcceptedRule): string => '- ' + rule.text.replace(/\s+/g, ' ').trim() + ruleTags(rule);
  const out = ['Last updated from ' + input.date + '.', '', ...input.rules.filter((rule) => rule.agentId === undefined).map(line)];
  for (const agent of input.agents) {
    const own = input.rules.filter((rule) => rule.agentId === agent.id);
    if (own.length > 0) out.push('', agentSectionHeading(agent.name, agent.id), ...own.map(line));
  }
  if (input.confirm.length > 0) out.push('', '## To confirm', ...input.confirm.map((entry) => '- ' + entry));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export interface CleanedAlignment {
  text: string;
  /** What was taken out or changed, one plain sentence each: the log of the cleaning. */
  changes: string[];
}

/**
 * Gives every non-canonical agent heading its canonical form when exactly one of the owner's agents has that display name, and drops the
 * section (heading and lines) when none or several do: whose it is cannot be told, so it must not reach every agent.
 */
function canonicalHeadings(lines: readonly string[], agents: ReadonlyArray<{ id: string; name: string }>, changes: string[]): string[] {
  const out: string[] = [];
  let dropping = false;
  for (const raw of lines) {
    if (raw.startsWith('## ')) {
      dropping = false;
      const wanted = agentNameInHeading(raw) ?? (agentSectionId(raw) === undefined ? raw.slice(3).trim().replace(/^["'“”「『]+|["'“”」』]+$/g, '') : undefined);
      const matches = wanted === undefined ? [] : agents.filter((agent) => agent.name.trim().toLowerCase() === wanted.toLowerCase());
      const named = agentNameInHeading(raw) !== undefined;
      if (matches.length === 1 && matches[0] !== undefined && wanted !== undefined) {
        const heading = agentSectionHeading(matches[0].name, matches[0].id);
        if (heading !== raw) changes.push('Renamed the section "' + raw.slice(3) + '" to "' + heading.slice(3) + '" so it reaches only that agent.');
        out.push(heading);
        continue;
      }
      if (named || matches.length > 1) {
        changes.push('Removed the section "' + raw.slice(3) + '": it names an agent without saying which one (' + (matches.length > 1 ? 'several agents have that name' : 'no agent has that name') + ').');
        dropping = true;
        continue;
      }
    }
    if (!dropping) out.push(raw);
  }
  return out;
}

/**
 * Checks what is already in the file, line by line, with the same rules as a new proposal (but without the model's classification):
 * a rule stays only when it names no date or one-off event and rests on a live claim or a message the user wrote (`[claim:…]`, `[src:…]`).
 * Sections of agents that no longer exist go too. `sources` must hold the messages `evidenceItemIdsOfFile` named.
 */
export function cleanAlignment(text: string, input: { agents: ReadonlyArray<{ id: string; name: string }>; claims: ReadonlyMap<string, MemoryClaimDoc>; sources: ReadonlyMap<string, string> }): CleanedAlignment {
  const changes: string[] = [];
  const agentIds = new Set(input.agents.map((agent) => agent.id));
  const out: string[] = [];
  let live = true;
  let confirming = false;
  for (const raw of canonicalHeadings(text.split('\n'), input.agents, changes)) {
    if (raw.startsWith('#')) {
      const id = agentSectionId(raw);
      live = id === undefined || agentIds.has(id);
      confirming = TO_CONFIRM.test(raw);
      if (!live) changes.push('Removed the section "' + raw.replace(/^#+\s*/, '') + '": that agent no longer exists.');
      else out.push(raw);
      continue;
    }
    if (!live) continue;
    const { text: rule, claimId, sourceId } = splitRuleTags(raw.replace(/^\s*[-*]\s+/, ''));
    if (rule === '' || confirming || LAST_UPDATED.test(rule)) {
      out.push(raw);
      continue;
    }
    const claim = claimId === undefined ? undefined : input.claims.get(claimId);
    const backed = (sourceId !== undefined && input.sources.has(sourceId)) || claimEvidence(claim, input.sources).some(realQuote);
    const reason = claim?.status === 'retracted' ? 'it rests on a claim the user retracted'
      : oneOffReason(rule) !== undefined ? 'it ' + (oneOffReason(rule) ?? '')
        : backed ? undefined : 'no message of the user backs it';
    if (reason === undefined) out.push(raw);
    else changes.push('Removed from the reply style: "' + rule + '" (' + reason + ').');
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', changes };
}

/** The ids of the messages the lines of `text` rest on, directly or through a claim: what `loadUserSources` must read before `cleanAlignment`. */
export function evidenceItemIdsOfFile(text: string, claims: ReadonlyMap<string, MemoryClaimDoc>): Set<string> {
  const ids = new Set<string>();
  for (const raw of text.split('\n')) {
    const { claimId, sourceId } = splitRuleTags(raw);
    if (sourceId !== undefined) ids.add(sourceId);
    for (const entry of claims.get(claimId ?? '')?.evidence ?? []) ids.add(entry.itemId);
  }
  return ids;
}

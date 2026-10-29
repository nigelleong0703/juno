/**
 * Relations between people from the chat digest (BACKEND §9.6, batch 7). A memory claim of the digest's answer may carry a statement of
 * the form "a is <kind> of b" (its `relation`); `applyClaims` cites it to the claim's own quote and passes it here. The code checks the
 * quote against its message (the model's word is not enough), resolves both names
 * to people, and records the statement (`memory.relations.record` normalises the wording and keeps the trust rules). The owner's word is
 * confirmed; anyone else's is not. A name that does not resolve, or that matches more than one person, drops the relation. Only the
 * owner's own word may make a person the digest does not know yet. Relations are knowledge only: nothing grants a permission on them.
 */
import { z } from 'zod';
import { normalizeStatement } from '@agent-desktop/memory-graph/relations';
import { displayName, nameKey } from '../people/names.js';
import { verifyEvidence } from './evidence.js';
import type { KnownPerson } from './notes.js';
import type { ClaimsContext } from './jobs/claims.js';
import type { SourceItem } from './jobs/gather.js';
import type { ClaimDeps } from './jobs/types.js';

/** A relation as a claim states it: a is <kind> of b (the digest's `relation` field, BACKEND §9.6). */
export const statementSchema = z.object({
  a: z.string().trim().min(1).max(120),
  kind: z.string().trim().min(1).max(60),
  b: z.string().trim().min(1).max(120),
});
export type Statement = z.infer<typeof statementSchema>;

const relationSchema = statementSchema.extend({
  itemId: z.string().min(1),
  quote: z.string().min(1),
});

/** "owner" names the owner whoever is speaking. */
const OWNER_WORD = 'owner';
/** First-person words name whoever is speaking: the owner, or the other person who wrote the message. */
const FIRST_PERSON: ReadonlySet<string> = new Set(['me', 'i', 'myself']);

/** Who wrote the message a relation is quoted from. */
export interface Speaker {
  /** The owner wrote it (role `user`). */
  ownerWord: boolean;
  /** The person of the speaker, when another sender has one; null otherwise. */
  personId: string | null;
  /** The owner's own person; null only if the owner has none (then the owner cannot be named). */
  ownerPersonId: string | null;
}

export type NameResolution =
  | { kind: 'person'; personId: string }
  /** The owner's word names someone the digest does not know yet: a person is made for them once the whole relation is resolved. */
  | { kind: 'create'; name: string }
  | { kind: 'missing'; reason: string };

/**
 * One name of a statement, resolved the way the people pages resolve a person (`personFor`): by id, or by an exact name that only one
 * person has. Nothing is guessed: no match from anyone but the owner is dropped, and so is a name several people share.
 */
export function resolveName(name: string, people: readonly KnownPerson[], speaker: Speaker): NameResolution {
  const raw = name.trim();
  const lower = raw.toLowerCase();
  if (raw === '') return { kind: 'missing', reason: 'a relation with an empty name' };
  if (lower === OWNER_WORD || (FIRST_PERSON.has(lower) && speaker.ownerWord)) {
    return speaker.ownerPersonId === null ? { kind: 'missing', reason: 'the owner has no person to name' } : { kind: 'person', personId: speaker.ownerPersonId };
  }
  if (FIRST_PERSON.has(lower)) {
    return speaker.personId === null ? { kind: 'missing', reason: `${raw} is not a person yet` } : { kind: 'person', personId: speaker.personId };
  }
  const byId = /^per_/i.test(raw);
  // Names match as person_lookup matches them: case, spacing and a possessive do not count ("Priya's" is Priya).
  const key = nameKey(raw);
  const matches = byId ? people.filter((person) => person.id.startsWith(lower)) : people.filter((person) => nameKey(person.name) === key);
  if (matches.length === 1) return { kind: 'person', personId: matches[0]!.id };
  if (matches.length > 1) return { kind: 'missing', reason: `more than one person is called ${raw}` };
  return speaker.ownerWord && !byId ? { kind: 'create', name: displayName(raw) } : { kind: 'missing', reason: `no person is called ${raw}` };
}

/**
 * Whether one end of a relation is written in the claim: its text or the quote it cites, as a whole word (case and possessive aside).
 * The owner words name the owner, who a claim need not spell out; an id names the person it stands for.
 */
function namedIn(name: string, text: string, quote: string, people: readonly KnownPerson[]): boolean {
  const raw = name.trim();
  const lower = raw.toLowerCase();
  if (lower === OWNER_WORD || FIRST_PERSON.has(lower)) return true;
  const shown = /^per_/i.test(raw) ? people.find((person) => person.id.startsWith(lower))?.name : raw;
  const key = shown === undefined ? '' : nameKey(shown);
  if (key === '') return false;
  const word = new RegExp('(?<![\\p{L}\\p{N}])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'iu');
  return word.test(text) || word.test(quote);
}

/** True when both ends of a relation are written in the claim's text or in the quote it cites (`namedIn`). */
export function relationNamed(statement: Statement, text: string, quote: string, people: readonly KnownPerson[]): boolean {
  return namedIn(statement.a, text, quote, people) && namedIn(statement.b, text, quote, people);
}

export interface RelationsResult {
  /** Relations newly recorded (an already open one does not count). */
  accepted: number;
  /** The receipt lines: what was written, and what was dropped and why. */
  lines: string[];
}

/** Checks each stated relation and records the ones that hold up. `input.relations` is the digest's raw list, validated here. */
export async function applyRelations(deps: ClaimDeps, input: { ownerId: string; items: readonly SourceItem[]; relations: readonly unknown[]; context: ClaimsContext }): Promise<RelationsResult> {
  const { ownerId, items, context } = input;
  const { relations } = deps.memory;
  const lines: string[] = [];
  let accepted = 0;
  // A quote can come from a message people wrote; an assistant's text is context only and never evidence (as for claims).
  const sources = new Map(items.filter((item) => item.role !== 'agent').map((item): [string, string] => [item.id, item.text]));
  const byId = new Map(items.map((item): [string, SourceItem] => [item.id, item]));
  const people = context.knownPeople;
  const drop = (label: string, reason: string): void => {
    lines.push('Rejected relation ' + label + ': ' + reason);
    deps.log?.({ ownerId, reason }, 'chat digest: dropped a relation');
  };

  for (const raw of input.relations) {
    const parsed = relationSchema.safeParse(raw);
    if (!parsed.success) {
      lines.push('Rejected a relation: malformed');
      continue;
    }
    const { a, kind, b, itemId, quote } = parsed.data;
    const label = `${a} ${kind} ${b}`;
    const item = byId.get(itemId);
    if (item === undefined || verifyEvidence([{ itemId, quote }], sources).length === 0) {
      drop(label, 'the quote is not in its message');
      continue;
    }
    if (item.role === 'agent') {
      drop(label, 'an assistant message cannot back a relation');
      continue;
    }
    const statement = normalizeStatement({ a, kind, b });
    if (statement === undefined) {
      drop(label, 'no relation wording');
      continue;
    }
    const ownerWord = item.role === 'user';
    const personId = ownerWord ? context.ownerPersonId : context.senders.personOf.get(item.id) ?? null;
    const speaker: Speaker = { ownerWord, personId, ownerPersonId: context.ownerPersonId };
    const left = resolveName(statement.a, people, speaker);
    const right = resolveName(statement.b, people, speaker);
    const failed = [left, right].find((side): side is { kind: 'missing'; reason: string } => side.kind === 'missing');
    if (failed !== undefined) {
      drop(label, failed.reason);
      continue;
    }
    // The same person (or the same new name) on both ends is not a relation.
    const sameEnd = left.kind === 'person' && right.kind === 'person' ? left.personId === right.personId
      : left.kind === 'create' && right.kind === 'create' ? left.name.toLowerCase() === right.name.toLowerCase()
        : false;
    if (sameEnd) {
      drop(label, 'a relation needs two different people');
      continue;
    }

    // Nothing is made until both names are known: a person is created here, only for the owner's word.
    const ends: string[] = [];
    for (const side of [left, right]) {
      if (side.kind === 'person') {
        ends.push(side.personId);
        continue;
      }
      if (side.kind !== 'create') continue;
      const made = await deps.memory.identity.createPerson(ownerId, side.name);
      people.push({ id: made.id, name: made.name });
      ends.push(made.id);
    }
    const [personA, personB] = ends;
    if (personA === undefined || personB === undefined) continue;

    try {
      const outcome = await relations.record(ownerId, {
        a: personA,
        kind: statement.kind,
        b: personB,
        kindLabel: statement.kindLabel,
        evidence: { itemId, quote: quote.trim() },
        saidByPersonId: personId,
        saidByAccountId: ownerWord ? null : context.senders.senderOf.get(item.id)?.accountId ?? null,
        confirmed: ownerWord,
      });
      if (outcome.outcome === 'refused') drop(label, outcome.reason);
      if (outcome.outcome === 'added') {
        accepted += 1;
        const closed = outcome.closed.length === 0 ? '' : ` (closed ${String(outcome.closed.length)} older)`;
        lines.push(`Wrote relation ${statement.a} ${statement.kind} ${statement.b}${ownerWord ? ' (confirmed by the owner)' : ' (not confirmed)'}${closed}`);
      }
    } catch (error) {
      drop(label, error instanceof Error ? error.message : 'the relation could not be stored');
    }
  }
  return { accepted, lines };
}

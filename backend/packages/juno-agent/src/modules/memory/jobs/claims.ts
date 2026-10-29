/**
 * The memory claims of a chat digest (BACKEND §5.4): the digest's model answer lists the claims it found in the new messages; the code
 * then checks every quote against its source, drops what the user has retracted, and writes the survivors as memory items. The views
 * (MEMORY.md, the bank, the people pages) are then rendered from the items.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Account, AccountInput } from '@agent-desktop/memory-graph/identity';
import type { ItemFile, ItemKind, ItemTopic, MemoryItem } from '@agent-desktop/memory-graph/memory';
import type { MemoryClaimDoc } from '../../../contracts/memory.js';
import { channelRowId } from '../../../contracts/storage.js';
import { MEMORY_FILE } from '../../home/paths.js';
import { PEOPLE_PREFIX, pagePath, shortPersonId } from '../../people/pages.js';
import { LOG_SOURCE_PREFIX, repeatsRetracted, repeatsText, verifyEvidence } from '../evidence.js';
import { ensureOwnerPerson } from '../owner.js';
import { personFor, placeOf, type KnownPerson } from '../notes.js';
import { relationNamed, statementSchema, type Statement } from '../relations.js';
import { rankItems } from '../search.js';
import { listAll } from '../util.js';
import { renderViews } from '../views.js';
import { topicSchema } from '../wording.js';
import type { SourceItem } from './gather.js';
import type { ClaimDeps } from './types.js';

/** Claims the model is less sure of than this are not written. */
const MIN_CONFIDENCE = 0.5;
/** Existing items shown to the model so it can say a new fact is already there (the closest to the conversation; all of them when there are few). */
const SHOWN_ITEMS = 15;
/** Characters of the conversation the closest existing items are searched for. */
const QUERY_CHARS = 3_000;
const BANK_ITEM = {
  circumstances: { file: 'bank:circumstances', kind: 'circumstance' },
  experiences: { file: 'bank:experiences', kind: 'experience' },
  preferences: { file: 'bank:preferences', kind: 'preference' },
} as const satisfies Record<string, { file: ItemFile; kind: ItemKind }>;
type BankName = keyof typeof BANK_ITEM;
const isBank = (name: string): name is BankName => Object.hasOwn(BANK_ITEM, name);
/** People listed to the model at most (the rest cannot be targeted by a digest). */
const MAX_PEOPLE_SHOWN = 200;

const claimSchema = z.object({
  text: z.string().trim().min(1).max(500),
  evidence: z.array(z.object({ itemId: z.string().min(1), quote: z.string().min(1) })).min(1),
  confidence: z.number().min(0).max(1),
  target: z.string().trim().min(1),
  /** Against the existing items shown: the id of the one that says the same (this fact is not written), or of the one this fact replaces. Neither: it is new. */
  sameAs: z.string().optional(),
  supersedes: z.string().optional(),
  /** A topic the model invented is dropped, not the claim: the nightly tidy sorts the item. */
  topic: topicSchema.optional().catch(undefined),
  forAgent: z.string().optional(),
  /** Why this is a lasting fact: `explicit` (the user said "I prefer…", "always…", "don't…"), `pattern` (seen in 2+ separate conversations) or `request` (one task they asked for). */
  basis: z.enum(['explicit', 'pattern', 'request']).optional(),
  /** How two people in the claim are related ("a is <kind> of b"): recorded as a relation, cited to this claim's own quote (BACKEND §9.6). */
  relation: statementSchema.optional(),
});

/** Targets that hold what the user is like, not what they asked for: a one-off request never lands here. */
const PROFILE_TARGETS = new Set(['preferences', 'circumstances']);
/** Days a profile claim can go without being seen again before the nightly job lets it expire. */
export const STALE_DAYS = 30;

const CHAT_PLATFORMS = ['telegram', 'slack', 'discord', 'feishu'] as const;

/** Who each other sender is for the prompt and for evidence: the person's id when they have one, else their account (or nothing). */
export interface SenderLookup {
  /** "Bob (per_3f2a1b2c)", or "Bob (account acc_xxxxxxxx, no person yet)": the text after "OTHER SENDER" for each `other` item. */
  labels: Map<string, string>;
  /** The person of each `other` item whose sender has one. */
  personOf: Map<string, string>;
  /** Each `other` item's sender as an account (what a person is made from when a claim about them is backed by their own words), and its account id when it exists. */
  senderOf: Map<string, { input: AccountInput; accountId?: string }>;
}

const plainName = (name: string): string => name.replace(/[\]\r\n()]/g, ' ').trim().slice(0, 80) || 'someone';

/**
 * Looks up the account of each other sender the way the ingress recorded it: a Slack sender's workspace is its channel's team, the other
 * platforms have none. Owner-scoped (the job runs in the owner's scope), so a channel of another owner is never read.
 */
async function senderLookup(deps: ClaimDeps, ownerId: string, items: readonly SourceItem[]): Promise<SenderLookup> {
  const labels = new Map<string, string>();
  const personOf = new Map<string, string>();
  const senderOf = new Map<string, { input: AccountInput; accountId?: string }>();
  const teams = new Map<string, string>();
  const accounts = new Map<string, Account | undefined>();
  for (const item of items) {
    const { from } = item;
    if (item.role !== 'other' || from === undefined) continue;
    const platform = CHAT_PLATFORMS.find((candidate) => candidate === from.kind);
    let workspace = '';
    if (platform === 'slack' && from.channelId !== undefined) {
      const channelKey = channelRowId(from.kind, from.channelId);
      if (!teams.has(channelKey)) {
        const row = await deps.store.get('channels', channelKey);
        teams.set(channelKey, row?.ownerId === ownerId ? row.teamId ?? '' : '');
      }
      workspace = teams.get(channelKey) ?? '';
    }
    const key = [from.kind, workspace, from.externalId].join('|');
    if (!accounts.has(key)) {
      accounts.set(key, platform === undefined ? undefined : await deps.memory.identity.findAccount(ownerId, { platform, workspace, externalId: from.externalId }));
    }
    const account = accounts.get(key);
    if (platform !== undefined) {
      senderOf.set(item.id, { input: { platform, workspace, externalId: from.externalId, name: from.name }, ...(account === undefined ? {} : { accountId: account.id }) });
    }
    const name = plainName(from.name);
    if (account?.personId) {
      personOf.set(item.id, account.personId);
      labels.set(item.id, `${name} (${shortPersonId(account.personId)})`);
    } else {
      labels.set(item.id, account === undefined ? `${name} (no person yet)` : `${name} (account ${account.id.slice(0, 12)}, no person yet)`);
    }
  }
  return { labels, personOf, senderOf };
}

function renderSources(items: readonly SourceItem[], labels: ReadonlyMap<string, string>): string {
  return '## New messages\n' + items.map((item) => {
    const who = item.role === 'other' ? 'OTHER SENDER ' + (labels.get(item.id) ?? '(no person yet)') : item.role === 'user' ? 'USER' : 'ASSISTANT (context only)';
    return '[' + item.id + '] ' + who + ' ' + item.at + ': ' + item.text;
  }).join('\n');
}

/** Where a claim's target is kept: the view it renders into, the item file and kind it becomes, and the person it is about. */
export interface TargetPlace {
  path: string;
  file: ItemFile;
  kind: ItemKind;
  personId?: string;
}

export function targetFile(target: string, people: readonly KnownPerson[] = []): TargetPlace | undefined {
  const key = target.trim().toLowerCase();
  if (key === 'memory' || key === 'memory.md') return { path: MEMORY_FILE, file: 'memory', kind: 'fact' };
  if (isBank(key)) return { path: 'memory/bank/' + key + '.md', file: BANK_ITEM[key].file, kind: BANK_ITEM[key].kind };
  const ref = /^(?:person|people):\s*(.+)$/i.exec(target.trim())?.[1]?.trim();
  const person = ref === undefined ? undefined : personFor(ref, people);
  return person === undefined ? undefined : { path: pagePath(person.id), file: 'person', kind: 'fact', personId: person.id };
}

/** The memory as it stands and the people and assistants a claim may name: what the claims are checked against. */
export interface ClaimsContext {
  active: MemoryClaimDoc[];
  retracted: MemoryClaimDoc[];
  knownPeople: KnownPerson[];
  ownerPersonId: string | null;
  senders: SenderLookup;
  agents: ReadonlyArray<{ id: string; name: string }>;
}

/**
 * The existing items a digest's model is shown so it does not write what is already there: the ones closest to the conversation (the same
 * hybrid search as memory_search: words, and vectors when an embedder is set), from any source, or all of them when there are few. Only
 * items of the audience the chat's own items get (and not an agent's private ones): the digest never replaces an item of another audience.
 */
async function closestItems(deps: ClaimDeps, ownerId: string, items: readonly SourceItem[]): Promise<MemoryItem[]> {
  const first = items[0];
  if (first === undefined) return [];
  const place = await placeOf(deps.store, ownerId, first.conversationId);
  const embedder = deps.memory.embedder;
  const comparable = (await deps.memory.items.memoryFor(ownerId, { kind: 'owner' }, undefined, { vectors: embedder !== undefined }))
    .filter((item) => item.audience === place.audience && item.agentId === null);
  if (comparable.length <= SHOWN_ITEMS) return comparable;
  const said = items.filter((item) => item.role !== 'agent').map((item) => item.text).join('\n').slice(-QUERY_CHARS);
  return (await rankItems(embedder, comparable, said, SHOWN_ITEMS)).map((hit) => hit.item);
}

/** The new messages, the closest existing items, the assistants and the people, as the digest's prompt shows them, and the context to check against. */
export async function readClaimsContext(deps: ClaimDeps, input: { ownerId: string; items: readonly SourceItem[]; agents: ReadonlyArray<{ id: string; name: string }> }): Promise<{ context: ClaimsContext; prompt: string }> {
  const { store, memory } = deps;
  const { ownerId, items, agents } = input;
  const claims = (await listAll(store, 'memoryClaims')).filter((claim) => claim.ownerId === ownerId);
  const active = claims.filter((claim) => claim.status === 'active');
  const retracted = claims.filter((claim) => claim.status === 'retracted');
  const ownerPersonId: string | null = (await ensureOwnerPerson(memory, store, ownerId)).id;
  const people = await memory.identity.listPeople(ownerId);
  const knownPeople: KnownPerson[] = people.map((person) => ({ id: person.id, name: person.name }));
  const senders = await senderLookup(deps, ownerId, items);
  const shown = await closestItems(deps, ownerId, items);
  const aboutOf = (item: MemoryItem): string => (item.aboutPersonId === null || item.aboutPersonId === ownerPersonId ? 'the person being helped' : knownPeople.find((person) => person.id === item.aboutPersonId)?.name ?? 'someone');
  const prompt = [
    renderSources(items, senders.labels),
    '## Existing memory: the items closest to this conversation (id | about | text). Say for each new fact whether one of these already says it\n'
      + (shown.map((item) => item.id + ' | ' + aboutOf(item) + ' | ' + item.text.replace(/\s+/g, ' ').trim()).join('\n') || '(none)'),
    '## Assistants (id: name)\n' + (agents.map((agent) => agent.id + ': ' + agent.name).join('\n') || '(none)'),
    '## People (id: name): the only people a "person:<personId>" target can name\n' + (knownPeople.slice(0, MAX_PEOPLE_SHOWN).map((person) => shortPersonId(person.id) + ': ' + person.name).join('\n') || '(none)'),
  ].join('\n\n');
  return { context: { active, retracted, knownPeople, ownerPersonId, senders, agents }, prompt };
}

/** Where an accepted claim goes: its target, the person it is about, and the agent whose section of a person's page it belongs to. */
interface Accepted {
  claim: MemoryClaimDoc;
  place: TargetPlace;
  /** The person the item is about: the target's person, or the owner for the owner's own facts. */
  aboutPersonId: string | null;
  /** The agent whose own section of a person's page the claim belongs to. */
  agentId?: string;
  topic?: ItemTopic;
  /** The existing item this claim replaces (the model said `supersedes`); it is retracted when the claim is written. */
  replacesItemId?: string;
  /** The relation the claim states, cited to the quote that backs it. */
  cited?: Statement & { itemId: string; quote: string };
}

const uniqueEvidence = (all: MemoryClaimDoc['evidence']): MemoryClaimDoc['evidence'] => all.filter((entry, i) => all.findIndex((other) => other.itemId === entry.itemId && other.quote === entry.quote) === i);

export interface ClaimsResult {
  /** Claims written as items. */
  accepted: number;
  /** Claims that state a relation, accepted or not. */
  relationsProposed: number;
  /** The relations of the accepted claims, each cited to its quote; `applyRelations` records them. */
  relations: Array<Statement & { itemId: string; quote: string }>;
  /** The receipt lines: what was written and what was refused, and why. */
  lines: string[];
}

/**
 * Checks the claims of one digest's answer against the messages they quote and writes the ones that pass (BACKEND §5.4, steps 3–4):
 * quotes must be the owner's own words (or a person's own words, for a person's page), the target must exist, and a claim the user
 * retracted or already has is not written again. A claim's `relation` must name both of its people in the claim's text or its quote, and is
 * returned cited to that quote for `applyRelations`.
 */
export async function applyClaims(deps: ClaimDeps, input: { ownerId: string; agentId: string; items: readonly SourceItem[]; claims: readonly unknown[]; context: ClaimsContext; now: Date }): Promise<ClaimsResult> {
  const { store } = deps;
  const { ownerId, agentId, items, context, now } = input;
  const { active, retracted, knownPeople, ownerPersonId, senders } = context;
  // The user's own words and other senders' words (people pages only) can back a claim. Assistant text is an assistant's paraphrase:
  // it was shown as context and is never evidence (BACKEND §5.4).
  const foreign = new Set(items.filter((item) => item.role === 'other').map((item) => item.id));
  // A sender with no person yet backs nothing, unless linkSender makes their person (their own words, about them).
  const unlinked = new Set(items.filter((item) => item.role === 'other' && !senders.personOf.has(item.id)).map((item) => item.id));
  const sources = new Map<string, string>(items.filter((item) => item.role !== 'agent').map((item): [string, string] => [item.id, item.text]));
  const roleOf = new Map(items.map((item): [string, SourceItem['role']] => [item.id, item.role]));
  /**
   * A sender with no person yet, whose own words back a claim the target names them in: their account gets its person now, so the claim
   * can be written on their page. The evidence rule is unchanged (the quote must be theirs and in the message); a claim that quotes two
   * senders, or names someone else, does nothing here. (BACKEND §5.4: "a sender with no person yet backs nothing" is now "backs
   * nothing until a person is made for a sender who names themselves".)
   */
  const linkSender = async (rawTarget: string, verified: ReadonlyArray<{ itemId: string }>): Promise<void> => {
    const named = /^(?:person|people):\s*(.+)$/i.exec(rawTarget.trim())?.[1]?.trim();
    const senderIds = [...new Set(verified.filter((entry) => roleOf.get(entry.itemId) === 'other').map((entry) => entry.itemId))];
    const id = senderIds.length === 1 ? senderIds[0] : undefined;
    if (named === undefined || id === undefined || !unlinked.has(id)) return;
    const sender = senders.senderOf.get(id);
    if (sender === undefined) return;
    const lower = named.toLowerCase();
    const isSender = lower === (sender.input.name ?? '').trim().toLowerCase()
      || (sender.accountId !== undefined && lower.startsWith('acc_') && sender.accountId.startsWith(lower));
    // Someone already called that name is another person: the claim is not theirs to make.
    if (!isSender || knownPeople.some((person) => person.name.trim().toLowerCase() === lower)) return;
    const seen = await deps.memory.identity.upsertAccount(ownerId, sender.input, { createPerson: true });
    if (seen.person === undefined) return;
    knownPeople.push({ id: seen.person.id, name: seen.person.name });
    senders.personOf.set(id, seen.person.id);
    unlinked.delete(id);
  };
  const accepted: Accepted[] = [];
  const rejections: string[] = [];
  const reinforced = new Map<string, MemoryClaimDoc['evidence']>();
  /** Existing items a new fact was found to say already: they gain the new evidence and count as seen again. */
  const seenAgain = new Map<string, MemoryClaimDoc['evidence']>();
  const stamp = now.toISOString();
  let relationsProposed = 0;
  const conversationOf = new Map(items.map((item): [string, string] => [item.id, item.conversationId]));
  const audiences = new Map<string, string>();
  /** Who may hear what a conversation says (the audience its items get). */
  const audienceOf = async (itemId: string | undefined): Promise<string | undefined> => {
    const conversationId = itemId === undefined ? undefined : conversationOf.get(itemId);
    if (conversationId === undefined) return undefined;
    if (!audiences.has(conversationId)) audiences.set(conversationId, (await placeOf(store, ownerId, conversationId)).audience);
    return audiences.get(conversationId);
  };
  for (const raw of input.claims) {
    const claim = claimSchema.safeParse(raw);
    if (!claim.success) {
      rejections.push('malformed claim');
      continue;
    }
    const { text, confidence, supersedes, relation } = claim.data;
    if (relation !== undefined) relationsProposed += 1;
    let target = targetFile(claim.data.target, knownPeople);
    const verified = verifyEvidence(claim.data.evidence, sources);
    await linkSender(claim.data.target, verified);
    target ??= targetFile(claim.data.target, knownPeople);
    // A person the owner names ("my wife Lily loves sushi") gets a page even without an account: when no one of that name is known and
    // the owner's own message backs the claim, the person is created below, once the claim is accepted. Several people of that name: dropped.
    const named = /^(?:person|people):\s*(.+)$/i.exec(claim.data.target.trim())?.[1]?.trim();
    const ownerNamed = named !== undefined && !/^per_/i.test(named) && verified.some((entry) => roleOf.get(entry.itemId) === 'user');
    const sameName = named === undefined ? [] : knownPeople.filter((person) => person.name.trim().toLowerCase() === named.toLowerCase());
    const creating = target === undefined && ownerNamed && sameName.length === 0;
    // Someone who is not the owner may only feed a people page, never the owner's own memory; and only a sender with a person does.
    const fresh = (target?.path.startsWith(PEOPLE_PREFIX) === true ? verified : verified.filter((entry) => !foreign.has(entry.itemId))).filter((entry) => !unlinked.has(entry.itemId));
    const findAgent = (): { id: string; name: string } | undefined => (target?.path.startsWith(PEOPLE_PREFIX) === true ? context.agents.find((candidate) => candidate.id === claim.data.forAgent) : undefined);
    let agent = findAgent();
    // An existing item the model named (it says the same, or this fact replaces it) counts only when it is the same person's, for the same
    // audience and agent: a fact said in a group never replaces or merges into what the owner said alone, nor the other way round.
    const existingItem = async (id: string | undefined): Promise<MemoryItem | undefined> => {
      if (id === undefined || target === undefined) return undefined;
      const found = await deps.memory.items.getItem(ownerId, id);
      const about = target.personId ?? (target.file === 'person' ? null : ownerPersonId);
      if (found?.status === 'active' && found.audience === await audienceOf(fresh[0]?.itemId) && found.aboutPersonId === about && found.agentId === (agent?.id ?? null)) return found;
      deps.log?.({ ownerId, id }, 'chat digest: the item the model named is not this fact\'s to match, written as new');
      return undefined;
    };
    const same = await existingItem(claim.data.sameAs);
    const replacedItem = same === undefined ? await existingItem(supersedes) : undefined;
    const replaced = replacedItem?.claimId == null ? undefined : active.find((entry) => entry.id === replacedItem.claimId);
    // A merged claim keeps the evidence of the claim (or the item) it replaces.
    const keptEvidence = replaced?.evidence ?? replacedItem?.evidence ?? [];
    const evidence = [...(fresh.length === 0 ? [] : keptEvidence.filter((old) => !fresh.some((now) => now.itemId === old.itemId))), ...fresh];
    // A relation is cited to the claim's own verified quote: the first one that, with the claim's text, names both of its people.
    const cited = relation === undefined ? undefined : verified.find((entry) => relationNamed(relation, text, entry.quote, knownPeople)) ?? verified[0];
    const unnamed = relation !== undefined && (cited === undefined || !relationNamed(relation, text, cited.quote, knownPeople));
    const profile = target !== undefined && PROFILE_TARGETS.has(claim.data.target.trim().toLowerCase());
    const conversations = new Set(evidence.map((entry) => items.find((item) => item.id === entry.itemId)?.conversationId ?? entry.itemId));
    const reason = confidence < MIN_CONFIDENCE ? 'confidence ' + String(confidence)
      : profile && claim.data.basis !== 'explicit' && !(claim.data.basis === 'pattern' && conversations.size >= 2) ? 'a one-off request or a single sighting is activity, not a ' + claim.data.target.trim().toLowerCase().replace(/s$/, '')
      : evidence.length === 0 ? (verified.some((entry) => unlinked.has(entry.itemId)) ? 'the sender has no person yet' : verified.length > 0 ? 'only a sender who is not the user backs it' : claim.data.evidence.some((entry) => entry.itemId.startsWith(LOG_SOURCE_PREFIX)) ? 'a daily-log note is not evidence; quote the user\'s own message' : 'the quote is not in its source')
        : unnamed ? 'the relation names someone the claim does not mention'
          : target === undefined && !creating ? (sameName.length > 1 ? 'more than one person is called ' + String(named) : 'unknown target ' + claim.data.target)
          : repeatsRetracted({ text, evidence }, retracted) ? 'the user retracted this'
            : repeatsText({ text, evidence }, [...active, ...accepted.map((entry) => entry.claim)]) ? 'already known'
              : same !== undefined ? 'already known (same as ' + same.id + ')'
                : undefined;
    if (reason === undefined && creating) {
      const person = await deps.memory.identity.createPerson(ownerId, named ?? '');
      knownPeople.push({ id: person.id, name: person.name });
      target = { path: pagePath(person.id), file: 'person', kind: 'fact', personId: person.id };
      agent = findAgent();
    }
    if (reason === 'already known') {
      // Seen again: the known claim is reinforced (so it does not go stale) and gains the new evidence.
      const known = active.find((entry) => repeatsText({ text, evidence }, [entry]));
      if (known !== undefined) reinforced.set(known.id, [...(reinforced.get(known.id) ?? known.evidence), ...fresh]);
    }
    if (same !== undefined && reason?.startsWith('already known') === true) seenAgain.set(same.id, [...(seenAgain.get(same.id) ?? []), ...fresh]);
    if (target === undefined && !creating && /^(?:person|people):/i.test(claim.data.target.trim())) {
      deps.log?.({ ownerId, target: claim.data.target }, 'chat digest: dropped a claim about a person it cannot name');
    }
    if (unnamed) deps.log?.({ ownerId, target: claim.data.target }, 'chat digest: dropped a relation its claim does not name');
    if (reason !== undefined || target === undefined) {
      rejections.push((reason ?? 'rejected') + ': ' + text);
      continue;
    }
    accepted.push({
      claim: {
        id: 'clm_' + randomUUID().replace(/-/g, '').slice(0, 12), ownerId, text, evidence, confidence, status: 'active',
        ...(replaced === undefined ? {} : { supersedesClaimId: replaced.id }),
        target: { path: target.path }, createdAt: stamp, updatedAt: stamp,
      },
      place: target,
      aboutPersonId: target.personId ?? (target.file === 'person' ? null : ownerPersonId),
      ...(agent === undefined ? {} : { agentId: agent.id }),
      ...(claim.data.topic === undefined ? {} : { topic: claim.data.topic }),
      ...(replacedItem === undefined ? {} : { replacesItemId: replacedItem.id }),
      ...(relation === undefined || cited === undefined ? {} : { cited: { ...relation, itemId: cited.itemId, quote: cited.quote } }),
    });
  }

  for (const [id, seen] of reinforced) {
    const known = active.find((entry) => entry.id === id);
    if (known === undefined) continue;
    const kept = seen.filter((entry, i) => seen.findIndex((other) => other.itemId === entry.itemId && other.quote === entry.quote) === i);
    await store.put('memoryClaims', { ...known, evidence: kept, updatedAt: stamp }, { status: 'active' });
  }
  for (const [id, seen] of seenAgain) {
    const found = await deps.memory.items.getItem(ownerId, id);
    if (found === undefined) continue;
    const merged = uniqueEvidence([...(found.evidence ?? []), ...seen]);
    // Touching the item (its evidence is written again) keeps it from looking stale; the claim behind it gains the quote too.
    await deps.memory.items.updateItem(ownerId, id, { evidence: merged });
    const claimOf = found.claimId === null ? undefined : active.find((entry) => entry.id === found.claimId);
    if (claimOf !== undefined) await store.put('memoryClaims', { ...claimOf, evidence: uniqueEvidence([...claimOf.evidence, ...seen]), updatedAt: stamp }, { status: 'active' });
  }
  const superseded = active.filter((entry) => accepted.some((next) => next.claim.supersedesClaimId === entry.id));
  await writeClaims(deps, { ownerId, agentId, accepted, superseded, now: stamp, ownerPersonId, personOf: senders.personOf, accountOf: senders.senderOf });
  return {
    accepted: accepted.length,
    relationsProposed,
    relations: accepted.flatMap((entry) => entry.cited === undefined ? [] : [entry.cited]),
    lines: [...accepted.map((entry) => 'Wrote ' + entry.claim.id + ' to ' + entry.place.path + ': ' + entry.claim.text), ...rejections.map((line) => 'Rejected ' + line)],
  };
}

/**
 * Stores the claims and their items. A superseded claim and its items are retracted; each accepted claim becomes an item, labelled
 * with who said it (the owner, or the other sender's person) and where (the conversation of its first evidence). Then the views are
 * rendered from the items.
 */
async function writeClaims(
  deps: ClaimDeps,
  input: {
    ownerId: string; agentId: string; accepted: Accepted[]; superseded: MemoryClaimDoc[]; now: string; ownerPersonId: string | null;
    personOf: ReadonlyMap<string, string>;
    /** Each other sender's platform account (its id when it is recorded), so an item can name the account it came from. */
    accountOf: ReadonlyMap<string, { accountId?: string }>;
  },
): Promise<void> {
  const { store, memory } = deps;
  const { ownerId, accepted, superseded } = input;
  for (const entry of accepted) await store.put('memoryClaims', entry.claim, { status: 'active' });
  for (const old of superseded) await store.put('memoryClaims', { ...old, status: 'superseded', updatedAt: input.now }, { status: 'superseded' });
  for (const old of superseded) for (const item of await memory.items.listItems(ownerId, { claimId: old.id })) await memory.items.retract(ownerId, item.id);
  // An item with no claim (migrated, or written by memory_note) that a new fact replaces has no claim to retract it through.
  for (const entry of accepted) if (entry.replacesItemId !== undefined) await memory.items.retract(ownerId, entry.replacesItemId);
  for (const entry of accepted) {
    const first = entry.claim.evidence[0];
    const source = first === undefined ? null : await store.get('items', first.itemId);
    const fromOwner = source?.type === 'user_message' && source.authorId === ownerId;
    const place = source === null ? { saidIn: 'app', audience: 'owner' } : await placeOf(store, ownerId, source.conversationId);
    await memory.items.addItem(ownerId, {
      text: entry.claim.text,
      kind: entry.place.kind,
      file: entry.place.file,
      ...(entry.topic === undefined ? {} : { topic: entry.topic }),
      aboutPersonId: entry.aboutPersonId,
      agentId: entry.agentId ?? null,
      saidByPersonId: fromOwner ? input.ownerPersonId : first === undefined ? null : input.personOf.get(first.itemId) ?? null,
      saidByAccountId: fromOwner || first === undefined ? null : input.accountOf.get(first.itemId)?.accountId ?? null,
      saidIn: place.saidIn,
      audience: place.audience,
      claimId: entry.claim.id,
      evidence: entry.claim.evidence,
      createdAt: entry.claim.createdAt,
    });
  }
  if (accepted.length + superseded.length > 0) await renderViews(deps, { ownerId, agentId: input.agentId });
}

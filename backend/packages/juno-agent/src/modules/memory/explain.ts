/**
 * `memory_explain` (BACKEND §5.3, batch 5a): why a memory is there. A reference is the tag a line carries: `[mem:<id>]` (one item) or
 * `[claim:<id>]` (the claim and the items that came through it). The answer says who said it, where, when and who may hear it, and the
 * user's exact words behind it. Only what the caller's presence may see is answered; anything else is "not found".
 */
import type { MemoryItem, Presence, VisibleItem } from '@agent-desktop/memory-graph/memory';
import type { Store } from '../../contracts/index.js';
import type { MemoryClaimDoc } from '../../contracts/memory.js';
import { groupNotePathOfKey, parseNote } from '../groups/note.js';
import { getRow } from '../home/mirror.js';
import type { MemoryGraph } from './graph.js';

export interface EvidenceSource {
  quote: string;
  itemId: string;
  /** Where the words came from: a conversation message and who wrote it, or an agent's daily log (an assistant's wording, not the user's). */
  source: { kind: 'message'; conversationId: string; at: string; speaker: 'owner' | 'someone else' | 'agent' } | { kind: 'log'; path: string } | { kind: 'missing' };
}

export type Reference = { kind: 'mem'; id: string } | { kind: 'claim'; id: string };

export type Explanation =
  | {
    kind: 'item';
    item: MemoryItem;
    /** Who said it, as a name (a person, else the agent that wrote it). */
    saidBy: string;
    /** Where it was said, in words, and who may hear it. */
    place: string;
    visibleTo: string;
    claim?: MemoryClaimDoc;
    evidence: EvidenceSource[];
  }
  | { kind: 'claim'; claim: MemoryClaimDoc; items: MemoryItem[]; evidence: EvidenceSource[] }
  | { kind: 'not_found'; reason: string };

const TAG = /^\s*\[?(mem|claim):([A-Za-z0-9_-]+)\]?\s*$/;

/** The reference a tag names: `[mem:<id>]`, `[claim:<id>]`, or the same without brackets. Undefined for anything else. */
export function referenceOf(text: string): Reference | undefined {
  const match = TAG.exec(text);
  if (match === null) return undefined;
  return match[1] === 'claim' ? { kind: 'claim', id: match[2] ?? '' } : { kind: 'mem', id: match[2] ?? '' };
}

async function evidenceOf(store: Store, ownerId: string, entries: ReadonlyArray<{ itemId: string; quote: string }>): Promise<EvidenceSource[]> {
  const evidence: EvidenceSource[] = [];
  for (const entry of entries) {
    if (entry.itemId.startsWith('log:')) {
      evidence.push({ quote: entry.quote, itemId: entry.itemId, source: { kind: 'log', path: entry.itemId.slice(4) } });
      continue;
    }
    const message = await store.get('items', entry.itemId);
    if (message === null) {
      evidence.push({ quote: entry.quote, itemId: entry.itemId, source: { kind: 'missing' } });
      continue;
    }
    const agentSpoke = message.type !== 'user_message' || message.channelSender?.externalId.startsWith('agent:') === true;
    const speaker = agentSpoke ? 'agent' : message.authorId === ownerId ? 'owner' : 'someone else';
    evidence.push({ quote: entry.quote, itemId: entry.itemId, source: { kind: 'message', conversationId: message.conversationId, at: message.at, speaker } });
  }
  return evidence;
}

/** Who may hear an item, in words: the owner alone, the people of one group (its title), or anyone. */
async function visibleToOf(store: Store, ownerId: string, audience: string): Promise<string> {
  if (audience === 'owner') return 'only the owner';
  if (audience === 'public') return 'anyone';
  if (audience.startsWith('group:')) {
    const title = parseNote((await getRow(store, ownerId, groupNotePathOfKey(audience.slice('group:'.length))))?.content ?? '').title;
    return 'the people of group ' + (title === '' ? 'chat' : title);
  }
  return audience;
}

/** The claim doc of this owner, or null. */
async function ownClaim(store: Store, ownerId: string, id: string): Promise<MemoryClaimDoc | null> {
  const claim = await store.get('memoryClaims', id);
  return claim !== null && claim.ownerId === ownerId ? claim : null;
}

/** Explains one reference as `presence` may see it. `agentId` as for `memoryFor` (undefined = the app). */
export async function explainMemory(
  memory: MemoryGraph,
  store: Store,
  input: { ownerId: string; presence: Presence; agentId: string | undefined; reference: Reference },
): Promise<Explanation> {
  const { ownerId, presence, agentId, reference } = input;
  const visible = await memory.items.memoryFor(ownerId, presence, agentId);
  const people = await memory.identity.listPeople(ownerId);
  const names = new Map(people.map((person): [string, string] => [person.id, person.name]));
  const agentName = async (id: string | null): Promise<string | undefined> => (id === null ? undefined : (await store.get('agents', id))?.name ?? 'an assistant');

  if (reference.kind === 'claim') {
    const claim = await ownClaim(store, ownerId, reference.id);
    const items = visible.filter((item) => item.claimId === reference.id);
    if (claim === null || items.length === 0) return { kind: 'not_found', reason: 'no memory from claim ' + reference.id + ' that you can see here' };
    return { kind: 'claim', claim, items, evidence: await evidenceOf(store, ownerId, claim.evidence) };
  }

  const item: VisibleItem | undefined = visible.find((candidate) => candidate.id === reference.id);
  if (item === undefined) return { kind: 'not_found', reason: 'no memory ' + reference.id + ' that you can see here' };
  const person = item.saidByPersonId === null ? undefined : names.get(item.saidByPersonId);
  const saidBy = person ?? (await agentName(item.saidByAgentId)) ?? 'someone';
  const placeWords = item.saidIn === 'app' ? 'the app' : item.saidIn.startsWith('dm:') ? 'a direct chat' : item.saidIn.startsWith('group:') ? 'a group chat' : item.saidIn === 'migrated' ? 'an earlier chat' : item.saidIn;
  const claim = item.claimId === null ? null : await ownClaim(store, ownerId, item.claimId);
  const { vector: _vector, ...plain } = item;
  return {
    kind: 'item',
    item: plain,
    saidBy,
    place: placeWords,
    visibleTo: await visibleToOf(store, ownerId, item.audience),
    ...(claim === null ? {} : { claim }),
    evidence: item.evidence === null ? [] : await evidenceOf(store, ownerId, item.evidence),
  };
}

/**
 * The owner's own edits of people, accounts, relations and memory items (BACKEND §10.17): what the app's People and Memory segments read
 * and change. They see everything of their owner (the owner is the one who may see it all, so no presence applies). A change that shows
 * in a view re-renders the views, as an agent's own write does. Reached only through `MemoryPort.owner`, so memoryd serves them too.
 */
import { IdentityError, type Account, type Person } from '@agent-desktop/memory-graph/identity';
import { ITEM_TOPICS, MemoryItemError, type ItemPatch, type ItemTopic, type MemoryItem } from '@agent-desktop/memory-graph/memory';
import type { RelationKind } from '@agent-desktop/memory-graph/relations';
import type { HomeDeps } from '../home/service.js';
import { nameKey } from '../people/names.js';
import type { MemoryGraph } from './graph.js';
import { jobAgent } from './jobs/agent.js';
import { forgetClaims } from './forget.js';
import { segmentsOf, type TopicSegment } from './topic-markup.js';
import { renderViews } from './views.js';

/** What the owner's operations need: the graph, and the home the views are rendered into. */
export type OwnerDeps = HomeDeps & { memory: MemoryGraph };

/** One relation as seen from one of its people: `direction` is `out` when that person is the first end (a is kind of b). */
export interface PersonRelation {
  id: string;
  kind: RelationKind;
  kindLabel: string | null;
  otherPersonId: string;
  otherName: string;
  direction: 'out' | 'in';
  confirmed: boolean;
}

/** A person with the accounts they speak from and their open relations; newest activity first in `peopleOf`. */
export interface PersonView {
  person: Person;
  accounts: Account[];
  relations: PersonRelation[];
  /** The latest time one of the accounts was seen (the person's creation when none was). */
  lastActivityAt: string;
}

/** One section of the Memory page: a topic that has active items, its summary (empty before the nightly job wrote one) and its item count. */
export interface TopicView {
  topic: ItemTopic;
  /** The summary as plain text. */
  summary: string;
  /** The same summary in pieces: a phrase that states an item carries its id (only while the item is active). */
  segments: TopicSegment[];
  count: number;
  updatedAt: string;
}

/** The topics that have active items, in the fixed topic order. An item without a topic counts under `other`. */
export async function topicsOf(graph: MemoryGraph, ownerId: string): Promise<TopicView[]> {
  const [items, summaries] = await Promise.all([graph.items.listItems(ownerId, { status: 'active' }), graph.items.listTopicSummaries(ownerId)]);
  const written = new Map(summaries.map((entry) => [entry.topic, entry]));
  // A phrase only opens an item that is still active; after a merge or a retraction it reads as plain text until the next night.
  const active = new Set(items.map((item) => item.id));
  return ITEM_TOPICS.flatMap((topic): TopicView[] => {
    const mine = items.filter((item) => (item.topic ?? 'other') === topic);
    if (mine.length === 0) return [];
    const summary = written.get(topic);
    const newest = mine.reduce((latest, item) => (item.updatedAt > latest ? item.updatedAt : latest), '');
    const segments = segmentsOf(summary?.summary ?? '', (id) => active.has(id));
    return [{ topic, summary: segments.map((segment) => segment.text).join(''), segments, count: mine.length, updatedAt: summary?.updatedAt ?? newest }];
  });
}

/** An account not linked to a person whose display name is that person's name. */
export interface PossibleMatch {
  account: Account;
  person: Person;
}

/** Every person of the owner, with accounts and open relations, most recent activity first. */
export async function peopleOf(graph: MemoryGraph, ownerId: string): Promise<PersonView[]> {
  const [people, accounts, relations] = await Promise.all([
    graph.identity.listPeople(ownerId),
    graph.identity.listAccounts(ownerId),
    graph.relations.listCurrent(ownerId),
  ]);
  return people.map((person): PersonView => {
    const own = accounts.filter((account) => account.personId === person.id);
    const mine = relations.filter((row) => row.personA === person.id || row.personB === person.id).map((row): PersonRelation => (
      row.personA === person.id
        ? { id: row.id, kind: row.kind, kindLabel: row.kindLabel, otherPersonId: row.personB, otherName: row.personBName, direction: 'out', confirmed: row.confirmed }
        : { id: row.id, kind: row.kind, kindLabel: row.kindLabel, otherPersonId: row.personA, otherName: row.personAName, direction: 'in', confirmed: row.confirmed }
    ));
    const lastActivityAt = own.reduce((latest, account) => (account.lastSeen > latest ? account.lastSeen : latest), person.createdAt);
    return { person, accounts: own, relations: mine, lastActivityAt };
  }).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.person.id.localeCompare(b.person.id));
}

/**
 * Accounts with a display name that matches a person's name, where the account is not linked to that person. Only suggestions: nothing
 * is linked here, the owner confirms each one (BACKEND §9.6, person_lookup's "Possible matches").
 */
export async function possibleMatchesOf(graph: MemoryGraph, ownerId: string): Promise<PossibleMatch[]> {
  const [people, accounts] = await Promise.all([graph.identity.listPeople(ownerId), graph.identity.listAccounts(ownerId)]);
  const byName = new Map<string, Person[]>();
  for (const person of people) {
    const key = nameKey(person.name);
    byName.set(key, [...(byName.get(key) ?? []), person]);
  }
  return accounts.flatMap((account): PossibleMatch[] => {
    if (account.name === null) return [];
    return (byName.get(nameKey(account.name)) ?? [])
      .filter((person) => person.id !== account.personId)
      .map((person) => ({ account, person }));
  });
}

/** Re-renders the views into the owner's default agent's computer home (as the agent's own writes do). */
async function rerender(deps: OwnerDeps, ownerId: string): Promise<void> {
  const agent = await jobAgent(deps.store, ownerId);
  await renderViews(deps, { ownerId, agentId: agent?.agent.id ?? '' });
}

/** Renames a person; the people pages are rendered again (their headings carry the name). */
export async function renameOwnerPerson(deps: OwnerDeps, ownerId: string, personId: string, name: string): Promise<Person> {
  const person = await deps.memory.identity.renamePerson(ownerId, personId, name);
  await rerender(deps, ownerId);
  return person;
}

/**
 * The owner's edit of one item. Text, audience, sensitivity, status and the person it is about may all change; an owner may widen an
 * audience (the agents may not), because the owner is the one it is about. `aboutPersonId` must be one of the owner's people.
 */
export async function updateOwnerItem(deps: OwnerDeps, ownerId: string, id: string, patch: ItemPatch): Promise<MemoryItem> {
  const about = patch.aboutPersonId;
  if (typeof about === 'string' && !(await deps.memory.identity.listPeople(ownerId)).some((person) => person.id === about)) {
    throw new IdentityError('invalid', 'the person the item is about is not one of yours');
  }
  const item = await deps.memory.items.updateItem(ownerId, id, patch);
  await rerender(deps, ownerId);
  return item;
}

/**
 * Deletes one item. An item a digest claim made goes through its claim (the claim is retracted with its item, through the same path as
 * the owner's forget), so the digest does not learn the same thing again from the messages it already read.
 */
export async function deleteOwnerItem(deps: OwnerDeps, ownerId: string, id: string): Promise<void> {
  const item = await deps.memory.items.getItem(ownerId, id);
  if (item === undefined) throw new MemoryItemError('not_found', 'memory item not found');
  if (item.claimId !== null) {
    // The item's own id rides along: forgetClaims deletes the `mem_` ids it is given, so the item goes even when its claim row is gone.
    const agent = await jobAgent(deps.store, ownerId);
    await forgetClaims(deps, { ownerId, agentId: agent?.agent.id ?? '', claimIds: [item.claimId, item.id] });
    return;
  }
  await deps.memory.items.deleteItem(ownerId, id);
  await rerender(deps, ownerId);
}

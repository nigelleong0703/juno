/**
 * The seam between the agent runtime and memory. The runtime (the tools, the brain's Memory section, the memory and chat-digest timers,
 * the HTTP routes that answer the app) talks to memory only through `MemoryPort`; `createMemoryPort` implements it over the in-process
 * graph (items, identity, relations). The next step is to run memory as its own service behind the same interface.
 *
 * What still reaches past the port, on purpose and listed in BACKEND §2.4:
 * - `graph`: the nightly memory job and the goal briefing (the memory timer) read and write the items, the identity graph and the
 *   relations directly. They move behind the port with the memory service.
 * - agentd's channel ingress records speakers on the identity graph (`upsertAccount`), not through this port.
 */
import type { ForgetMemoryResult } from '@agent-desktop/public-contracts';
import type { Account, AccountInput, Person } from '@agent-desktop/memory-graph/identity';
import type { ItemPatch, ItemStatus, ItemTopic, MemoryItem, NewItem, Presence, VisibleItem } from '@agent-desktop/memory-graph/memory';
import type { RecordOutcome, RecordRelation, Relation, RelationView } from '@agent-desktop/memory-graph/relations';
import type { Store } from '../../contracts/index.js';
import type { AgentHomeRow } from '../../contracts/storage.js';
import type { HomeComputer } from '../../ports/computer/index.js';
import { requestScopedStore } from '../../owner-context.js';
import { saveOwnerView } from './edits.js';
import { explainMemory, type Explanation, type Reference } from './explain.js';
import { forgetClaims } from './forget.js';
import type { MemoryGraph } from './graph.js';
import { addOrUpdateNote, type NoteOutcome } from './dedupe.js';
import { deleteOwnerItem, peopleOf, possibleMatchesOf, renameOwnerPerson, topicsOf, updateOwnerItem, type PersonView, type PossibleMatch, type TopicView } from './owner-edits.js';
import { applyClaims, readClaimsContext, type ClaimsContext, type ClaimsResult } from './jobs/claims.js';
import type { SourceItem } from './jobs/gather.js';
import type { ClaimDeps } from './jobs/types.js';
import { applyRelations, type RelationsResult } from './relations.js';
import { searchMemory } from './search.js';
import { memorySectionFor, type MemorySection, type MemorySectionRun } from './section.js';
import { renderViews } from './views.js';

/** Where the digest's logs go (the chat digest's own log, when it has one). */
export type DigestLog = (fields: Record<string, unknown>, message: string) => void;

export interface MemorySearchInput {
  ownerId: string;
  presence: Presence;
  agentId: string | undefined;
  query: string;
  limit?: number;
}

export interface MemorySearchHit {
  item: VisibleItem;
  score: number;
}

/** One run's Memory section; the store and the graph are the port's own. */
export type MemorySectionInput = Omit<MemorySectionRun, 'store' | 'memory'>;

export interface MemoryPort {
  /** Write: a new item (a note the agent made, a migrated line). Null when its legacy ref was taken before. */
  addItem(ownerId: string, input: NewItem): Promise<MemoryItem | null>;
  /**
   * Write: a note an agent made (memory_note). When an active item of the same person, audience and agent already says it (the same text
   * ignoring case and punctuation, or an embedding cosine of 0.95), that item is updated instead of a second one added.
   */
  note(ownerId: string, input: NewItem): Promise<NoteOutcome | null>;
  /** Read: the active items one presence may see, oldest first. The only read that feeds a prompt or a search. */
  memoryFor(ownerId: string, presence: Presence, agentId: string | undefined): Promise<VisibleItem[]>;
  /** Read: the owner's items one presence may see, ranked for the query (words, and vectors when an embedder is set). */
  search(input: MemorySearchInput): Promise<MemorySearchHit[]>;
  /** Read: the Memory section of one run (and, at a run's start, the relevant block). */
  section(input: MemorySectionInput): Promise<MemorySection>;
  /** Read: why a line is in memory, as the presence may see it. */
  explain(input: { ownerId: string; presence: Presence; agentId: string | undefined; reference: Reference }): Promise<Explanation>;
  /** Write: forget claims. They are retracted, and the items they made are deleted. */
  forget(input: { ownerId: string; agentId: string; claimIds: readonly string[] }): Promise<ForgetMemoryResult>;
  /** Write: the owner's edit of a memory view (MEMORY.md, a bank file, a people page), turned into item operations. */
  saveView(input: { ownerId: string; path: string; content: string; expectedHash?: string }): Promise<AgentHomeRow | null>;
  /** Write: render the views (the files the context reads) again from the items, into the computer's home when one is given. */
  renderViews(input: { ownerId: string; agentId: string; home?: HomeComputer }): Promise<void>;
  /** The owner's own edits of people, relations and items (BACKEND §10.17): the app's People and Memory segments. Owner-only. */
  owner: {
    /** Every person with accounts and open relations, most recent activity first. */
    people(ownerId: string): Promise<PersonView[]>;
    /** Accounts whose name is a person's name, not linked to that person: suggestions only. */
    possibleMatches(ownerId: string): Promise<PossibleMatch[]>;
    unlinkAccount(ownerId: string, accountId: string): Promise<Account>;
    renamePerson(ownerId: string, personId: string, name: string): Promise<Person>;
    confirmRelation(ownerId: string, relationId: string): Promise<Relation>;
    deleteRelation(ownerId: string, relationId: string): Promise<void>;
    /** The owner's items, optionally about one person, in one status or one topic (oldest first). */
    items(ownerId: string, filter: { aboutPersonId?: string; status?: ItemStatus; topic?: ItemTopic }): Promise<MemoryItem[]>;
    /** The topics that have active items, with their summaries and counts, in the fixed topic order. */
    topics(ownerId: string): Promise<TopicView[]>;
    updateItem(ownerId: string, id: string, patch: ItemPatch): Promise<MemoryItem>;
    deleteItem(ownerId: string, id: string): Promise<void>;
  };
  /** Person and account operations of one owner. */
  people: {
    list(ownerId: string): Promise<Person[]>;
    ensureOwner(ownerId: string, name: string): Promise<Person>;
    createPerson(ownerId: string, name: string): Promise<Person>;
    resolve(ownerId: string, accountId: string): Promise<Person | undefined>;
    findAccount(ownerId: string, input: AccountInput): Promise<Account | undefined>;
    accountsOf(ownerId: string, personId: string): Promise<Account[]>;
    accountsWithPrefix(ownerId: string, prefix: string): Promise<Account[]>;
    listAccounts(ownerId: string): Promise<Account[]>;
    linkAccount(ownerId: string, accountId: string, personId: string): Promise<Account>;
  };
  /** Relations between the owner's people. */
  relations: {
    record(ownerId: string, input: RecordRelation): Promise<RecordOutcome>;
    currentOf(ownerId: string, personId: string): Promise<RelationView[]>;
  };
  /** Read: the digest's context for one chat, before its model call: what the owner's memory holds, the claims known, the people in it. */
  digestContext(input: { ownerId: string; items: readonly SourceItem[]; agents: ReadonlyArray<{ id: string; name: string }>; log?: DigestLog }): Promise<{ context: ClaimsContext; prompt: string }>;
  /** Write: the digest's answer. Its claims are checked and written (the views rendered into `home`), then the relations they state are recorded. */
  applyDigest(input: { ownerId: string; agentId: string; items: readonly SourceItem[]; claims: readonly unknown[]; context: ClaimsContext; now: Date; home?: HomeComputer; log?: DigestLog }): Promise<{ claims: ClaimsResult; relations: RelationsResult }>;
  /** LEAK (see the module comment): the concrete graph, for the nightly memory job and the goal briefing only. */
  readonly graph: MemoryGraph;
}

export interface MemoryPortDeps {
  store: Store;
  graph: MemoryGraph;
  /** The computer's home, where the views are written when a computer is configured. */
  home?: HomeComputer;
  log?: (fields: Record<string, unknown>, message: string) => void;
}

export function createMemoryPort(deps: MemoryPortDeps): MemoryPort {
  // Owner-scoped like the runtime's own store: the reads of the views and the people resolve to the caller's owner.
  const store = requestScopedStore(deps.store);
  const { graph } = deps;
  const homeDeps = { store, memory: graph, ...(deps.home === undefined ? {} : { home: deps.home }), ...(deps.log === undefined ? {} : { log: deps.log }) };
  const claimDeps = (options: { home?: HomeComputer; log?: DigestLog }): ClaimDeps => ({
    store, memory: graph, ...(options.home === undefined ? {} : { home: options.home }), ...(options.log === undefined ? {} : { log: options.log }),
  });
  return {
    graph,
    digestContext: (input) => readClaimsContext(claimDeps({ ...(input.log === undefined ? {} : { log: input.log }) }), input),
    applyDigest: async (input) => {
      const deps = claimDeps({ ...(input.home === undefined ? {} : { home: input.home }), ...(input.log === undefined ? {} : { log: input.log }) });
      const claims = await applyClaims(deps, input);
      // Relations after the claims: a claim may have made a person the relation names, and each relation is cited to its claim (BACKEND §9.6).
      const relations = await applyRelations(deps, { ownerId: input.ownerId, items: input.items, relations: claims.relations, context: input.context });
      return { claims, relations };
    },
    addItem: (ownerId, input) => graph.items.addItem(ownerId, input),
    note: async (ownerId, input) => {
      const noted = await addOrUpdateNote(graph, ownerId, input);
      // The claim behind an item that was updated says the new wording too, so the claims list and the item agree.
      if (noted?.updated === true && noted.item.claimId !== null) {
        const claim = await store.get('memoryClaims', noted.item.claimId);
        if (claim !== null) await store.put('memoryClaims', { ...claim, text: noted.item.text, updatedAt: noted.item.updatedAt }, { status: claim.status });
      }
      return noted;
    },
    memoryFor: (ownerId, presence, agentId) => graph.items.memoryFor(ownerId, presence, agentId),
    search: async (input) => searchMemory(graph, input),
    section: (input) => memorySectionFor({ ...input, store, memory: graph }),
    explain: (input) => explainMemory(graph, store, input),
    forget: (input) => forgetClaims(homeDeps, input),
    saveView: (input) => saveOwnerView(homeDeps, input),
    renderViews: (input) => renderViews({ store, memory: graph, ...(input.home === undefined ? {} : { home: input.home }), ...(deps.log === undefined ? {} : { log: deps.log }) }, input),
    owner: {
      people: (ownerId) => peopleOf(graph, ownerId),
      possibleMatches: (ownerId) => possibleMatchesOf(graph, ownerId),
      unlinkAccount: (ownerId, accountId) => graph.identity.unlinkAccount(ownerId, accountId),
      renamePerson: (ownerId, personId, name) => renameOwnerPerson(homeDeps, ownerId, personId, name),
      confirmRelation: (ownerId, relationId) => graph.relations.confirm(ownerId, relationId),
      deleteRelation: (ownerId, relationId) => graph.relations.remove(ownerId, relationId),
      items: (ownerId, filter) => graph.items.listItems(ownerId, filter),
      topics: (ownerId) => topicsOf(graph, ownerId),
      updateItem: (ownerId, id, patch) => updateOwnerItem(homeDeps, ownerId, id, patch),
      deleteItem: (ownerId, id) => deleteOwnerItem(homeDeps, ownerId, id),
    },
    people: {
      list: (ownerId) => graph.identity.listPeople(ownerId),
      ensureOwner: (ownerId, name) => graph.identity.ensureOwner(ownerId, name),
      createPerson: (ownerId, name) => graph.identity.createPerson(ownerId, name),
      resolve: (ownerId, accountId) => graph.identity.resolve(ownerId, accountId),
      findAccount: (ownerId, input) => graph.identity.findAccount(ownerId, input),
      accountsOf: (ownerId, personId) => graph.identity.accountsOf(ownerId, personId),
      accountsWithPrefix: (ownerId, prefix) => graph.identity.accountsWithPrefix(ownerId, prefix),
      listAccounts: (ownerId) => graph.identity.listAccounts(ownerId),
      linkAccount: (ownerId, accountId, personId) => graph.identity.linkAccount(ownerId, accountId, personId),
    },
    relations: {
      record: (ownerId, input) => graph.relations.record(ownerId, input),
      currentOf: (ownerId, personId) => graph.relations.currentOf(ownerId, personId),
    },
  };
}

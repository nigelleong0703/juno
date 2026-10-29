/** Shapes of the memory items (migration 0044). Rows are mapped to these in repo.ts; nothing here touches a database. */

export const ITEM_KINDS = ['fact', 'preference', 'plan', 'relationship', 'role', 'circumstance', 'experience'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** What an item is about at a glance, for the Memory page's sections (migration 0050). An item without one reads as `other`. */
export const ITEM_TOPICS = ['identity', 'health', 'work', 'plans', 'preferences', 'people', 'agents', 'home', 'other'] as const;
export type ItemTopic = (typeof ITEM_TOPICS)[number];

/** The view an item renders into: MEMORY.md, one bank file, or the page of its `aboutPersonId`. */
export const ITEM_FILES = ['memory', 'bank:circumstances', 'bank:experiences', 'bank:preferences', 'person'] as const;
export type ItemFile = (typeof ITEM_FILES)[number];

/** `needs_review` items are kept but not rendered into any view until someone verifies them. */
export const ITEM_STATUSES = ['active', 'retracted', 'needs_review'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** A quote the item rests on: the message it came from and the words copied from it (as in memory_claims). */
export interface ItemEvidence {
  itemId: string;
  quote: string;
}

export interface MemoryItem {
  id: string;
  ownerId: string;
  /**
   * One short self-contained statement. About the person being helped it has no subject ("Wants to build muscle"); about anyone else it
   * starts with their name ("Priya manages Tom").
   */
  text: string;
  kind: ItemKind;
  file: ItemFile;
  /** Null until the writer (the digest, memory_note) or the nightly tidy gives it one. */
  topic: ItemTopic | null;
  /** Who the item is about: the owner's own person for owner facts; null when no person is known. */
  aboutPersonId: string | null;
  /** Set = private to that agent; null = shared by the owner's agents. */
  agentId: string | null;
  /** Who said it: a person, the account they spoke from, and the agent that wrote the item (its own inference). */
  saidByPersonId: string | null;
  saidByAccountId: string | null;
  saidByAgentId: string | null;
  /** Where it was said: 'app' | 'dm:<platform>' | 'group:<groupNoteKey>' | 'meeting:<id>' | 'migrated'. */
  saidIn: string;
  /** Who may hear it: 'owner' | 'group:<groupNoteKey>' | 'public'. */
  audience: string;
  sensitive: boolean;
  status: ItemStatus;
  /** The memory_claims doc this item came through (the hourly job), when it did. */
  claimId: string | null;
  evidence: ItemEvidence[] | null;
  /** sha256 of the file path and line an item was migrated from; unique per owner. */
  legacyRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What `addItem` needs; the rest takes its default (no person, shared, active, not sensitive, no claim). */
export type NewItem = Pick<MemoryItem, 'text' | 'kind' | 'file' | 'saidIn' | 'audience'> &
  Partial<Pick<MemoryItem, 'id' | 'topic' | 'aboutPersonId' | 'agentId' | 'saidByPersonId' | 'saidByAccountId' | 'saidByAgentId' | 'sensitive' | 'status' | 'claimId' | 'evidence' | 'legacyRef' | 'createdAt'>>;

/** The fields `updateItem` may change. */
export type ItemPatch = Partial<Pick<MemoryItem, 'text' | 'kind' | 'file' | 'topic' | 'aboutPersonId' | 'agentId' | 'audience' | 'sensitive' | 'status' | 'claimId' | 'evidence'>>;

/** `listItems` filters; every one is optional and they combine. `createdFrom` is an ISO instant (inclusive). */
export interface ItemFilter {
  file?: ItemFile;
  aboutPersonId?: string;
  status?: ItemStatus;
  agentId?: string;
  claimId?: string;
  createdFrom?: string;
  /** One topic; `other` also matches the items that have none. */
  topic?: ItemTopic;
}

/** The nightly job's short summary of one topic, in the second person ("You're building muscle."). */
export interface TopicSummary {
  topic: ItemTopic;
  summary: string;
  updatedAt: string;
}

/**
 * Who is in the run, as the read rules see it (`memoryFor`): the owner alone, a platform group (its note key, see groups/note.ts),
 * or anyone else (a stranger's DM, a peer agent).
 */
export type Presence = { kind: 'owner' } | { kind: 'group'; groupKey: string } | { kind: 'other' };

/** The vector of an item: the embedding and the model that made it. */
export interface ItemVector {
  embedding: number[];
  embedModel: string;
}

/** An item as `memoryFor` returns it; `vector` is set only when the caller asked for vectors (`null` = not embedded yet). */
export type VisibleItem = MemoryItem & { vector?: ItemVector | null };

export type MemoryItemErrorCode = 'invalid' | 'not_found';

/** A refused memory-item operation. `code` says why: bad input, or nothing matched in this owner. */
export class MemoryItemError extends Error {
  readonly code: MemoryItemErrorCode;

  constructor(code: MemoryItemErrorCode, message: string) {
    super(message);
    this.name = 'MemoryItemError';
    this.code = code;
  }
}

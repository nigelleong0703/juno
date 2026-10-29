/**
 * The memory items' rules over the repository (migration 0044). Every method takes the owner id first and refuses an empty one; a
 * row is only ever read or written under its own owner. Nothing here knows about files: the views are rendered in juno-agent.
 */
import { randomUUID } from 'node:crypto';
import type { DurableDb } from '@agent-desktop/durable';
import * as repo from './repo.js';
import {
  ITEM_FILES, ITEM_KINDS, ITEM_STATUSES, ITEM_TOPICS, MemoryItemError, type ItemFilter, type ItemPatch, type ItemTopic, type ItemVector, type MemoryItem, type NewItem, type Presence,
  type TopicSummary, type VisibleItem,
} from './types.js';

/** Called after an item's text is written (new, or changed): the caller may embed it. Never awaited; it must not throw. */
export type OnItemWritten = (ownerId: string, id: string, text: string) => void;

export interface MemoryItemsOptions {
  onWritten?: OnItemWritten;
}

export interface MemoryItems {
  /** Add an item. Null when `legacyRef` is already taken by this owner (a migrated line that was migrated before). */
  addItem(ownerId: string, input: NewItem): Promise<MemoryItem | null>;
  /**
   * THE read for anything that goes into a prompt or a search (BACKEND §5.3): the active items one presence may see. Owner: all, except
   * another agent's private ones (`agentId` undefined = the app, which sees all). Group `<key>`: unsensitive items of that group and
   * public ones. Other: unsensitive public items. Oldest first. The filter runs in SQL; with `vectors` each item carries its vector.
   */
  memoryFor(ownerId: string, presence: Presence, agentId: string | undefined, options?: { vectors?: boolean }): Promise<VisibleItem[]>;
  /** Store the vector of an item's text; false when the item is gone or its text changed since (the vector is then not stored). */
  setVector(ownerId: string, id: string, text: string, vector: ItemVector): Promise<boolean>;
  /** Items that have no vector from `model` yet, across owners (not retracted), oldest first: the boot backfill's work list. */
  itemsNeedingVector(model: string, limit: number): Promise<Array<{ ownerId: string; id: string; text: string }>>;
  /** One item of this owner, or undefined. */
  getItem(ownerId: string, id: string): Promise<MemoryItem | undefined>;
  /** Change the given fields of an item; throws `not_found` when it is not this owner's. */
  updateItem(ownerId: string, id: string, patch: ItemPatch): Promise<MemoryItem>;
  /** Take an item out of the views without deleting it (status `retracted`). */
  retract(ownerId: string, id: string): Promise<MemoryItem>;
  /** Remove an item for good (forgetting). True when there was one. */
  deleteItem(ownerId: string, id: string): Promise<boolean>;
  /** The owner's items matching the filter, oldest first. */
  listItems(ownerId: string, filter?: ItemFilter): Promise<MemoryItem[]>;
  /** The item migrated from this file line, or undefined. */
  findByLegacyRef(ownerId: string, legacyRef: string): Promise<MemoryItem | undefined>;
  /** The owner's topic summaries (the nightly job writes them; a topic without one is absent). */
  listTopicSummaries(ownerId: string): Promise<TopicSummary[]>;
  /** Writes or replaces one topic's summary. */
  putTopicSummary(ownerId: string, topic: ItemTopic, summary: string, updatedAt?: string): Promise<void>;
  /** Removes one topic's summary (the topic has no items left). */
  deleteTopicSummary(ownerId: string, topic: ItemTopic): Promise<void>;
}

const newId = (): string => 'mem_' + randomUUID().replaceAll('-', '');

function assertOwner(ownerId: string): void {
  if (typeof ownerId !== 'string' || ownerId.trim() === '') throw new MemoryItemError('invalid', 'owner id is required');
}

function assertText(name: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new MemoryItemError('invalid', `${name} is required`);
}

function assertOneOf<T extends string>(name: string, value: string, allowed: readonly T[]): void {
  if (!allowed.some((candidate) => candidate === value)) throw new MemoryItemError('invalid', `unknown ${name}: ${String(value)}`);
}

function checkNew(input: NewItem): void {
  assertText('item text', input.text);
  assertOneOf('kind', input.kind, ITEM_KINDS);
  assertOneOf('file', input.file, ITEM_FILES);
  assertText('said in', input.saidIn);
  assertText('audience', input.audience);
  if (input.topic !== undefined && input.topic !== null) assertOneOf('topic', input.topic, ITEM_TOPICS);
  if (input.status !== undefined) assertOneOf('status', input.status, ITEM_STATUSES);
}

export function createMemoryItems(db: DurableDb, options: MemoryItemsOptions = {}): MemoryItems {
  const getItem = async (ownerId: string, id: string): Promise<MemoryItem | undefined> => {
    const row = await repo.getItemRow(db, ownerId, id);
    return row === undefined ? undefined : repo.toItem(row);
  };

  const updateItem = async (ownerId: string, id: string, patch: ItemPatch): Promise<MemoryItem> => {
    assertOwner(ownerId);
    const assignments: repo.Assignment[] = [];
    if (patch.text !== undefined) {
      assertText('item text', patch.text);
      assignments.push({ column: 'text', value: patch.text.trim() });
      // A new text has no vector until it is embedded again (the writer is called below).
      assignments.push({ column: 'embedding', value: null, cast: '::text::jsonb' }, { column: 'embed_model', value: null });
    }
    if (patch.kind !== undefined) {
      assertOneOf('kind', patch.kind, ITEM_KINDS);
      assignments.push({ column: 'kind', value: patch.kind });
    }
    if (patch.file !== undefined) {
      assertOneOf('file', patch.file, ITEM_FILES);
      assignments.push({ column: 'file', value: patch.file });
    }
    if (patch.topic !== undefined) {
      if (patch.topic !== null) assertOneOf('topic', patch.topic, ITEM_TOPICS);
      assignments.push({ column: 'topic', value: patch.topic });
    }
    if (patch.aboutPersonId !== undefined) assignments.push({ column: 'about_person_id', value: patch.aboutPersonId });
    if (patch.agentId !== undefined) assignments.push({ column: 'agent_id', value: patch.agentId });
    if (patch.audience !== undefined) {
      assertText('audience', patch.audience);
      assignments.push({ column: 'audience', value: patch.audience });
    }
    if (patch.sensitive !== undefined) assignments.push({ column: 'sensitive', value: patch.sensitive ? 'true' : 'false', cast: '::text::boolean' });
    if (patch.status !== undefined) {
      assertOneOf('status', patch.status, ITEM_STATUSES);
      assignments.push({ column: 'status', value: patch.status });
    }
    if (patch.claimId !== undefined) assignments.push({ column: 'claim_id', value: patch.claimId });
    if (patch.evidence !== undefined) {
      assignments.push({ column: 'evidence', value: patch.evidence === null ? null : JSON.stringify(patch.evidence), cast: '::text::jsonb' });
    }
    if (assignments.length === 0) {
      const current = await getItem(ownerId, id);
      if (current === undefined) throw new MemoryItemError('not_found', 'memory item not found');
      return current;
    }
    const row = await repo.updateItemRow(db, ownerId, id, assignments);
    if (row === undefined) throw new MemoryItemError('not_found', 'memory item not found');
    const item = repo.toItem(row);
    if (patch.text !== undefined) options.onWritten?.(ownerId, item.id, item.text);
    return item;
  };

  return {
    async addItem(ownerId, input) {
      assertOwner(ownerId);
      checkNew(input);
      const row = await repo.insertItem(db, {
        id: input.id ?? newId(),
        owner_id: ownerId,
        text: input.text.trim(),
        kind: input.kind,
        file: input.file,
        topic: input.topic ?? null,
        about_person_id: input.aboutPersonId ?? null,
        agent_id: input.agentId ?? null,
        said_by_person_id: input.saidByPersonId ?? null,
        said_by_account_id: input.saidByAccountId ?? null,
        said_by_agent_id: input.saidByAgentId ?? null,
        said_in: input.saidIn,
        audience: input.audience,
        sensitive: input.sensitive === true ? 'true' : 'false',
        status: input.status ?? 'active',
        claim_id: input.claimId ?? null,
        evidence: input.evidence === undefined || input.evidence === null ? null : JSON.stringify(input.evidence),
        legacy_ref: input.legacyRef ?? null,
        created_at: input.createdAt ?? new Date().toISOString(),
      });
      if (row === undefined) return null;
      const item = repo.toItem(row);
      options.onWritten?.(ownerId, item.id, item.text);
      return item;
    },

    getItem(ownerId, id) {
      assertOwner(ownerId);
      return getItem(ownerId, id);
    },

    updateItem,

    async memoryFor(ownerId, presence, agentId, memoryOptions = {}) {
      assertOwner(ownerId);
      const withVectors = memoryOptions.vectors === true;
      return (await repo.listVisibleRows(db, ownerId, presence, agentId, withVectors)).map((row) => {
        const item = repo.toItem(row);
        if (!withVectors) return item;
        const vector = Array.isArray(row.embedding) && typeof row.embed_model === 'string' ? { embedding: row.embedding, embedModel: row.embed_model } : null;
        return { ...item, vector };
      });
    },

    async setVector(ownerId, id, text, vector) {
      assertOwner(ownerId);
      return repo.setVectorRow(db, ownerId, id, text, vector);
    },

    async itemsNeedingVector(model, limit) {
      return (await repo.rowsNeedingVector(db, model, limit)).map((row) => ({ ownerId: row.owner_id, id: row.id, text: row.text }));
    },

    retract(ownerId, id) {
      return updateItem(ownerId, id, { status: 'retracted' });
    },

    deleteItem(ownerId, id) {
      assertOwner(ownerId);
      return repo.deleteItemRow(db, ownerId, id);
    },

    async listItems(ownerId, filter = {}) {
      assertOwner(ownerId);
      return (await repo.listItemRows(db, ownerId, filter)).map(repo.toItem);
    },

    async findByLegacyRef(ownerId, legacyRef) {
      assertOwner(ownerId);
      const row = await repo.findItemRowByLegacyRef(db, ownerId, legacyRef);
      return row === undefined ? undefined : repo.toItem(row);
    },

    async listTopicSummaries(ownerId) {
      assertOwner(ownerId);
      return repo.listSummaryRows(db, ownerId);
    },

    async putTopicSummary(ownerId, topic, summary, updatedAt = new Date().toISOString()) {
      assertOwner(ownerId);
      assertOneOf('topic', topic, ITEM_TOPICS);
      assertText('summary', summary);
      await repo.putSummaryRow(db, ownerId, topic, summary.trim(), updatedAt);
    },

    async deleteTopicSummary(ownerId, topic) {
      assertOwner(ownerId);
      await repo.deleteSummaryRow(db, ownerId, topic);
    },
  };
}

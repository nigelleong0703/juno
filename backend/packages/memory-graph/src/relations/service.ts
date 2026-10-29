/**
 * The relations' rules over the repository (BACKEND §9.6). A statement is recorded once per (kind, ends): the same statement again confirms
 * an unconfirmed row or changes nothing. An exclusive kind's newer statement closes the older one (its valid_to is set; the row stays),
 * except that an unconfirmed statement never closes a relation the owner confirmed: it is refused instead, so a person cannot overwrite
 * what the owner said by saying something else about themselves. Every method takes the owner id first; both people must be this owner's.
 */
import { randomUUID } from 'node:crypto';
import type { DurableDb } from '@agent-desktop/durable';
import * as repo from './repo.js';
import { canonicalPair } from './normalize.js';
import { EXCLUSIVE_KINDS, RelationError, RELATION_KINDS, type Relation, type RelationEvidence, type RelationKind, type RelationView } from './types.js';

/** One statement to record. The names are person ids: the caller resolves names first. */
export interface RecordRelation {
  a: string;
  kind: RelationKind;
  b: string;
  /** The speaker's wording, when the kind is `other`. */
  kindLabel?: string | null;
  evidence: RelationEvidence;
  saidByPersonId?: string | null;
  saidByAccountId?: string | null;
  /** The owner's own word (or the owner's confirmation). Anything else is recorded as not confirmed. */
  confirmed: boolean;
  /** When the statement was made (ISO); the close time of what it replaces. Defaults to now. */
  at?: string;
}

export type RecordOutcome =
  /** A new row; `closed` lists the rows it replaced. */
  | { outcome: 'added'; relation: Relation; closed: string[] }
  /** The same relation was already open (it may now be confirmed). */
  | { outcome: 'already'; relation: Relation; closed: [] }
  /** Refused: an unconfirmed statement would replace a relation the owner confirmed. */
  | { outcome: 'refused'; reason: string; closed: [] };

export interface Relations {
  /** Record a statement; see the module comment for what it closes and what it refuses. */
  record(ownerId: string, input: RecordRelation): Promise<RecordOutcome>;
  /** The open relations that name this person on either side, oldest first, with the names of both ends. */
  currentOf(ownerId: string, personId: string): Promise<RelationView[]>;
  /** Every open relation of the owner, oldest first (at most 500). */
  listCurrent(ownerId: string): Promise<RelationView[]>;
  /** The owner's word on an open relation: it is confirmed (a relation the digest recorded unconfirmed becomes the owner's). */
  confirm(ownerId: string, id: string): Promise<Relation>;
  /** Remove a relation the owner says is wrong (its row is deleted, not closed). Not found when it is not this owner's. */
  remove(ownerId: string, id: string): Promise<void>;
}

const LIST_LIMIT = 500;

function assertText(name: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new RelationError('invalid', `${name} is required`);
}

export function createRelations(db: DurableDb): Relations {
  return {
    async confirm(ownerId, id) {
      assertText('owner id', ownerId);
      assertText('relation id', id);
      const row = await repo.getRelationRow(db, ownerId, id);
      if (row === undefined) throw new RelationError('not_found', 'relation not found');
      if (row.valid_to !== null) throw new RelationError('invalid', 'relation is no longer current');
      if (!row.confirmed) await repo.confirmRow(db, ownerId, id, new Date().toISOString());
      return repo.toRelation((await repo.getRelationRow(db, ownerId, id)) ?? row);
    },

    async remove(ownerId, id) {
      assertText('owner id', ownerId);
      assertText('relation id', id);
      if (!(await repo.deleteRelationRow(db, ownerId, id))) throw new RelationError('not_found', 'relation not found');
    },

    async record(ownerId, input) {
      assertText('owner id', ownerId);
      assertText('person a', input.a);
      assertText('person b', input.b);
      assertText('evidence item', input.evidence.itemId);
      assertText('evidence quote', input.evidence.quote);
      if (input.a === input.b) throw new RelationError('invalid', 'a relation needs two different people');
      if (!(RELATION_KINDS as readonly string[]).includes(input.kind)) throw new RelationError('invalid', `unknown relation kind: ${String(input.kind)}`);
      const at = input.at ?? new Date().toISOString();
      const [a, b] = canonicalPair(input.kind, input.a, input.b);
      const kindLabel = input.kind === 'other' ? (input.kindLabel?.trim() || 'other') : null;

      return db.transaction(async (tx): Promise<RecordOutcome> => {
        for (const id of [a, b]) {
          if (!(await repo.personExists(tx, ownerId, id))) throw new RelationError('not_found', 'person not found');
        }
        const same = await repo.openTriple(tx, ownerId, input.kind, a, b);
        if (same !== undefined) {
          if (input.confirmed && !same.confirmed) await repo.confirmRow(tx, ownerId, same.id, at);
          const kept = await repo.openTriple(tx, ownerId, input.kind, a, b);
          return { outcome: 'already', relation: repo.toRelation(kept ?? same), closed: [] };
        }
        const conflicts = EXCLUSIVE_KINDS.includes(input.kind) ? await repo.openConflicts(tx, ownerId, input.kind, a, b) : [];
        if (!input.confirmed && conflicts.some((row) => row.confirmed)) {
          return { outcome: 'refused', reason: 'it would replace a relation the owner confirmed', closed: [] };
        }
        await repo.closeRows(tx, ownerId, conflicts.map((row) => row.id), at);
        const row = await repo.insertRelation(tx, {
          id: 'rel_' + randomUUID().replaceAll('-', ''),
          owner_id: ownerId,
          person_a: a,
          kind: input.kind,
          person_b: b,
          kind_label: kindLabel,
          valid_from: at,
          evidence: JSON.stringify(input.evidence),
          said_by_person_id: input.saidByPersonId ?? null,
          said_by_account_id: input.saidByAccountId ?? null,
          confirmed: input.confirmed ? 'true' : 'false',
          at,
        });
        return { outcome: 'added', relation: repo.toRelation(row), closed: conflicts.map((conflict) => conflict.id) };
      });
    },

    async currentOf(ownerId, personId) {
      assertText('owner id', ownerId);
      assertText('person id', personId);
      return (await repo.currentRowsOf(db, ownerId, personId)).map(repo.toView);
    },

    async listCurrent(ownerId) {
      assertText('owner id', ownerId);
      return (await repo.listCurrentRows(db, ownerId, LIST_LIMIT)).map(repo.toView);
    },
  };
}

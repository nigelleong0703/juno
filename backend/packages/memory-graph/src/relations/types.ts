/** Shapes of the relations between people (migration 0048). Nothing here touches a database; the wording rules are in normalize.ts. */

/** The fixed kinds. `other` keeps the owner's or the speaker's own wording in `kindLabel`. */
export const RELATION_KINDS = ['manager_of', 'colleague', 'client_of', 'works_at', 'spouse', 'parent_of', 'sibling', 'friend', 'other'] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/** Kinds that hold both ways: stored once, the two people in a canonical order (the lower id first). */
export const SYMMETRIC_KINDS: readonly RelationKind[] = ['colleague', 'spouse', 'sibling', 'friend'];

/**
 * Kinds where one end has one current partner, so a newer statement closes the older one: a report has one manager (keyed on
 * person_b), a person has one employer (keyed on person_a). A closed row keeps its history.
 */
export const EXCLUSIVE_KINDS: readonly RelationKind[] = ['manager_of', 'works_at'];

/** The quote a relation rests on: the message it came from (its item id) and the words copied from it. */
export interface RelationEvidence {
  itemId: string;
  quote: string;
}

export interface Relation {
  id: string;
  ownerId: string;
  /** "personA is <kind> of personB" (for the symmetric kinds the order carries no meaning). */
  personA: string;
  kind: RelationKind;
  personB: string;
  /** The wording, when `kind` is `other`; null otherwise. */
  kindLabel: string | null;
  validFrom: string;
  /** null while the relation holds. */
  validTo: string | null;
  evidence: RelationEvidence | null;
  saidByPersonId: string | null;
  saidByAccountId: string | null;
  /** True when the owner said it (or confirmed it). Only the owner's word is confirmed. */
  confirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A current relation with the names of both ends (and of whoever said it), as a read shows it. */
export interface RelationView extends Relation {
  personAName: string;
  personBName: string;
  saidByName: string | null;
}

export type RelationErrorCode = 'invalid' | 'not_found';

/** A refused relation operation: bad input, or a person that is not this owner's. */
export class RelationError extends Error {
  readonly code: RelationErrorCode;

  constructor(code: RelationErrorCode, message: string) {
    super(message);
    this.name = 'RelationError';
    this.code = code;
  }
}

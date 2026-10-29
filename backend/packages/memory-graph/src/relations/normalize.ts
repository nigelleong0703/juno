/**
 * The wording rules of a relation, pure (no database): the model may say a relation the other way round ("Priya reports to Tom") or with
 * a word outside the fixed kinds; both are written one way. Inverse wording swaps the two ends, so every row reads "a is <kind> of b".
 */
import { RELATION_KINDS, SYMMETRIC_KINDS, type RelationKind } from './types.js';

interface Wording {
  kind: RelationKind;
  /** The statement's a and b trade places: "Priya reports to Tom" is "Tom manages Priya". */
  swap: boolean;
}

const same = (kind: RelationKind): Wording => ({ kind, swap: false });
const inverse = (kind: RelationKind): Wording => ({ kind, swap: true });

/** Known wording, after lower-casing and joining words with "_". Anything not here is kind `other`, kept as the speaker's wording. */
const WORDING: Readonly<Record<string, Wording>> = {
  manager_of: same('manager_of'), manages: same('manager_of'), boss_of: same('manager_of'),
  reports_to: inverse('manager_of'), report_to: inverse('manager_of'), works_under: inverse('manager_of'), subordinate_of: inverse('manager_of'),
  colleague: same('colleague'), colleague_of: same('colleague'), coworker: same('colleague'), coworker_of: same('colleague'), teammate_of: same('colleague'),
  client_of: same('client_of'), customer_of: same('client_of'), client: same('client_of'),
  works_at: same('works_at'), works_for: same('works_at'), employed_by: same('works_at'), employee_of: same('works_at'),
  employs: inverse('works_at'), employer_of: inverse('works_at'),
  spouse: same('spouse'), spouse_of: same('spouse'), married_to: same('spouse'), husband_of: same('spouse'), wife_of: same('spouse'),
  parent_of: same('parent_of'), mother_of: same('parent_of'), father_of: same('parent_of'), mom_of: same('parent_of'), dad_of: same('parent_of'),
  child_of: inverse('parent_of'), son_of: inverse('parent_of'), daughter_of: inverse('parent_of'),
  sibling: same('sibling'), sibling_of: same('sibling'), brother_of: same('sibling'), sister_of: same('sibling'),
  friend: same('friend'), friend_of: same('friend'),
  other: same('other'),
};

/** The wording as a lookup key: "Reports To" and "reports-to" are the same word. */
export const wordingKey = (raw: string): string => raw.trim().toLowerCase().replace(/[\s-]+/g, '_');

export interface Statement<T> {
  /** The first end: "a is <kind> of b". */
  a: T;
  /** The wording the speaker used. */
  kind: string;
  b: T;
}

export interface Normalized<T> {
  a: T;
  kind: RelationKind;
  b: T;
  /** The speaker's own wording when the kind is `other` (at most 60 characters); null for the fixed kinds. */
  kindLabel: string | null;
}

/**
 * The statement in the one form a row takes: a known kind (inverse wording swapped), or `other` with the wording kept. Undefined only
 * when the wording is empty.
 */
export function normalizeStatement<T>(statement: Statement<T>): Normalized<T> | undefined {
  const raw = statement.kind.trim();
  if (raw === '') return undefined;
  const known = WORDING[wordingKey(raw)];
  if (known !== undefined) {
    const { a, b } = known.swap ? { a: statement.b, b: statement.a } : statement;
    return { a, kind: known.kind, b, kindLabel: known.kind === 'other' ? raw.slice(0, 60) : null };
  }
  return { a: statement.a, kind: 'other', b: statement.b, kindLabel: raw.slice(0, 60) };
}

/**
 * The two ends of a symmetric relation in their stored order (the lower id first), so "A and B are friends" is one row whichever way it
 * is said. Other kinds keep their order.
 */
export function canonicalPair(kind: RelationKind, a: string, b: string): [string, string] {
  return SYMMETRIC_KINDS.includes(kind) && b < a ? [b, a] : [a, b];
}

/** True for a value the fixed kind list holds. */
export function isRelationKind(value: string): value is RelationKind {
  return (RELATION_KINDS as readonly string[]).includes(value);
}

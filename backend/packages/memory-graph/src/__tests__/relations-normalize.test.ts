/** Relation wording, pure: inverse wording is written the other way round, unknown wording is kept as `other`, symmetric pairs get one order. */
import { describe, expect, it } from 'vitest';
import { canonicalPair, normalizeStatement } from '../relations/normalize.js';

describe('normalizeStatement', () => {
  it('writes inverse wording the other way round: "Priya reports to Tom" is "Tom manager_of Priya"', () => {
    expect(normalizeStatement({ a: 'Priya', kind: 'reports_to', b: 'Tom' })).toEqual({ a: 'Tom', kind: 'manager_of', b: 'Priya', kindLabel: null });
    expect(normalizeStatement({ a: 'Priya', kind: 'Reports To', b: 'Tom' })).toEqual({ a: 'Tom', kind: 'manager_of', b: 'Priya', kindLabel: null });
    expect(normalizeStatement({ a: 'Tom', kind: 'manages', b: 'Priya' })).toEqual({ a: 'Tom', kind: 'manager_of', b: 'Priya', kindLabel: null });
  });

  it('swaps the ends of the inverse child and employer wording too', () => {
    expect(normalizeStatement({ a: 'Lily', kind: 'child_of', b: 'Robin' })).toEqual({ a: 'Robin', kind: 'parent_of', b: 'Lily', kindLabel: null });
    expect(normalizeStatement({ a: 'Acme', kind: 'employs', b: 'Priya' })).toEqual({ a: 'Priya', kind: 'works_at', b: 'Acme', kindLabel: null });
    expect(normalizeStatement({ a: 'Priya', kind: 'employed_by', b: 'Acme' })).toEqual({ a: 'Priya', kind: 'works_at', b: 'Acme', kindLabel: null });
  });

  it('keeps the speaker\'s wording as the label when the kind is other', () => {
    expect(normalizeStatement({ a: 'Sam', kind: 'mentor_of', b: 'Priya' })).toEqual({ a: 'Sam', kind: 'other', b: 'Priya', kindLabel: 'mentor_of' });
    expect(normalizeStatement({ a: 'Sam', kind: 'other', b: 'Priya' })).toEqual({ a: 'Sam', kind: 'other', b: 'Priya', kindLabel: 'other' });
  });

  it('gives back nothing for an empty wording', () => {
    expect(normalizeStatement({ a: 'Sam', kind: '   ', b: 'Priya' })).toBeUndefined();
  });
});

describe('canonicalPair', () => {
  it('orders the two ends of a symmetric kind by id, so either way round is one row', () => {
    expect(canonicalPair('friend', 'per_b', 'per_a')).toEqual(['per_a', 'per_b']);
    expect(canonicalPair('friend', 'per_a', 'per_b')).toEqual(['per_a', 'per_b']);
    expect(canonicalPair('spouse', 'per_z', 'per_c')).toEqual(['per_c', 'per_z']);
  });

  it('keeps the order of a directed kind', () => {
    expect(canonicalPair('manager_of', 'per_b', 'per_a')).toEqual(['per_b', 'per_a']);
    expect(canonicalPair('works_at', 'per_z', 'per_c')).toEqual(['per_z', 'per_c']);
  });
});

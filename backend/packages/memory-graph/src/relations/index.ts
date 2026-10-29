/**
 * The relations between people (package export `./relations`, migration 0048): "a is <kind> of b", stated in the chat digest or by the
 * owner. `normalizeStatement` writes inverse wording one way; `createRelations` records statements and reads them back.
 */
export { createRelations, type RecordOutcome, type RecordRelation, type Relations } from './service.js';
export { canonicalPair, isRelationKind, normalizeStatement, wordingKey, type Normalized, type Statement } from './normalize.js';
export {
  EXCLUSIVE_KINDS, RELATION_KINDS, RelationError, SYMMETRIC_KINDS,
  type Relation, type RelationErrorCode, type RelationEvidence, type RelationKind, type RelationView,
} from './types.js';

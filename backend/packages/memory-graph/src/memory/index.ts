/**
 * The memory items' public surface (package export `./memory`): what the agent remembers, as rows with labels (migrations 0044, 0045).
 * `MemoryItems.memoryFor` is the only read that feeds a prompt or a search; the others serve the views, the jobs and the owner's edits.
 */
export { createMemoryItems, type MemoryItems, type MemoryItemsOptions, type OnItemWritten } from './service.js';
export {
  ITEM_FILES, ITEM_KINDS, ITEM_STATUSES, ITEM_TOPICS, MemoryItemError,
  type ItemEvidence, type ItemFile, type ItemFilter, type ItemKind, type ItemPatch, type ItemStatus, type ItemTopic, type ItemVector, type MemoryItem, type MemoryItemErrorCode,
  type NewItem, type Presence, type TopicSummary, type VisibleItem,
} from './types.js';

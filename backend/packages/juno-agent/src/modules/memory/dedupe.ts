/**
 * Write-time dedupe (BACKEND §5.4 "Nightly tidy"): a new item that says what an active one already says updates that one instead of
 * becoming a second line. "The same" is deliberately narrow, so a note never overwrites something different: the same person it is about,
 * the same audience, the same agent (or none), and the text equal once case and punctuation are ignored, or - when an embedder is set -
 * a cosine similarity of at least 0.95. The chat digest has the model judge the wider cases (it sees the closest existing items).
 */
import type { ItemTopic, MemoryItem, NewItem } from '@agent-desktop/memory-graph/memory';
import type { MemoryGraph } from './graph.js';
import { cosine } from './rank.js';
import { usableVector } from './search.js';
import { normalizeText } from './wording.js';

/** Vectors at least this similar are the same statement. */
export const SAME_COSINE = 0.95;

/** The active item that already says `input`, or undefined. Looks only at items of the same person, audience and agent. */
export async function findNearDuplicate(memory: MemoryGraph, ownerId: string, input: Pick<NewItem, 'text' | 'aboutPersonId' | 'audience' | 'agentId'>): Promise<MemoryItem | undefined> {
  const embedder = memory.embedder;
  const same = (await memory.items.memoryFor(ownerId, { kind: 'owner' }, undefined, { vectors: embedder !== undefined }))
    .filter((item) => item.audience === input.audience && item.aboutPersonId === (input.aboutPersonId ?? null) && item.agentId === (input.agentId ?? null));
  const wanted = normalizeText(input.text);
  const equal = same.find((item) => normalizeText(item.text) === wanted);
  if (equal !== undefined || embedder === undefined) return equal;
  const vectors = same.flatMap((item) => {
    const vector = usableVector(item, embedder);
    return vector === undefined ? [] : [{ item, vector }];
  });
  if (vectors.length === 0) return undefined;
  const asked = (await embedder.embed([input.text]))?.[0];
  if (asked === undefined) return undefined;
  const best = vectors.map(({ item, vector }) => ({ item, score: cosine(asked, vector) })).sort((a, b) => b.score - a.score)[0];
  return best !== undefined && best.score >= SAME_COSINE ? best.item : undefined;
}

export interface NoteOutcome {
  item: MemoryItem;
  /** True when an existing item was updated instead of a new one added. */
  updated: boolean;
}

/**
 * Adds a note, or updates the item that already says it (the newest wording wins, a sensitive note makes the item sensitive, a topic
 * the item lacks is filled in). A note carrying a legacy ref is a migrated line and is always added.
 */
export async function addOrUpdateNote(memory: MemoryGraph, ownerId: string, input: NewItem): Promise<NoteOutcome | null> {
  const existing = input.legacyRef === undefined || input.legacyRef === null ? await findNearDuplicate(memory, ownerId, input) : undefined;
  if (existing === undefined) {
    const item = await memory.items.addItem(ownerId, input);
    return item === null ? null : { item, updated: false };
  }
  const topic: ItemTopic | undefined = existing.topic === null ? input.topic ?? undefined : undefined;
  // Said again: the item is touched (so it is not taken for stale), and its wording is replaced only when it differs (a new text is embedded again).
  const item = await memory.items.updateItem(ownerId, existing.id, {
    ...(existing.text === input.text.trim() ? { evidence: existing.evidence } : { text: input.text }),
    ...(input.sensitive === true && !existing.sensitive ? { sensitive: true } : {}),
    ...(topic === undefined ? {} : { topic }),
  });
  return { item, updated: true };
}

/**
 * Memory notes (BACKEND §5.3): what an agent noted about the user, or a person in their life, with memory_note. A note is an active
 * item whose author is the writing agent (its own inference, not something the user said). Also the labels every new item carries:
 * where it was said and who may hear it (the same rule for a note and for a claim).
 */
import type { ItemKind } from '@agent-desktop/memory-graph/memory';
import { groupNoteKey, groupChatOf, withWorkspace } from '../groups/note.js';
import { readChannelKind } from '../../execution/brain/social-read.js';
import { nameKey } from '../people/names.js';
import type { Store } from '../../contracts/index.js';

/**
 * First and second person ("me", "my", "I", "you", "your", 我, 你): a note is read later by other agents and by a background job, for
 * whom "me" is not the writer, so it must name who it means.
 */
export const PERSONAL_PRONOUN = /\b(?:me|my|mine|myself|i|you|your|yours|yourself|we|our|ours)\b|[我你您]/i;

/**
 * Where a new item was said and who may hear it: a group chat's note key (`group:<key>`, audience the same), or the app and a
 * platform direct chat (`app`, `dm:<platform>`, audience the owner). A conversation that cannot be read counts as the owner's own.
 */
export async function placeOf(store: Store, ownerId: string, conversationId: string): Promise<{ saidIn: string; audience: string }> {
  const conversation = await store.get('conversations', conversationId).catch(() => null);
  const chat = conversation === null ? undefined : groupChatOf(conversation);
  if (chat !== undefined) {
    const group = 'group:' + groupNoteKey(ownerId, await withWorkspace(store, ownerId, chat));
    return { saidIn: group, audience: group };
  }
  const platform = conversation === null ? undefined : readChannelKind(conversation);
  return { saidIn: platform === undefined ? 'app' : 'dm:' + platform, audience: 'owner' };
}

/** The item kind a memory_note kind is stored as. */
export const noteKindOf = (kind: 'fact' | 'circumstance' | 'preference' | 'experience' | 'commitment'): ItemKind => (kind === 'commitment' ? 'plan' : kind);

/** A person the identity graph knows: the job can write their page. */
export interface KnownPerson {
  id: string;
  name: string;
}

/**
 * The one person a "person:<ref>" target or a note's `about` names: by id (a short or full id, as the People list and the sender labels
 * show it), or by name when exactly one person has it. Undefined otherwise: nothing is created for an unknown or ambiguous name here.
 */
export function personFor(ref: string, people: readonly KnownPerson[]): KnownPerson | undefined {
  const wanted = ref.trim().toLowerCase();
  if (wanted === '') return undefined;
  // A name matches whatever its case, spacing and possessive ("Priya's" is Priya), as relations and person_lookup match names.
  const key = nameKey(ref);
  const matches = wanted.startsWith('per_')
    ? people.filter((person) => person.id.startsWith(wanted))
    : people.filter((person) => nameKey(person.name) === key);
  return matches.length === 1 ? matches[0] : undefined;
}

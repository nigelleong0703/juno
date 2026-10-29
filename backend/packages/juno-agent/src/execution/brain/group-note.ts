/**
 * The "Group note" context section: the note kept for a platform group chat (modules/groups), loaded into runs of that group and
 * nowhere else. It is built only from the group's own messages and the owner's rules for it, so it is safe in a run shared with other
 * people; the owner's private memory stays out of such runs as before. Like every section it reaches the model as a note only when
 * its text changes, so the frozen system prompt never moves (context-notes.ts).
 */
import type { Store } from '../../contracts/index.js';
import { getRow } from '../../modules/home/mirror.js';
import { groupChatOf, groupNotePath, groupNoteSection, withWorkspace } from '../../modules/groups/note.js';
import { docOwner } from '../execution-owner.js';
import { readVisibleConversation, type SocialContextInput } from './social-context.js';

/** The section's text, or '' when this is not a platform group, a helper run, or the group has no note yet. */
export async function buildGroupNoteSection(store: Store, input: SocialContextInput): Promise<string> {
  if (input.wake.some((event) => event.kind === 'child_task')) return '';
  const conversation = await readVisibleConversation(store, input);
  const base = conversation === undefined ? undefined : groupChatOf(conversation);
  const ownerId = docOwner(conversation);
  if (conversation === undefined || base === undefined || ownerId === undefined) return '';
  const chat = await withWorkspace(store, ownerId, base);
  const row = await getRow(store, ownerId, groupNotePath(ownerId, chat));
  return row === null ? '' : groupNoteSection(row.content);
}

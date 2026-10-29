/**
 * Who is in a run, as the memory reads and the tool scope see it (BACKEND §5.3). One rule, shared by the memory section, memory_search,
 * memory_explain and the tool scope: the owner alone (`profileAudience`, which every run kind goes through: the owner's chat, the
 * owner's own automation, a child task, a peer chain the owner started), a platform group or room (its note key, the same key the
 * items' `group:<key>` audience carries), or anyone else.
 */
import type { Presence } from '@agent-desktop/memory-graph/memory';
import type { Store } from '../../contracts/index.js';
import { groupChatOf, groupNoteKey, withWorkspace } from '../groups/note.js';
import { profileAudience, type AudienceWake } from '../profile/index.js';

export interface RunOf {
  /** The owner the run serves; undefined when the wake names none (then nothing of the owner's is read). */
  ownerId: string | undefined;
  agentId: string;
  conversationId: string;
  /** Only who woke the run is read (profileAudience): a synthetic owner wake serves a run that has none, such as a monitor's check. */
  wake: AudienceWake[];
}

export async function presenceOf(store: Store, run: RunOf): Promise<Presence> {
  const audience = await profileAudience(store, { agentId: run.agentId, conversationId: run.conversationId, wake: run.wake });
  if (audience.ownerOnly) return { kind: 'owner' };
  if (run.ownerId === undefined) return { kind: 'other' };
  const conversation = await store.get('conversations', run.conversationId).catch(() => null);
  const chat = conversation === null ? undefined : groupChatOf(conversation);
  if (chat === undefined) return { kind: 'other' };
  return { kind: 'group', groupKey: groupNoteKey(run.ownerId, await withWorkspace(store, run.ownerId, chat)) };
}

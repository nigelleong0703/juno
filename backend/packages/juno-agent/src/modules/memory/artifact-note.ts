/**
 * What the platform remembers about a page an agent published (BACKEND §5.11): one `experience` item about the owner, written by
 * the publishing agent, so `memory_search` finds "the page I made last time" in another chat. The chat digest only keeps what people
 * said, never what an agent did, so this is the one record of it. Same place and audience as memory_note (`placeOf`): a page made in a
 * group room is only visible where that room's audience allows. A new version of the same artifact updates the line.
 */
import type { Store } from '../../contracts/index.js';
import type { HomeComputer } from '../../ports/computer/index.js';
import { ownerNameOf } from './owner.js';
import { placeOf } from './notes.js';
import type { MemoryPort } from './port.js';

export interface PublishedArtifact {
  ownerId: string;
  agentId: string;
  conversationId: string;
  artifactId: string;
  title: string;
  version: number;
  /** The computer file the page was published from; a document (BACKEND 5.11a) has none. */
  sourcePath?: string;
  /** What the line says was done; default "Published the page". A saved document says "Saved the document". */
  verb?: string;
  at: string;
}

/** The line, with no pronoun (memory_note's rule). The `(artifactId <id>,` part is what finds the line again for a later version. */
function lineOf(input: PublishedArtifact, chat: string): string {
  const day = input.at.slice(0, 10);
  return `${input.verb ?? 'Published the page'} "${input.title}" (version ${String(input.version)}) in "${chat}" on ${day} (artifactId ${input.artifactId}${input.sourcePath === undefined ? ', a document' : ', file ' + input.sourcePath})`;}

export async function recordPublishedArtifact(store: Store, memory: MemoryPort, input: PublishedArtifact, home?: HomeComputer): Promise<void> {
  const conversation = await store.get('conversations', input.conversationId).catch(() => null);
  const chat = conversation?.title?.trim() || 'a chat';
  const text = lineOf(input, chat);
  const ownerPerson = await memory.people.ensureOwner(input.ownerId, await ownerNameOf(store, input.ownerId));
  const place = await placeOf(store, input.ownerId, input.conversationId);
  const marker = `(artifactId ${input.artifactId},`;
  const earlier = (await memory.owner.items(input.ownerId, { aboutPersonId: ownerPerson.id, status: 'active' })).find(
    (item) => item.audience === place.audience && item.saidByAgentId === input.agentId && item.text.includes(marker),
  );
  if (earlier !== undefined) {
    // owner.updateItem renders the views again itself.
    await memory.owner.updateItem(input.ownerId, earlier.id, { text });
    return;
  }
  const noted = await memory.note(input.ownerId, {
    text,
    kind: 'experience',
    file: 'bank:experiences',
    topic: 'work',
    aboutPersonId: ownerPerson.id,
    saidByPersonId: null,
    saidByAccountId: null,
    saidByAgentId: input.agentId,
    saidIn: place.saidIn,
    audience: place.audience,
    sensitive: false,
    status: 'active',
  });
  if (noted === null) return;
  await memory.renderViews({ ownerId: input.ownerId, agentId: input.agentId, ...(home === undefined ? {} : { home }) });
}

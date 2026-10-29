/**
 * The owner's hand edits of the views (BACKEND §5.4). When the owner saves MEMORY.md, a bank file or a person's page in the app, the
 * file is not written as it was sent: the difference from the view as it stood becomes item operations. A tagged line whose text
 * changed updates its item (and its claim, if it has one); a tagged line that is gone retracts its item (and its claim, so the hourly
 * job does not bring it back); a line without a tag is a new item the owner said in the app. Then the views are rendered again from the
 * items, so the file keeps the same shape.
 */
import type { AgentHomeRow } from '../../contracts/storage.js';
import { getRow } from '../home/mirror.js';
import { agentSectionId } from '../home/render.js';
import { HomeConflictError, type HomeDeps } from '../home/service.js';
import type { MemoryGraph } from './graph.js';
import { jobAgent } from './jobs/agent.js';
import { ensureOwnerPerson } from './owner.js';
import { personOfView, placeOfView, renderViews } from './views.js';
import type { MemoryItem } from '@agent-desktop/memory-graph/memory';

interface Tag {
  kind: 'claim' | 'mem';
  id: string;
}

/** A line of a view as the owner reads it: its text without the tag and the author of a note, its tag, and the agent of its section. */
export interface ViewLine {
  tag?: Tag;
  text: string;
  agentId?: string;
}

const TAIL_TAG = /\s*\[(claim|mem):([A-Za-z0-9_-]+)\]\s*$/;
const NOTED_BY = /\s*\(noted by [^()]*, [^()\s]+\)\s*$/;
const keyOf = (tag: Tag): string => tag.kind + ':' + tag.id;

/** The lines of a view as they are written (`- text (noted by …) [tag]`), under their `## <name>（<id>）` sections on a person's page. */
export function parseViewLines(content: string, personPage: boolean): ViewLine[] {
  const lines: ViewLine[] = [];
  let section: string | undefined;
  for (const raw of content.split('\n')) {
    if (raw.startsWith('#')) {
      section = agentSectionId(raw);
      continue;
    }
    let rest = raw.replace(/^\s*-\s*/, '').trimEnd();
    const tail = TAIL_TAG.exec(rest);
    let tag: Tag | undefined;
    if (tail !== null) {
      tag = { kind: tail[1] === 'claim' ? 'claim' : 'mem', id: tail[2] ?? '' };
      rest = rest.slice(0, tail.index);
    }
    const text = rest.replace(NOTED_BY, '').replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    lines.push({ ...(tag === undefined ? {} : { tag }), text, ...(personPage && section !== undefined ? { agentId: section } : {}) });
  }
  return lines;
}

/** The active items a tag stands for: every item of a claim, or the one item with that id. */
async function activeItemsOf(deps: HomeDeps & { memory: MemoryGraph }, ownerId: string, tag: Tag): Promise<MemoryItem[]> {
  const { items } = deps.memory;
  if (tag.kind === 'claim') return (await items.listItems(ownerId, { claimId: tag.id })).filter((item) => item.status === 'active');
  const item = await items.getItem(ownerId, tag.id);
  return item !== undefined && item.status === 'active' ? [item] : [];
}

/** Applies the owner's edit of one view to the items (the view itself is rendered afterwards, not written here). */
async function applyOwnerEdit(deps: HomeDeps & { memory: MemoryGraph }, input: { ownerId: string; path: string; previous: string; next: string }): Promise<void> {
  const { ownerId, path } = input;
  const { items, identity } = deps.memory;
  const place = placeOfView(path);
  if (place === undefined) return;
  const personId = personOfView(path);
  const ownerPerson = (await ensureOwnerPerson(deps.memory, deps.store, ownerId)).id;
  const people = await identity.listPeople(ownerId);
  // A page of a person nobody knows has no items to attach lines to.
  if (personId !== undefined && !people.some((person) => person.id === personId)) return;
  const before = parseViewLines(input.previous, personId !== undefined);
  const after = parseViewLines(input.next, personId !== undefined);
  const beforeTagged = new Map<string, ViewLine & { tag: Tag }>();
  for (const line of before) if (line.tag !== undefined) beforeTagged.set(keyOf(line.tag), { ...line, tag: line.tag });
  const afterTagged = new Map<string, ViewLine>();
  for (const line of after) if (line.tag !== undefined) afterTagged.set(keyOf(line.tag), line);
  const now = new Date().toISOString();
  for (const [key, old] of beforeTagged) {
    const edited = afterTagged.get(key);
    if (edited !== undefined && edited.text === old.text) continue;
    for (const item of await activeItemsOf(deps, ownerId, old.tag)) {
      if (edited === undefined) await items.retract(ownerId, item.id);
      else await items.updateItem(ownerId, item.id, { text: edited.text });
      if (item.claimId === null) continue;
      // The claim behind a removed or reworded line follows it: a removed claim is not learned again, a reworded one keeps its new words.
      const claim = await deps.store.get('memoryClaims', item.claimId);
      if (claim === null || claim.ownerId !== ownerId) continue;
      if (edited === undefined) await deps.store.put('memoryClaims', { ...claim, status: 'retracted', updatedAt: now }, { status: 'retracted' });
      else await deps.store.put('memoryClaims', { ...claim, text: edited.text, updatedAt: now }, { status: claim.status });
    }
  }
  for (const line of after) {
    if (line.tag !== undefined && beforeTagged.has(keyOf(line.tag))) continue;
    await items.addItem(ownerId, {
      text: line.text,
      kind: place.kind,
      file: place.file,
      aboutPersonId: personId ?? ownerPerson,
      agentId: line.agentId ?? null,
      saidByPersonId: ownerPerson,
      saidIn: 'app',
      audience: 'owner',
      status: 'active',
    });
  }
}

/**
 * Saves a view the owner edited in the app: the hash the owner loaded must still be the current one (else `HomeConflictError`), the
 * edit becomes item operations, and the views are rendered again. Returns the view as it is now, or null when it has no lines left.
 */
export async function saveOwnerView(deps: HomeDeps & { memory: MemoryGraph }, input: { ownerId: string; path: string; content: string; expectedHash?: string }): Promise<AgentHomeRow | null> {
  const { store } = deps;
  const current = await getRow(store, input.ownerId, input.path);
  if (input.expectedHash !== undefined && (current?.hash ?? '') !== input.expectedHash) throw new HomeConflictError(input.path);
  await applyOwnerEdit(deps, { ownerId: input.ownerId, path: input.path, previous: current?.content ?? '', next: input.content });
  const agent = await jobAgent(store, input.ownerId);
  await renderViews(deps, { ownerId: input.ownerId, agentId: agent?.agent.id ?? '' });
  return getRow(store, input.ownerId, input.path);
}

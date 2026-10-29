/**
 * The Memory section of the context (BACKEND §5.3, batch 5a): what the people present may hear, built from the memory items through
 * `memoryFor` (never from the markdown views). Up to SECTION_ALL_MAX items are listed, grouped by subject; past that, the newest
 * SECTION_RECENT. The section text is a function of the items alone, so it is re-sent only when they change. Past the limit, the
 * SECTION_RELEVANT items that match the run's first message go into that run's first context note instead (`relevant`), once per session.
 * Each line says who said it and where.
 */
import type { Presence, VisibleItem } from '@agent-desktop/memory-graph/memory';
import type { Store, WakeEvent } from '../../contracts/index.js';
import { groupNotePathOfKey, parseNote } from '../groups/note.js';
import { getRow } from '../home/mirror.js';
import { HOME_DISPLAY } from '../home/paths.js';
import { harnessText } from '../harness/loader.js';
import type { Embedder } from './embedder.js';
import type { MemoryGraph } from './graph.js';
import { rankItems } from './search.js';

/** Up to this many items are all listed. */
export const SECTION_ALL_MAX = 40;
/** Past SECTION_ALL_MAX: the newest items listed, and how many older ones match the wake's text. */
export const SECTION_RECENT = 15;
export const SECTION_RELEVANT = 8;

export interface SectionPerson {
  id: string;
  name: string;
}

/** The names a section line shows, looked up once per build. */
export interface SectionLabels {
  /** Person id to name. */
  people: ReadonlyMap<string, string>;
  /** Agent id to name. */
  agents: ReadonlyMap<string, string>;
  /** Group key to the chat's title (the note's heading), when the group has a note. */
  groups: ReadonlyMap<string, string>;
}

/** The words of the wake: what the people in the run said to the agent (a platform message's text, or a chat message's). */
export function wakeTextOf(wake: readonly WakeEvent[]): string {
  return wake.map((event) => (typeof event.payload['text'] === 'string' ? event.payload['text'] : '')).filter((text) => text !== '').join('\n');
}

/**
 * The items the section lists, oldest first: all of them up to SECTION_ALL_MAX; past it only the newest SECTION_RECENT. Nothing of the
 * wake goes in here, so the section text changes only when the items do.
 */
export function sectionItems(items: readonly VisibleItem[]): VisibleItem[] {
  return items.length <= SECTION_ALL_MAX ? [...items] : items.slice(-SECTION_RECENT);
}

/**
 * Past SECTION_ALL_MAX: the SECTION_RELEVANT items, not listed in the section, that rank best for the wake's text, skipping the ids the
 * session has already delivered. Ranked among the candidates that are left, so the block fills up with new items while there are any.
 */
export async function relevantItems(embedder: Embedder | undefined, items: readonly VisibleItem[], wakeText: string, delivered: ReadonlySet<string>): Promise<VisibleItem[]> {
  if (items.length <= SECTION_ALL_MAX) return [];
  const listed = new Set(sectionItems(items).map((item) => item.id));
  const candidates = items.filter((item) => !listed.has(item.id) && !delivered.has(item.id));
  return (await rankItems(embedder, candidates, wakeText, SECTION_RELEVANT)).map((hit) => hit.item);
}

/** One line: the text on one line, who said it and where. `- text (said by <name> in <place>)`. */
export function sectionLine(item: VisibleItem, labels: SectionLabels): string {
  const person = item.saidByPersonId === null ? undefined : labels.people.get(item.saidByPersonId);
  const agent = item.saidByAgentId === null ? undefined : labels.agents.get(item.saidByAgentId);
  const said = person ?? (agent === undefined ? harnessText('memory.said.someone') : harnessText('memory.said.agent_note', { agent: agent === '' ? harnessText('memory.said.assistant') : agent }));
  return harnessText('memory.line', { text: item.text.replace(/\s+/g, ' ').trim(), said, place: placeOf(item, labels) });
}

/** Where it was said, short: the app, your DM, the group's title, a meeting, or an earlier chat (migrated lines). */
export function placeOf(item: VisibleItem, labels: SectionLabels): string {
  if (item.saidIn === 'app') return harnessText('memory.place.app');
  if (item.saidIn.startsWith('dm:')) return harnessText('memory.place.dm');
  if (item.saidIn.startsWith('group:')) {
    const title = labels.groups.get(item.saidIn.slice('group:'.length));
    return harnessText('memory.place.group', { title: title === undefined || title === '' ? harnessText('memory.place.group_untitled') : title });
  }
  if (item.saidIn.startsWith('meeting:')) return harnessText('memory.place.meeting');
  return harnessText('memory.place.earlier');
}

/**
 * The heading an item is listed under: the person it is about. An item says "Wants to build muscle" with no subject for the person being
 * helped, so the heading is what makes the line unambiguous to an agent ("About Robin (the person you're helping)"); anyone else's lines
 * start with their name and sit under theirs. In a run where the owner is not the one being helped the heading says "the owner" instead.
 */
function groupOf(item: VisibleItem, labels: SectionLabels, ownerPersonId: string | undefined, helping: boolean): { order: number; title: string } {
  if (item.aboutPersonId !== null && item.aboutPersonId !== ownerPersonId) {
    const other = labels.people.get(item.aboutPersonId);
    return { order: 1, title: other === undefined ? harnessText('memory.about.someone_else') : harnessText('memory.about.other', { name: other }) };
  }
  const name = ownerPersonId === undefined ? undefined : labels.people.get(ownerPersonId);
  if (helping) return { order: 0, title: name === undefined ? harnessText('memory.about.helping_unnamed') : harnessText('memory.about.helping', { name }) };
  return { order: 0, title: name === undefined ? harnessText('memory.about.owner_unnamed') : harnessText('memory.about.owner_named', { name }) };
}

/** The section's text for these items (already picked). '' only for a run with nothing to show and nothing to say. */
export function renderMemorySection(input: {
  presence: Presence;
  items: readonly VisibleItem[];
  labels: SectionLabels;
  ownerPersonId?: string;
  people: readonly SectionPerson[];
  canNote: boolean;
}): string {
  const { presence, items, labels, people, canNote } = input;
  const owner = presence.kind === 'owner';
  if (owner && items.length === 0 && people.length === 0 && !canNote) return '';
  if (!owner && items.length === 0) return '';
  const groups = new Map<string, { order: number; title: string; lines: string[] }>();
  for (const item of items) {
    const { order, title } = groupOf(item, labels, input.ownerPersonId, owner);
    const key = String(order) + '\n' + title;
    const group = groups.get(key) ?? { order, title, lines: [] };
    group.lines.push(sectionLine(item, labels));
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  const shared = presence.kind === 'group';
  const lines = [harnessText(owner ? 'memory.heading.owner' : shared ? 'memory.heading.group' : 'memory.heading.public')];
  if (items.length === 0) lines.push(harnessText('memory.empty'));
  for (const group of ordered) lines.push('', harnessText('memory.heading.sub', { title: group.title }), ...group.lines);
  if (!owner) {
    lines.push('', harnessText(shared ? 'memory.closing.group' : 'memory.closing.public'));
    return lines.join('\n');
  }
  // The people pages, by name and id: a page is people/<id>.md; a person's id is what a person_link or a message header uses.
  if (people.length > 0) lines.push('', harnessText('memory.heading.people'), ...people.map((person) => harnessText('memory.people_line', { name: person.name, id: person.id, homeDisplay: HOME_DISPLAY })));
  lines.push('', harnessText('memory.more'));
  if (canNote) lines.push(harnessText('memory.note', { homeDisplay: HOME_DISPLAY }));
  lines.push(harnessText('memory.no_delete'));
  return lines.join('\n');
}

/** Names for the lines: people and agents of the owner, and the titles of the groups the items were said in. */
export async function labelsFor(store: Store, ownerId: string, people: ReadonlyArray<{ id: string; name: string }>, items: readonly VisibleItem[]): Promise<SectionLabels> {
  const names = new Map(people.map((person): [string, string] => [person.id, person.name]));
  const agents = new Map<string, string>();
  const groups = new Map<string, string>();
  for (const item of items) {
    if (item.saidByAgentId !== null && !agents.has(item.saidByAgentId)) {
      agents.set(item.saidByAgentId, (await store.get('agents', item.saidByAgentId))?.name ?? '');
    }
    if (item.saidIn.startsWith('group:')) {
      const key = item.saidIn.slice('group:'.length);
      if (!groups.has(key)) groups.set(key, parseNote((await getRow(store, ownerId, groupNotePathOfKey(key)))?.content ?? '').title);
    }
  }
  return { people: names, agents, groups };
}

export interface MemorySectionRun {
  store: Store;
  memory: MemoryGraph;
  ownerId: string;
  agentId: string;
  presence: Presence;
  wake: readonly WakeEvent[];
  /** Whether this run may write memory notes (a sub-task may not, and a run of someone else gets none here). */
  canNote: boolean;
  /** The owner's people pages (owner runs only). */
  people: readonly SectionPerson[];
  /** True for the first build of a run: only then is a relevant block made (see `relevant`). */
  runStart: boolean;
  /** The memory item ids this session's notes have delivered already: they are not delivered again. */
  delivered: ReadonlySet<string>;
}

export interface MemorySection {
  /** The stable section: the same text for the same items, whatever the wake says. */
  section: string;
  /** Past SECTION_ALL_MAX, at a run's start: the relevant items as a note block, and their ids (to record in the note's meta). */
  relevant?: { ids: string[]; text: string };
}

/** The section for one run: the items its presence may see, picked and rendered, and at a run's start the relevant block. */
export async function memorySectionFor(run: MemorySectionRun): Promise<MemorySection> {
  const { store, memory, ownerId, agentId, presence } = run;
  const owner = presence.kind === 'owner';
  let visible = await memory.items.memoryFor(ownerId, presence, agentId);
  // Vectors are read only when they are needed for ranking: a long list at a run's start, with an embedder.
  const rankNow = run.runStart && visible.length > SECTION_ALL_MAX && memory.embedder !== undefined && wakeTextOf(run.wake).trim() !== '';
  if (rankNow) visible = await memory.items.memoryFor(ownerId, presence, agentId, { vectors: true });
  const picked = sectionItems(visible);
  const relevant = run.runStart ? await relevantItems(memory.embedder, visible, wakeTextOf(run.wake), run.delivered) : [];
  const people = await memory.identity.listPeople(ownerId);
  const ownerPersonId = people.find((person) => person.isOwner)?.id;
  const labels = await labelsFor(store, ownerId, people, [...picked, ...relevant]);
  const section = renderMemorySection({
    presence,
    items: picked,
    labels,
    ...(ownerPersonId === undefined ? {} : { ownerPersonId }),
    people: owner ? run.people : [],
    canNote: owner && run.canNote,
  });
  if (relevant.length === 0) return { section };
  const lines = [harnessText('memory.heading.relevant'), harnessText('memory.relevant_intro'), ...relevant.map((item) => sectionLine(item, labels))];
  return { section, relevant: { ids: relevant.map((item) => item.id), text: lines.join('\n') } };
}

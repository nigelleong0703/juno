/**
 * The views of memory (BACKEND §5.4): MEMORY.md, memory/bank/*.md and people/<personId>.md are rendered from the active items, after
 * each write batch, in the same shape the context has always read. They are written through the home file writer as platform
 * writes, so the sync, the search index and the context see them like any other file. An item that is not active (retracted, or
 * waiting for review) is not in any view. A note an agent made is marked with the agent that wrote it.
 */
import type { ItemFile, ItemKind, MemoryItem } from '@agent-desktop/memory-graph/memory';
import { readRowsUnder } from '../home/mirror.js';
import { MEMORY_FILE, noteAuthorSuffix } from '../home/paths.js';
import type { HomeDeps } from '../home/service.js';
import { pageNameOf, pagePath } from '../people/pages.js';
import { editHomeFile } from './files.js';
import type { MemoryGraph } from './graph.js';

const BANK_TITLES: Record<string, string> = { circumstances: 'Circumstances', experiences: 'Experiences', preferences: 'Preferences' };
const BANK_FILE = /^memory\/bank\/(circumstances|experiences|preferences)\.md$/;
const PERSON_PAGE = /^people\/(per_[0-9a-f]+)\.md$/;

/** The files that are views of the items: the only files a regeneration may rewrite. */
export const isViewFile = (path: string): boolean => path === MEMORY_FILE || BANK_FILE.test(path) || PERSON_PAGE.test(path);

/** The id of a person's page path (`people/<personId>.md`), or undefined for any other file. */
export const personOfView = (path: string): string | undefined => PERSON_PAGE.exec(path)?.[1];

/** The item file and kind a line of a view becomes when it is written by hand (undefined for a path that is not a view). */
export function placeOfView(path: string): { file: ItemFile; kind: ItemKind } | undefined {
  if (path === MEMORY_FILE) return { file: 'memory', kind: 'fact' };
  const bank = BANK_FILE.exec(path)?.[1];
  if (bank === 'circumstances') return { file: 'bank:circumstances', kind: 'circumstance' };
  if (bank === 'experiences') return { file: 'bank:experiences', kind: 'experience' };
  if (bank === 'preferences') return { file: 'bank:preferences', kind: 'preference' };
  return personOfView(path) === undefined ? undefined : { file: 'person', kind: 'fact' };
}

/** The file an item renders into: MEMORY.md, its bank file, or its person's page (undefined for a person item with no person). */
export function viewPathOf(item: Pick<MemoryItem, 'file' | 'aboutPersonId'>): string | undefined {
  if (item.file === 'memory') return MEMORY_FILE;
  if (item.file === 'person') return item.aboutPersonId === null ? undefined : pagePath(item.aboutPersonId);
  return 'memory/bank/' + item.file.slice('bank:'.length) + '.md';
}

/**
 * The line of an item: its text on one line, then the author of a note an agent made (` (noted by <name>, <id>)`, `noted` is that
 * suffix), then its tag: its claim, or its own id when no claim stands behind it.
 */
export function itemLine(item: Pick<MemoryItem, 'id' | 'text' | 'claimId'>, noted = ''): string {
  const text = item.text.replace(/\s*\[(?:claim|mem):[^\]\s]+\]/g, '').replace(/\s+/g, ' ').trim();
  return '- ' + text + noted + ' ' + (item.claimId === null ? '[mem:' + item.id + ']' : '[claim:' + item.claimId + ']');
}

/** The heading of a view file: the sheet, the bank's title, or the person's name (kept from the page when the person is not known). */
function headingOf(path: string, names: ReadonlyMap<string, string>, existing: string): string {
  if (path === MEMORY_FILE) return '# Memory';
  const bank = BANK_FILE.exec(path)?.[1];
  if (bank !== undefined) return '# ' + (BANK_TITLES[bank] ?? bank);
  const person = personOfView(path) ?? '';
  return '# ' + (names.get(person) ?? pageNameOf(existing, person));
}

interface Page {
  heading: string;
  /** Lines every agent sees. */
  shared: string[];
  /** A person's page only: the lines one agent keeps for itself, under its own `## <name>（<id>）` section. */
  sections: Map<string, string[]>;
}

/**
 * Regenerates every view of the owner from the active items. A view with no active line is still written (it keeps its heading), and
 * a view that does not exist is created only when an item goes into it. Unchanged files are not written again.
 */
export async function renderViews(deps: HomeDeps & { memory: MemoryGraph }, input: { ownerId: string; agentId: string }): Promise<void> {
  const { store, memory } = deps;
  const { ownerId } = input;
  const names = new Map((await memory.identity.listPeople(ownerId)).map((person): [string, string] => [person.id, person.name]));
  const pages = new Map<string, Page>();
  const pageAt = (path: string, existing: string): Page => {
    const found = pages.get(path);
    if (found !== undefined) return found;
    const created: Page = { heading: headingOf(path, names, existing), shared: [], sections: new Map() };
    pages.set(path, created);
    return created;
  };
  for (const row of await readRowsUnder(store, ownerId, '')) if (isViewFile(row.path)) pageAt(row.path, row.content);
  const active = await memory.items.listItems(ownerId, { status: 'active' });
  const authors = new Map<string, string>();
  for (const agentId of new Set(active.map((item) => item.saidByAgentId).filter((id): id is string => id !== null))) {
    authors.set(agentId, (await store.get('agents', agentId))?.name ?? '');
  }
  for (const item of active) {
    const path = viewPathOf(item);
    if (path === undefined) continue;
    const page = pageAt(path, '');
    const author = item.saidByAgentId === null ? undefined : authors.get(item.saidByAgentId);
    const line = itemLine(item, author === undefined || item.saidByAgentId === null ? '' : noteAuthorSuffix(author, item.saidByAgentId));
    if (item.agentId === null) page.shared.push(line);
    else if (PERSON_PAGE.test(path)) page.sections.set(item.agentId, [...(page.sections.get(item.agentId) ?? []), line]);
  }
  for (const [path, page] of pages) {
    const out = [page.heading];
    if (page.shared.length > 0) out.push('', ...page.shared);
    for (const [sectionAgent, lines] of page.sections) {
      const label = (await store.get('agents', sectionAgent))?.name ?? sectionAgent;
      out.push('', '## ' + label + '（' + sectionAgent + '）', ...lines);
    }
    const content = out.join('\n') + '\n';
    await editHomeFile(deps, { ownerId, agentId: input.agentId, path }, () => content);
  }
}

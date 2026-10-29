/**
 * People pages (BACKEND 5.4, M-IDENTITY): one markdown page per person, at `people/<personId>.md`, headed `# <name>`. The hourly job
 * writes a page only for a person the identity graph knows; the page's name is the person's name, so a rename is a header change, not
 * a new file. `migratePeoplePages` moves the pages written before that, once, from `people/<slug>.md` to the person's id.
 */
import type { Identity } from '@agent-desktop/memory-graph/identity';
import type { Store } from '../../contracts/index.js';
import { deleteRow, getRow, newRow, putRow, readRowsUnder } from '../home/mirror.js';
import { listAll } from '../memory/util.js';

export const PEOPLE_PREFIX = 'people/';
/** The header's form of a person id: "per_" and 8 hex characters. */
export const shortPersonId = (personId: string): string => personId.slice(0, 'per_'.length + 8);
export const pagePath = (personId: string): string => PEOPLE_PREFIX + personId + '.md';
const PAGE = /^people\/(per_[0-9a-f]+)\.md$/;
/** The people listed in the context at most (the rest are found with memory_search). */
const MAX_LISTED = 50;
export const MIGRATION_MARKER = '__migrations/people-pages-v1';

/** The first `# ` heading of a page: the person's name as the page gives it; `fallback` when there is none. */
export function pageNameOf(content: string, fallback: string): string {
  const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(content)?.[1]?.trim();
  return heading === undefined || heading === '' ? fallback : heading;
}

/** The owner's people pages as (person id, name), by name, for the context. Only pages named by a person id are listed. */
export async function peoplePageList(store: Store, ownerId: string): Promise<Array<{ id: string; name: string }>> {
  const pages = (await readRowsUnder(store, ownerId, PEOPLE_PREFIX)).flatMap((row) => {
    const id = PAGE.exec(row.path)?.[1];
    return id === undefined ? [] : [{ id, name: pageNameOf(row.content, id) }];
  });
  return pages.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_LISTED);
}

export interface PagesMigration {
  skipped: boolean;
  moved: number;
}

/**
 * The person a slug page becomes. A person of the same name whose page does not exist yet is reused, so a run that stopped between
 * making the person and moving the page does not make a second one.
 */
async function personForPage(identity: Identity, store: Store, ownerId: string, name: string): Promise<{ id: string }> {
  const pages = new Set((await readRowsUnder(store, ownerId, PEOPLE_PREFIX)).map((row) => row.path));
  const reuse = (await identity.listPeople(ownerId)).find((person) => person.name === name && !pages.has(pagePath(person.id)));
  return reuse ?? (await identity.createPerson(ownerId, name));
}

/**
 * Moves every `people/<slug>.md` page to `people/<personId>.md` (one person per page, named by the page's heading) and repoints the
 * claims that cited the old path. Once: a marker row makes later boots skip it, and a rerun finds nothing left to move. Without the
 * identity graph (no Postgres) it does nothing and leaves the marker unwritten, so a later boot with Postgres does it.
 */
export async function migratePeoplePages(deps: { store: Store; identity?: Identity }): Promise<PagesMigration> {
  const { store, identity } = deps;
  if ((await getRow(store, 'system', MIGRATION_MARKER)) !== null) return { skipped: true, moved: 0 };
  if (identity === undefined) return { skipped: true, moved: 0 };
  let moved = 0;
  for (const row of await listAll(store, 'agentHome')) {
    if (!row.path.startsWith(PEOPLE_PREFIX) || !row.path.endsWith('.md') || PAGE.test(row.path)) continue;
    const ownerId = row.ownerId;
    const person = await personForPage(identity, store, ownerId, pageNameOf(row.content, row.path.slice(PEOPLE_PREFIX.length, -'.md'.length)));
    const path = pagePath(person.id);
    await putRow(store, newRow(ownerId, path, row.content, row.writer, new Date().toISOString(), row.pendingWrite === true));
    await deleteRow(store, ownerId, row.path);
    for (const claim of await listAll(store, 'memoryClaims')) {
      if (claim.ownerId !== ownerId || claim.target?.path !== row.path) continue;
      await store.put('memoryClaims', { ...claim, target: { ...claim.target, path } }, { status: claim.status });
    }
    moved += 1;
  }
  await putRow(store, newRow('system', MIGRATION_MARKER, '', 'platform', new Date().toISOString()));
  return { skipped: false, moved };
}

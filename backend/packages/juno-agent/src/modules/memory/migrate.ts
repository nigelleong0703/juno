/**
 * One-time move of the markdown memory into items (BACKEND §5.4, M-MEMORY-ITEMS): every line of MEMORY.md, of the bank files and of
 * the people pages becomes an item (audience owner, said in `migrated`). A line with no tag at all was written by hand, so it is the
 * owner's own words: "I" in it is the owner, and it goes live about the owner (batch 5a). A tagged line whose subject is ambiguous (first
 * or second person, or the assistant) is kept as `needs_review`, and so is a line on a page whose person is unknown; neither is rendered.
 * Then the views are rendered again from the items, so they hold the same active lines as before.
 *
 * Version 2 (batch 5a) runs once more on the databases that ran version 1: the lines version 1 parked for review because they were
 * untagged owner words are made active about the owner. The marker row makes later boots skip a version; the items themselves are taken
 * once per line (legacy_ref), so a rerun cannot add a line twice.
 */
import { createHash } from 'node:crypto';
import type { ItemStatus } from '@agent-desktop/memory-graph/memory';
import type { Store } from '../../contracts/index.js';
import { getRow, newRow, putRow } from '../home/mirror.js';
import { agentSectionId } from '../home/render.js';
import type { HomeDeps } from '../home/service.js';
import { jobAgent } from './jobs/agent.js';
import { claimIdOfLine } from './claims.js';
import type { MemoryGraph } from './graph.js';
import { PERSONAL_PRONOUN } from './notes.js';
import { ensureOwnerPerson } from './owner.js';
import { isViewFile, placeOfView, renderViews } from './views.js';
import { listAll } from './util.js';

export const MARKER = '__migrations/memory-items-v2';
const PERSON_PAGE = /^people\/(per_[0-9a-f]+)\.md$/;
/** A line the model wrote about "the assistant" is as ambiguous as one in the first or second person (tagged lines only). */
const ASSISTANT = /\bassistant\b|助手/i;
/** A line rendered from an item carries its `[mem:<id>]` tag (lines with a claim carry `[claim:<id>]`); the item is already here. */
const ITEM_TAG = /\[mem:[^\]\s]+\]/;
const TAG = /\s*\[(?:claim|mem):[^\]\s]+\]/g;

export interface ItemsMigration {
  skipped: boolean;
  /** Items written by this run (a line migrated before is not counted again). */
  migrated: number;
  /** Of those, the lines kept for review. */
  reviewed: number;
  /** Items of an earlier run that this run made active (the untagged owner lines it had parked for review). */
  fixed: number;
}

/** Whether the owner themself said any of the quoted messages (the line's claim evidence). */
async function ownerSaid(store: Store, ownerId: string, evidence: ReadonlyArray<{ itemId: string }>): Promise<boolean> {
  for (const entry of evidence) {
    const item = await store.get('items', entry.itemId).catch(() => null);
    if (item !== null && item.type === 'user_message' && item.authorId === ownerId) return true;
  }
  return false;
}

export async function migrateMemoryItems(deps: HomeDeps & { memory: MemoryGraph }): Promise<ItemsMigration> {
  const { store, memory } = deps;
  if ((await getRow(store, 'system', MARKER)) !== null) return { skipped: true, migrated: 0, reviewed: 0, fixed: 0 };
  const rows = (await listAll(store, 'agentHome')).filter((row) => isViewFile(row.path));
  const owners = [...new Set(rows.map((row) => row.ownerId))];
  let migrated = 0;
  let reviewed = 0;
  let fixed = 0;
  // Lines of one run are stamped in order, so a line without a claim keeps its place among the others of its file.
  let clock = Date.now();
  for (const ownerId of owners) {
    const ownerPerson = (await ensureOwnerPerson(memory, store, ownerId)).id;
    const people = await memory.identity.listPeople(ownerId);
    const known = new Set(people.map((person) => person.id));
    const claims = new Map((await listAll(store, 'memoryClaims')).filter((claim) => claim.ownerId === ownerId).map((claim) => [claim.id, claim]));
    // A claim-tagged line whose claim already has items is one of them (rendered again by an earlier run): not a new item.
    const claimed = new Set((await memory.items.listItems(ownerId)).flatMap((item) => (item.claimId === null ? [] : [item.claimId])));
    for (const row of rows.filter((candidate) => candidate.ownerId === ownerId).sort((a, b) => a.path.localeCompare(b.path))) {
      const personPage = PERSON_PAGE.exec(row.path)?.[1];
      const place = placeOfView(row.path);
      if (place === undefined) continue;
      const { file, kind } = place;
      let section: string | undefined;
      for (const raw of row.content.split('\n')) {
        if (raw.startsWith('#')) {
          section = agentSectionId(raw);
          continue;
        }
        if (ITEM_TAG.test(raw)) continue;
        const text = raw.replace(TAG, '').replace(/^\s*-\s*/, '').replace(/\s+/g, ' ').trim();
        if (text === '') continue;
        const claimId = claimIdOfLine(raw);
        if (claimId !== undefined && claimed.has(claimId)) continue;
        const claim = claimId === undefined ? undefined : claims.get(claimId);
        const unknownPerson = personPage !== undefined && !known.has(personPage);
        // No tag at all: the owner's own words, so the first person in it is the owner and it is not ambiguous.
        const ownWords = claimId === undefined;
        const ambiguous = !ownWords && (PERSONAL_PRONOUN.test(text) || ASSISTANT.test(text));
        const status: ItemStatus = unknownPerson || ambiguous ? 'needs_review' : claim === undefined || claim.status === 'active' ? 'active' : 'retracted';
        const item = await memory.items.addItem(ownerId, {
          text,
          kind,
          file,
          aboutPersonId: unknownPerson ? null : personPage ?? ownerPerson,
          agentId: personPage === undefined ? null : section ?? null,
          saidByPersonId: ownWords || (claim !== undefined && (await ownerSaid(store, ownerId, claim.evidence))) ? ownerPerson : null,
          saidIn: 'migrated',
          audience: 'owner',
          status,
          claimId: claim?.id ?? null,
          evidence: claim?.evidence ?? null,
          legacyRef: createHash('sha256').update(row.path + raw).digest('hex'),
          createdAt: claim?.createdAt ?? new Date((clock += 1)).toISOString(),
        });
        if (item === null) continue;
        migrated += 1;
        if (status === 'needs_review') reviewed += 1;
      }
    }
    // Version 1 parked untagged owner lines for review. They are the owner's words: active, about the owner (a person's page keeps its person).
    for (const item of await memory.items.listItems(ownerId, { status: 'needs_review' })) {
      if (item.saidIn !== 'migrated' || item.claimId !== null || item.evidence !== null) continue;
      if (item.file === 'person') {
        if (item.aboutPersonId === null) continue;
        await memory.items.updateItem(ownerId, item.id, { status: 'active' });
      } else {
        await memory.items.updateItem(ownerId, item.id, { status: 'active', aboutPersonId: ownerPerson });
      }
      fixed += 1;
    }
  }
  // The marker comes before the views are rendered: a run that stops after rendering must not be repeated on the rewritten lines.
  await putRow(store, newRow('system', MARKER, '', 'platform', new Date().toISOString()));
  for (const ownerId of owners) {
    const agent = await jobAgent(store, ownerId);
    if (agent !== undefined) await renderViews(deps, { ownerId, agentId: agent.agent.id });
  }
  return { skipped: false, migrated, reviewed, fixed };
}

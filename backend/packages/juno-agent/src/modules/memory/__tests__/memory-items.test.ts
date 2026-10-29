/**
 * The memory items as the views see them, on the embedded Postgres: the one-off migration of the markdown memory (untagged lines are the
 * owner's own words; tagged ambiguous ones wait for review; a rerun fixes what an earlier run parked), the views rendered from the active
 * items, agent notes in the views, the owner's edits, forgetting a line by its item, and owner isolation. What a presence may read is in
 * memory-read.test.ts.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { getRow, newRow, putRow } from '../../home/mirror.js';
import { forgetClaims } from '../forget.js';
import { migrateMemoryItems } from '../migrate.js';
import { renderViews } from '../views.js';
import { saveOwnerView } from '../edits.js';
import { HomeConflictError } from '../../home/service.js';
import { startMemoryGraph, type MemoryGraphFixture } from './memory-graph-fixture.js';

let graph: MemoryGraphFixture;

beforeAll(async () => {
  graph = await startMemoryGraph();
});

afterAll(async () => {
  await graph.close();
});

const AT = '2026-10-20T10:00:00.000Z';
const NOTE_MARKER = '__migrations/memory-items-v2';

/** An owner, its agent and its person, and a store to put the markdown files into. */
async function owned(name = 'Robin') {
  const owner = 'owner-' + randomUUID();
  const store: Store = createMemoryStore();
  await store.put('agents', { id: 'agent-1', name: 'Juno', ownerId: owner, createdAt: AT } as never);
  const person = await graph.graph.identity.ensureOwner(owner, name);
  return { owner, person, store, deps: { store, memory: graph.graph } };
}

const lineHash = (path: string, line: string): string => createHash('sha256').update(path + line).digest('hex');

describe('migration of the markdown memory into items', () => {
  it('turns every line into an item, keeps the owner\'s claims, parks the ambiguous lines, renders the same active lines, and runs once', async () => {
    const s = await owned();
    const { owner, store } = s;
    const alice = (await graph.graph.identity.createPerson(owner, 'Alice')).id;
    const unknownPage = 'per_' + 'f'.repeat(32);
    const memory = ['# Memory', '', '- Lives in Leiden. [claim:clm_leiden]', '- Is vegetarian.', '- I like tea.', '- The assistant suggested a walk.', ''].join('\n');
    const preferences = '# Preferences\n\n- Prefers short answers. [claim:clm_pref]\n';
    const alicePage = '# Alice\n\n## Juno（agent-1）\n- Greets by name. [claim:clm_alice]\n';
    const unknown = '# Nobody\n\n- Likes cats.\n';
    await putRow(store, newRow(owner, 'MEMORY.md', memory, 'platform', AT));
    await putRow(store, newRow(owner, 'memory/bank/preferences.md', preferences, 'platform', AT));
    await putRow(store, newRow(owner, 'people/' + alice + '.md', alicePage, 'platform', AT));
    await putRow(store, newRow(owner, 'people/' + unknownPage + '.md', unknown, 'platform', AT));
    await store.put('items', { id: 'itm-owner', conversationId: 'c1', at: AT, type: 'user_message', authorId: owner, text: 'I moved to Leiden.', attachments: [], mentions: [] });
    await store.put('items', { id: 'itm-other', conversationId: 'c1', at: AT, type: 'user_message', authorId: 'ext-telegram-0123456789abcdef', text: 'Prefers short answers', attachments: [], mentions: [] });
    await store.put('memoryClaims', { id: 'clm_leiden', ownerId: owner, text: 'Lives in Leiden.', evidence: [{ itemId: 'itm-owner', quote: 'moved to Leiden' }], confidence: 0.9, status: 'active', target: { path: 'MEMORY.md' }, createdAt: AT, updatedAt: AT }, { status: 'active' });
    await store.put('memoryClaims', { id: 'clm_pref', ownerId: owner, text: 'Prefers short answers.', evidence: [{ itemId: 'itm-other', quote: 'Prefers short answers' }], confidence: 0.9, status: 'active', target: { path: 'memory/bank/preferences.md' }, createdAt: AT, updatedAt: AT }, { status: 'active' });
    await store.put('memoryClaims', { id: 'clm_alice', ownerId: owner, text: 'Greets by name.', evidence: [], confidence: 0.9, status: 'active', target: { path: 'people/' + alice + '.md' }, createdAt: AT, updatedAt: AT }, { status: 'active' });

    const first = await migrateMemoryItems(s.deps);
    expect(first).toEqual({ skipped: false, migrated: 7, reviewed: 1, fixed: 0 });
    const items = await graph.graph.items.listItems(owner);
    // The untagged lines are the owner's own words, first person included: active. Only the line on the unknown person's page waits.
    expect(items.filter((item) => item.status === 'active').map((item) => item.text).sort()).toEqual(['Greets by name.', 'I like tea.', 'Is vegetarian.', 'Lives in Leiden.', 'Prefers short answers.', 'The assistant suggested a walk.']);
    expect(items.filter((item) => item.status === 'needs_review').map((item) => item.text)).toEqual(['Likes cats.']);
    expect(items.find((item) => item.text === 'Lives in Leiden.')).toMatchObject({ saidIn: 'migrated', audience: 'owner', saidByPersonId: s.person.id, claimId: 'clm_leiden', aboutPersonId: s.person.id, legacyRef: lineHash('MEMORY.md', '- Lives in Leiden. [claim:clm_leiden]') });
    expect(items.find((item) => item.text === 'I like tea.')).toMatchObject({ status: 'active', claimId: null, saidByPersonId: s.person.id, aboutPersonId: s.person.id, file: 'memory' });
    expect(items.find((item) => item.text === 'Prefers short answers.')).toMatchObject({ saidByPersonId: null, file: 'bank:preferences' });
    expect(items.find((item) => item.text === 'Greets by name.')).toMatchObject({ file: 'person', agentId: 'agent-1', aboutPersonId: alice });

    // The views hold the same active lines as before (the untagged ones now carry their own id), and not the unknown person's line.
    const sheet = (await getRow(store, owner, 'MEMORY.md'))?.content ?? '';
    expect(sheet).toMatch(/^# Memory\n\n- Lives in Leiden\. \[claim:clm_leiden\]\n- Is vegetarian\. \[mem:mem_[0-9a-f]{32}\]\n- I like tea\. \[mem:mem_[0-9a-f]{32}\]\n- The assistant suggested a walk\. \[mem:mem_[0-9a-f]{32}\]\n$/);
    expect((await getRow(store, owner, 'memory/bank/preferences.md'))?.content).toBe('# Preferences\n\n- Prefers short answers. [claim:clm_pref]\n');
    expect((await getRow(store, owner, 'people/' + alice + '.md'))?.content).toBe('# Alice\n\n## Juno（agent-1）\n- Greets by name. [claim:clm_alice]\n');
    // The page of a person nobody knows keeps its heading, and its one line (needs review) is in no view.
    expect(await getRow(store, owner, 'people/' + unknownPage + '.md')).toMatchObject({ content: '# Nobody\n' });

    // Once: the marker is there, and a rerun changes nothing.
    expect(await migrateMemoryItems(s.deps)).toEqual({ skipped: true, migrated: 0, reviewed: 0, fixed: 0 });
    expect(await graph.graph.items.listItems(owner)).toHaveLength(items.length);
    expect(await getRow(store, 'system', NOTE_MARKER)).not.toBeNull();
  });

  it('gives a line of a migrated file the reference it had, so the same line is never taken twice', async () => {
    const s = await owned();
    await putRow(s.store, newRow(s.owner, 'MEMORY.md', '# Memory\n\n- Has a cat.\n', 'platform', AT));
    await migrateMemoryItems(s.deps);
    const found = await graph.graph.items.findByLegacyRef(s.owner, lineHash('MEMORY.md', '- Has a cat.'));
    expect(found).toMatchObject({ text: 'Has a cat.', status: 'active' });
    expect(await graph.graph.items.addItem(s.owner, { text: 'Has a cat.', kind: 'fact', file: 'memory', saidIn: 'migrated', audience: 'owner', legacyRef: lineHash('MEMORY.md', '- Has a cat.') })).toBeNull();
  });

  it('lets a rerun make live the untagged owner line an earlier run parked for review', async () => {
    const s = await owned();
    const line = '- For my portfolio demos I show the site.';
    await putRow(s.store, newRow(s.owner, 'MEMORY.md', '# Memory\n\n' + line + '\n', 'platform', AT));
    // What the earlier run left: the same line, kept for review (no claim, not about the owner yet).
    const parked = await graph.graph.items.addItem(s.owner, { text: 'For my portfolio demos I show the site.', kind: 'fact', file: 'memory', saidIn: 'migrated', audience: 'owner', status: 'needs_review', legacyRef: lineHash('MEMORY.md', line) });
    expect(await migrateMemoryItems(s.deps)).toEqual({ skipped: false, migrated: 0, reviewed: 0, fixed: 1 });
    expect(await graph.graph.items.getItem(s.owner, parked?.id ?? '')).toMatchObject({ status: 'active', aboutPersonId: s.person.id });
    expect((await getRow(s.store, s.owner, 'MEMORY.md'))?.content).toBe('# Memory\n\n- For my portfolio demos I show the site. [mem:' + (parked?.id ?? '') + ']\n');
  });
});

describe('views', () => {
  it('renders an item about a named person into that person\'s page, and a retracted or unverified item into no view', async () => {
    const s = await owned();
    const mina = await graph.graph.identity.createPerson(s.owner, 'Mina');
    const { items } = graph.graph;
    await items.addItem(s.owner, { text: 'Mina is the user\'s sister.', kind: 'fact', file: 'person', aboutPersonId: mina.id, saidIn: 'app', audience: 'owner', status: 'active' });
    const hidden = await items.addItem(s.owner, { text: 'Mina may move.', kind: 'fact', file: 'person', aboutPersonId: mina.id, saidIn: 'app', audience: 'owner', status: 'needs_review' });
    await items.addItem(s.owner, { text: 'Mina lived in Oslo.', kind: 'experience', file: 'bank:experiences', saidIn: 'app', audience: 'owner', status: 'retracted' });
    await renderViews(s.deps, { ownerId: s.owner, agentId: 'agent-1' });
    const page = await getRow(s.store, s.owner, 'people/' + mina.id + '.md');
    expect(page?.content).toMatch(/^# Mina\n\n- Mina is the user's sister\. \[mem:mem_[0-9a-f]{32}\]\n$/);
    expect(page?.content).not.toContain('may move');
    // A view with no active line is not created: the retracted experience had nowhere to go.
    expect(await getRow(s.store, s.owner, 'memory/bank/experiences.md')).toBeNull();
    expect(hidden?.id).toBeDefined();
  });

  it('forgets a line with no claim by its item id, and the line leaves the sheet', async () => {
    const s = await owned();
    const item = await graph.graph.items.addItem(s.owner, { text: 'Owns a red bike.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner', status: 'active' });
    await renderViews(s.deps, { ownerId: s.owner, agentId: 'agent-1' });
    expect((await getRow(s.store, s.owner, 'MEMORY.md'))?.content).toContain('Owns a red bike.');
    const forgotten = await forgetClaims({ ...s.deps, memory: graph.graph }, { ownerId: s.owner, agentId: 'agent-1', claimIds: [item?.id ?? ''] });
    expect(forgotten).toEqual({ retracted: 0, removedLines: 1 });
    expect(await graph.graph.items.getItem(s.owner, item?.id ?? '')).toBeUndefined();
    expect((await getRow(s.store, s.owner, 'MEMORY.md'))?.content).not.toContain('red bike');
  });

  it('keeps one owner\'s items and views out of another owner\'s', async () => {
    const a = await owned('Ana');
    const b = await owned('Ben');
    const aItem = await graph.graph.items.addItem(a.owner, { text: 'Ana drinks coffee.', kind: 'preference', file: 'bank:preferences', saidIn: 'app', audience: 'owner', status: 'active' });
    await renderViews(a.deps, { ownerId: a.owner, agentId: 'agent-1' });
    await renderViews(b.deps, { ownerId: b.owner, agentId: 'agent-1' });
    expect(await getRow(a.store, a.owner, 'memory/bank/preferences.md')).toMatchObject({ content: '# Preferences\n\n- Ana drinks coffee. [mem:' + (aItem?.id ?? '') + ']\n' });
    expect(await getRow(b.store, b.owner, 'memory/bank/preferences.md')).toBeNull();
    expect(await graph.graph.items.listItems(b.owner)).toEqual([]);
    expect(await graph.graph.items.getItem(b.owner, aItem?.id ?? '')).toBeUndefined();
    expect(await graph.graph.items.deleteItem(b.owner, aItem?.id ?? '')).toBe(false);
  });
});

describe('agent notes in the views', () => {
  it('shows a note with the agent that wrote it, and an owner\'s change of its words keeps the author', async () => {
    const s = await owned();
    const note = await graph.graph.items.addItem(s.owner, { text: 'Robin likes tea.', kind: 'preference', file: 'bank:preferences', aboutPersonId: s.person.id, saidByAgentId: 'agent-1', saidIn: 'app', audience: 'owner' });
    await renderViews(s.deps, { ownerId: s.owner, agentId: 'agent-1' });
    const shown = (await getRow(s.store, s.owner, 'memory/bank/preferences.md'))?.content ?? '';
    expect(shown).toBe('# Preferences\n\n- Robin likes tea. (noted by Juno, agent-1) [mem:' + (note?.id ?? '') + ']\n');

    const row = await getRow(s.store, s.owner, 'memory/bank/preferences.md');
    await saveOwnerView(s.deps, { ownerId: s.owner, path: 'memory/bank/preferences.md', content: shown.replace('likes tea', 'likes green tea'), expectedHash: row?.hash });
    expect(await graph.graph.items.getItem(s.owner, note?.id ?? '')).toMatchObject({ text: 'Robin likes green tea.', saidByAgentId: 'agent-1' });
    await renderViews(s.deps, { ownerId: s.owner, agentId: 'agent-1' });
    expect((await getRow(s.store, s.owner, 'memory/bank/preferences.md'))?.content).toBe('# Preferences\n\n- Robin likes green tea. (noted by Juno, agent-1) [mem:' + (note?.id ?? '') + ']\n');
  });
});

describe('owner edits in the app', () => {
  it('turns an edited line into an update, a removed line into a retraction and a new line into an item the owner said, and a later render keeps them', async () => {
    const s = await owned();
    const { items } = graph.graph;
    const keep = await items.addItem(s.owner, { text: 'Lives in Leiden.', kind: 'fact', file: 'memory', aboutPersonId: s.person.id, saidIn: 'app', audience: 'owner', createdAt: '2026-10-01T00:00:00.000Z' });
    const drop = await items.addItem(s.owner, { text: 'Owns a red bike.', kind: 'fact', file: 'memory', aboutPersonId: s.person.id, saidIn: 'app', audience: 'owner', createdAt: '2026-10-01T00:00:01.000Z' });
    await renderViews(s.deps, { ownerId: s.owner, agentId: 'agent-1' });
    const shown = (await getRow(s.store, s.owner, 'MEMORY.md'))?.content ?? '';
    expect(shown).toBe('# Memory\n\n- Lives in Leiden. [mem:' + (keep?.id ?? '') + ']\n- Owns a red bike. [mem:' + (drop?.id ?? '') + ']\n');

    const edited = shown.replace('Lives in Leiden.', 'Lives in Utrecht.').replace(/- Owns a red bike\. \[mem:[^\]]+\]\n/, '') + '- Has a dog.\n';
    const row = await getRow(s.store, s.owner, 'MEMORY.md');
    await saveOwnerView(s.deps, { ownerId: s.owner, path: 'MEMORY.md', content: edited, expectedHash: row?.hash });

    expect(await items.getItem(s.owner, keep?.id ?? '')).toMatchObject({ text: 'Lives in Utrecht.', status: 'active' });
    expect(await items.getItem(s.owner, drop?.id ?? '')).toMatchObject({ status: 'retracted' });
    const added = (await items.listItems(s.owner, { status: 'active' })).find((item) => item.text === 'Has a dog.');
    expect(added).toMatchObject({ file: 'memory', kind: 'fact', saidByPersonId: s.person.id, saidByAgentId: null, saidIn: 'app', audience: 'owner', aboutPersonId: s.person.id });

    const after = (await getRow(s.store, s.owner, 'MEMORY.md'))?.content ?? '';
    expect(after).toBe('# Memory\n\n- Lives in Utrecht. [mem:' + (keep?.id ?? '') + ']\n- Has a dog. [mem:' + (added?.id ?? '') + ']\n');
    // A later render, from the items alone, gives the same file: the edit survived.
    await renderViews(s.deps, { ownerId: s.owner, agentId: 'agent-1' });
    expect((await getRow(s.store, s.owner, 'MEMORY.md'))?.content).toBe(after);
  });

  it('refuses an edit made on a view that changed since the owner loaded it', async () => {
    const s = await owned();
    await graph.graph.items.addItem(s.owner, { text: 'Has a cat.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner' });
    await renderViews(s.deps, { ownerId: s.owner, agentId: 'agent-1' });
    await expect(saveOwnerView(s.deps, { ownerId: s.owner, path: 'MEMORY.md', content: '# Memory\n', expectedHash: 'stale' })).rejects.toBeInstanceOf(HomeConflictError);
    expect(await graph.graph.items.listItems(s.owner, { status: 'active' })).toHaveLength(1);
  });
});

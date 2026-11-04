// Memory is per agent with a shared core (BACKEND 5.4a): what an agent learned is in its own context, search and file views only; the
// owner shares an item by changing its agent; the boot migration gives existing items to the agent that learned them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { visibleFileText } from '../../tools/tools/homeGuard.js';
import { migrateAgentMemory, MARKER } from '../agent-owner-migrate.js';
import { getRow } from '../../home/mirror.js';
import { updateOwnerItem } from '../owner-edits.js';
import { searchMemory } from '../search.js';
import { memorySectionFor } from '../section.js';
import { renderViews } from '../views.js';
import { freshOwnerId, startMemoryGraph, type MemoryGraphFixture } from './memory-graph-fixture.js';

let fixture: MemoryGraphFixture;
beforeAll(async () => {
  fixture = await startMemoryGraph();
});
afterAll(async () => {
  await fixture.close();
});

const owner = { kind: 'owner' as const };

async function setup() {
  const ownerId = freshOwnerId();
  const store = createMemoryStore();
  for (const [id, name] of [['agt-a', 'Atlas'], ['agt-b', 'Bree']] as const) await store.put('agents', { id, name, ownerId, createdAt: '2026-10-16T00:00:00.000Z' } as never);
  const person = await fixture.graph.identity.ensureOwner(ownerId, 'Robin');
  const add = (text: string, agentId: string | null, extra: Record<string, unknown> = {}) =>
    fixture.graph.items.addItem(ownerId, { text, kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner', aboutPersonId: person.id, agentId, ...extra });
  const read = (agentId: string) => fixture.graph.items.memoryFor(ownerId, owner, agentId).then((items) => items.map((item) => item.text).sort());
  return { ownerId, store, person, add, read, deps: { store, memory: fixture.graph } };
}

describe('per-agent memory', () => {
  it('shows an agent its own items and the shared core in the context, in search and in the files, and never another agent\'s', async () => {
    const s = await setup();
    await s.add('Keeps a pet axolotl called Pip', 'agt-a');
    await s.add('Is allergic to peanuts', null);
    expect(await s.read('agt-a')).toEqual(['Is allergic to peanuts', 'Keeps a pet axolotl called Pip']);
    expect(await s.read('agt-b')).toEqual(['Is allergic to peanuts']);

    const sectionOf = async (agentId: string) => (await memorySectionFor({ ...s.deps, ownerId: s.ownerId, agentId, presence: owner, wake: [], canNote: true, people: [], runStart: false, delivered: new Set() })).section;
    expect(await sectionOf('agt-a')).toContain('axolotl');
    expect(await sectionOf('agt-b')).not.toContain('axolotl');
    expect(await sectionOf('agt-b')).toContain('peanuts');

    const find = (agentId: string) => searchMemory(fixture.graph, { ownerId: s.ownerId, presence: owner, agentId, query: 'axolotl', limit: 5 });
    expect((await find('agt-a')).map((hit) => hit.item.text)).toEqual(['Keeps a pet axolotl called Pip']);
    expect(await find('agt-b')).toEqual([]);

    // The file view carries every agent's lines in sections; reading it as agent B leaves out A's.
    await renderViews(s.deps, { ownerId: s.ownerId, agentId: 'agt-a' });
    const view = (await getRow(s.store, s.ownerId, 'MEMORY.md'))?.content ?? '';
    expect(view).toContain('## Atlas（agt-a）');
    expect(visibleFileText('/juno/MEMORY.md', view, 'agt-a')).toContain('axolotl');
    const asB = visibleFileText('/juno/MEMORY.md', view, 'agt-b');
    expect(asB).not.toContain('axolotl');
    expect(asB).toContain('peanuts');
  });

  it('shares an item when the owner changes its agent to null, and takes it back with an agent id', async () => {
    const s = await setup();
    const item = await s.add('Wants replies in Dutch on Sundays', 'agt-a');
    await updateOwnerItem(s.deps, s.ownerId, item?.id ?? '', { agentId: null });
    expect(await s.read('agt-b')).toEqual(['Wants replies in Dutch on Sundays']);
    await updateOwnerItem(s.deps, s.ownerId, item?.id ?? '', { agentId: 'agt-b' });
    expect(await s.read('agt-a')).toEqual([]);
    expect(await s.read('agt-b')).toEqual(['Wants replies in Dutch on Sundays']);
  });

  it('migrates each existing item to the agent that learned it, keeps the rest shared, and runs once', async () => {
    const s = await setup();
    await s.store.put('conversations', { id: 'c-solo', ownerId: s.ownerId, kind: 'direct', agentIds: ['agt-b'] } as never);
    await s.store.put('conversations', { id: 'c-room', ownerId: s.ownerId, kind: 'room', agentIds: ['agt-a', 'agt-b'] } as never);
    await s.store.put('items', { id: 'm1', conversationId: 'c-solo', at: '2026-10-14T08:00:00Z', type: 'user_message', authorId: s.ownerId, text: 'I run marathons', attachments: [], mentions: [] });
    await s.store.put('items', { id: 'm2', conversationId: 'c-room', at: '2026-10-14T08:00:00Z', type: 'user_message', authorId: s.ownerId, text: 'I like jazz', attachments: [], mentions: [] });
    const claim = (id: string, itemId: string) => s.store.put('memoryClaims', { id, ownerId: s.ownerId, text: id, evidence: [{ itemId, quote: 'x' }], confidence: 0.9, status: 'active', target: { path: 'MEMORY.md' }, createdAt: '2026-10-14T08:00:00Z', updatedAt: '2026-10-14T08:00:00Z' } as never, { status: 'active' });
    await claim('clm_solo', 'm1');
    await claim('clm_room', 'm2');
    await s.add('Wrote by note', null, { saidByAgentId: 'agt-a' });
    await s.add('Runs marathons', null, { claimId: 'clm_solo' });
    await s.add('Likes jazz', null, { claimId: 'clm_room' });
    await s.add('Migrated line', null, { saidIn: 'migrated' });
    await s.add('Already private to A', 'agt-a');

    expect(await migrateAgentMemory(s.deps)).toMatchObject({ skipped: false, byNote: 1, byConversation: 1, keptShared: 2 });
    expect(await s.read('agt-a')).toEqual(['Already private to A', 'Wrote by note', 'Likes jazz', 'Migrated line'].sort());
    expect(await s.read('agt-b')).toEqual(['Likes jazz', 'Migrated line', 'Runs marathons'].sort());
    expect(await getRow(s.store, 'system', MARKER)).not.toBeNull();
    expect(await migrateAgentMemory(s.deps)).toMatchObject({ skipped: true });
  });
});

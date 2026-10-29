/** profile_update saves into the owner's profile; who the run serves decides what is visible and what can be saved. */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { profileIdFor } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../../testing/store.js';
import type { ToolContext, WakeEvent } from '../../../contracts/index.js';
import { createProfileUpdateTool } from '../tools/profileUpdate.js';
import { readVaultEntries, vaultSection } from '../../secure-vault/index.js';
import { profileAudience, profileSection, readProfile } from '../../profile/index.js';

type MemStore = ReturnType<typeof createMemoryStore>;
const wakeOf = (ownerId: string): WakeEvent => ({ ownerId, origin: { type: 'user', id: ownerId } }) as WakeEvent;

/** An agent of owner-1 in a direct chat (`c-direct`), a room with a guest (`c-room`) and a room of the owner alone (`c-solo`). */
async function setup(): Promise<MemStore> {
  const store = createMemoryStore();
  await store.put('agents', { id: 'a', ownerId: 'owner-1', name: 'A' } as never);
  await store.put('conversations', { id: 'c-direct', kind: 'direct', agentIds: ['a'], memberIds: ['owner-1'] } as never);
  await store.put('conversations', { id: 'c-solo', kind: 'room', agentIds: ['a'], memberIds: ['owner-1'] } as never);
  await store.put('conversations', { id: 'c-room', kind: 'room', agentIds: ['a'], memberIds: ['owner-1', 'guest'] } as never);
  return store;
}
const ctx = (store: MemStore, conversationId = 'c-direct', requester = 'owner-1'): ToolContext => ({
  ownerId: requester, agentId: 'a', conversationId, runId: 'r', store, blobs: createMemoryBlobStore(), wake: wakeOf(requester), enqueuer: {} as never,
  step: async (_n, fn) => fn(), signal: new AbortController().signal,
});
const saved = async (store: MemStore) => store.get('profiles', profileIdFor('owner-1'));

const set = (...entries: Array<{ key: string; value: string; visibility?: 'private' | 'shared' }>) => ({ set: entries });

describe('profile_update', () => {
  it('adds entries as the agent, updates a matching key in place (case-insensitive), and removes by key', async () => {
    const store = await setup();
    const tool = createProfileUpdateTool({ store });
    await tool.execute(set({ key: 'Name', value: 'Jane' }, { key: 'Work email', value: 'jane@example.com' }), ctx(store));
    const before = (await saved(store))?.entries;
    expect(before).toMatchObject([
      { key: 'Name', value: 'Jane', visibility: 'private', source: { by: 'agent', agentId: 'a', conversationId: 'c-direct' } },
      { key: 'Work email', value: 'jane@example.com' },
    ]);
    await tool.execute(set({ key: 'name', value: 'Jane Tan' }), ctx(store));
    const after = (await saved(store))?.entries;
    expect(after).toMatchObject([{ key: 'name', value: 'Jane Tan' }, { key: 'Work email' }]);
    expect(after?.[0]?.id).toBe(before?.[0]?.id);
    expect((await tool.execute({ remove: ['WORK EMAIL'] }, ctx(store))).isError).toBeUndefined();
    expect((await saved(store))?.entries.map((e) => e.key)).toEqual(['name']);
    expect((await tool.execute({ remove: ['Nope'] }, ctx(store))).isError).toBe(true);
  });

  it('refuses malformed input and secrets without touching the profile', async () => {
    const store = await setup();
    const tool = createProfileUpdateTool({ store });
    expect((await tool.execute({ firstName: 'x' }, ctx(store))).isError).toBe(true);
    expect((await tool.execute({}, ctx(store))).isError).toBe(true);
    expect((await tool.execute(set({ key: 'Shopee password', value: 'hunter2' }), ctx(store))).isError).toBe(true);
    expect((await tool.execute(set({ key: 'Visa', value: '4242 4242 4242 4242' }), ctx(store))).isError).toBe(true);
    expect((await tool.execute(set({ key: 'NRIC number', value: 'S1234567D' }), ctx(store))).isError).toBe(true);
    expect(await saved(store)).toBeNull();
    expect((await tool.execute(set({ key: 'KrisFlyer number', value: '8812345678' }), ctx(store))).isError).toBeUndefined();
  });

  it('serves private and shared to an owner-only run, shared only (plus a note) where others are present', async () => {
    const store = await setup();
    const tool = createProfileUpdateTool({ store });
    await tool.execute(set({ key: 'Name', value: 'Jane Tan' }, { key: 'Home email', value: 'jane@home.com' }, { key: 'Phone', value: '+65 9123 4567', visibility: 'shared' }), ctx(store));
    const view = async (conversationId: string) => {
      const audience = await profileAudience(store, { agentId: 'a', conversationId, wake: [wakeOf('owner-1')] });
      return profileSection(await readProfile(store, audience.profileOwnerId), audience.ownerOnly);
    };
    for (const own of ['c-direct', 'c-solo']) {
      const text = await view(own);
      expect(text).toContain('- Home email: jane@home.com');
      expect(text).toContain('- Phone: +65 9123 4567');
      expect(text).not.toContain('private and not available');
    }
    const room = await view('c-room');
    expect(room).toContain('+65 9123 4567');
    expect(room).not.toContain('jane@home.com');
    expect(room).not.toContain('Jane Tan');
    expect(room).toContain("Some of your user's details are private and not available here.");
    // A wake from someone else, or a conversation that cannot be read, is shared too.
    expect((await profileAudience(store, { agentId: 'a', conversationId: 'c-direct', wake: [wakeOf('guest')] })).ownerOnly).toBe(false);
    expect((await profileAudience(store, { agentId: 'a', conversationId: 'missing', wake: [wakeOf('owner-1')] })).ownerOnly).toBe(false);
  });

  it('shares a platform chat whoever woke it: a room always, a 1:1 chat only when the owner spoke', async () => {
    const store = await setup();
    const platform = { kind: 'telegram', channelId: 'bot-1', threadId: 'main', chatId: 'chat-1' };
    await store.put('conversations', { id: 'c-tg-room', kind: 'room', agentIds: ['a'], memberIds: ['owner-1'], channel: platform } as never);
    await store.put('conversations', { id: 'c-tg-dm', kind: 'direct', agentIds: ['a'], memberIds: ['owner-1'], channel: platform } as never);
    const ownerSpeaking = { ...wakeOf('owner-1'), trusted: true } as WakeEvent;
    const strangerSpeaking = { ownerId: 'owner-1', origin: { type: 'user' }, trusted: false } as WakeEvent;
    const backgroundReport = { ownerId: 'owner-1', origin: { type: 'system' }, trusted: false } as WakeEvent;
    const audience = (conversationId: string, wake: WakeEvent[]) => profileAudience(store, { agentId: 'a', conversationId, wake });
    expect((await audience('c-tg-room', [ownerSpeaking])).ownerOnly).toBe(false);
    expect((await audience('c-tg-dm', [ownerSpeaking])).ownerOnly).toBe(true);
    expect((await audience('c-tg-dm', [strangerSpeaking])).ownerOnly).toBe(false);
    // The agent's own background report in the owner's chat does not count as someone else speaking.
    expect((await audience('c-tg-dm', [ownerSpeaking, backgroundReport])).ownerOnly).toBe(true);
  });

  it('refuses private data in a shared run, accepts shared data there, and never lets a non-owner write', async () => {
    const store = await setup();
    const tool = createProfileUpdateTool({ store });
    expect((await tool.execute(set({ key: 'Email', value: 'a@b.com' }), ctx(store, 'c-room'))).isError).toBe(true);
    expect(await saved(store)).toBeNull();
    expect((await tool.execute(set({ key: 'Email', value: 'a@b.com', visibility: 'shared' }), ctx(store, 'c-room'))).isError).toBeUndefined();
    expect((await saved(store))?.entries).toMatchObject([{ key: 'Email', visibility: 'shared' }]);
    expect((await tool.execute(set({ key: 'Other', value: 'g@b.com', visibility: 'shared' }), ctx(store, 'c-room', 'guest'))).isError).toBe(true);
    expect((await saved(store))?.entries).toHaveLength(1);
    // A shared run can neither change nor remove a private entry.
    await tool.execute(set({ key: 'Birthday', value: '1 Jan' }), ctx(store));
    expect((await tool.execute(set({ key: 'Birthday', value: '2 Jan', visibility: 'shared' }), ctx(store, 'c-room'))).isError).toBe(true);
    expect((await tool.execute({ remove: ['birthday'] }, ctx(store, 'c-room'))).isError).toBe(true);
    expect((await tool.execute({ remove: ['birthday'] }, ctx(store))).isError).toBeUndefined();
  });

  it('lists vault labels (never values) for the agent', async () => {
    const store = await setup();
    await store.put('secureVault', { id: 'secure-vault-owner-1', entries: [{ id: 'v1', label: 'Shopee password', kind: 'password' }], updatedAt: '2026-10-15T00:00:00.000Z' });
    const text = vaultSection(await readVaultEntries(store, 'owner-1'));
    expect(text).toContain('Shopee password (password) vaultId v1');
    expect(vaultSection(await readVaultEntries(store, 'nobody'))).toBe('');
  });
});

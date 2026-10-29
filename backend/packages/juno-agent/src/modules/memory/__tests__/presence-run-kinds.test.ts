/**
 * Who a run is for, per run kind (BACKEND 5.3): the owner's own work stays owner (a child task, a routine, a monitor, a verification,
 * a calendar or task wake, a peer chain the owner started), a platform room is the group, and a stranger's chat or a peer chain that
 * started with someone else is anyone else. Presence drives the memory reads and the tool scope, so these are the same answer.
 */
import { describe, expect, it } from 'vitest';
import type { Store, WakeEvent } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { groupNoteKey } from '../../groups/note.js';
import type { AudienceWake } from '../../profile/index.js';
import { peerSenderPayload } from '../../tools/tools/relationPolicy.js';
import { presenceOf } from '../presence.js';

const OWNER = 'owner-kinds';
const OTHER_OWNER = 'owner-other-kinds';
const AGT = 'agt-kinds';
const BUD = 'agt-buddy';
const FOREIGN = 'agt-foreign';
const AT = '2026-10-26T00:00:00.000Z';
const TELEGRAM = { kind: 'telegram', channelId: 'bot-1', chatId: '-100' };
const GROUP = groupNoteKey(OWNER, { ...TELEGRAM, workspace: '' });

function wakeOf(partial: Partial<WakeEvent> & Pick<WakeEvent, 'origin' | 'trusted'>): WakeEvent {
  return {
    id: 'wke-' + String(Math.random()), ownerId: OWNER, agentId: AGT, sessionKey: AGT + ':c', conversationId: 'c', kind: 'user_message',
    priority: 'user', payload: { text: 'hi' }, at: AT, status: 'accepted', ...partial,
  } as WakeEvent;
}

/** The owner speaking in a chat (trusted), and a person other than the owner (untrusted). */
const ownerSpeaks = (): WakeEvent => wakeOf({ origin: { type: 'user', id: OWNER }, trusted: true });
const personSpeaks = (who: string): WakeEvent => wakeOf({ origin: { type: 'user', id: who }, trusted: false });

async function rooms(): Promise<Store> {
  const store = createMemoryStore();
  await store.put('agents', { id: AGT, name: 'Juno', ownerId: OWNER, createdAt: AT } as never);
  await store.put('agents', { id: BUD, name: 'Buddy', ownerId: OWNER, createdAt: AT } as never);
  await store.put('agents', { id: FOREIGN, name: 'Stranger agent', ownerId: OTHER_OWNER, createdAt: AT } as never);
  await store.put('conversations', { id: 'c-app', kind: 'direct', agentIds: [AGT], memberIds: [OWNER], ownerId: OWNER, createdAt: AT } as never);
  await store.put('conversations', { id: 'c-peer', kind: 'peer', agentIds: [AGT, BUD], memberIds: [OWNER], ownerId: OWNER, createdAt: AT } as never);
  await store.put('conversations', { id: 'c-peer-foreign', kind: 'peer', agentIds: [AGT, FOREIGN], memberIds: [OWNER], ownerId: OWNER, createdAt: AT } as never);
  await store.put('conversations', { id: 'c-group', kind: 'room', title: 'Family', agentIds: [AGT], memberIds: [OWNER, 'ext-alice'], ownerId: OWNER, channel: TELEGRAM, createdAt: AT } as never);
  await store.put('conversations', { id: 'c-stranger', kind: 'direct', agentIds: [AGT], memberIds: ['ext-bob'], ownerId: OWNER, channel: { ...TELEGRAM, chatId: '999' }, createdAt: AT } as never);
  return store;
}

const presence = (store: Store, conversationId: string, wake: AudienceWake[], agentId = AGT) =>
  presenceOf(store, { ownerId: OWNER, agentId, conversationId, wake });

describe('presence per run kind', () => {
  it('the owner speaking in the owner\'s own chat is the owner', async () => {
    expect(await presence(await rooms(), 'c-app', [ownerSpeaks()])).toEqual({ kind: 'owner' });
  });

  it('a verification check runs with the wake of the task it checks: the owner\'s chat is the owner', async () => {
    const verification = wakeOf({ origin: { type: 'user', id: OWNER }, trusted: true, kind: 'user_message', payload: { text: 'check' } });
    expect(await presence(await rooms(), 'c-app', [verification])).toEqual({ kind: 'owner' });
  });

  it('a child task of the owner\'s chat is the owner (it runs in its parent\'s chat)', async () => {
    const child = wakeOf({ origin: { type: 'agent', id: 'run-parent' }, trusted: false, kind: 'child_task', priority: 'background' });
    expect(await presence(await rooms(), 'c-app', [child])).toEqual({ kind: 'owner' });
  });

  it('a routine, a monitor\'s synthetic owner wake and a calendar wake in the owner\'s chat are the owner', async () => {
    const store = await rooms();
    const routine = wakeOf({ origin: { type: 'automation', id: 'rtn-1' }, trusted: true, kind: 'routine', priority: 'background' });
    const monitor = { ownerId: OWNER, origin: { type: 'user' as const, id: OWNER }, trusted: true };
    const calendar = wakeOf({ origin: { type: 'system', id: 'cal-1' }, trusted: true, kind: 'calendar_due', priority: 'background' });
    expect(await presence(store, 'c-app', [routine])).toEqual({ kind: 'owner' });
    expect(await presence(store, 'c-app', [monitor])).toEqual({ kind: 'owner' });
    expect(await presence(store, 'c-app', [calendar])).toEqual({ kind: 'owner' });
  });

  it('a peer between the owner\'s own agents, started by the owner, is the owner (the sender stamped its owner-only run)', async () => {
    const store = await rooms();
    const stamp = await peerSenderPayload(store, BUD, { conversationId: 'c-app', wake: ownerSpeaks() });
    const fromBuddy = wakeOf({ origin: { type: 'agent', id: BUD }, trusted: false, kind: 'agent_message', priority: 'peer', payload: { text: 'hi', ...stamp } });
    expect(await presence(store, 'c-peer', [fromBuddy], AGT)).toEqual({ kind: 'owner' });
  });

  it('a peer message without the owner-only stamp is not the owner (its chain cannot be traced)', async () => {
    const unstamped = wakeOf({ origin: { type: 'agent', id: BUD }, trusted: false, kind: 'agent_message', priority: 'peer' });
    expect(await presence(await rooms(), 'c-peer', [unstamped], AGT)).toEqual({ kind: 'other' });
  });

  it('a peer started from a group run is the group\'s, never the owner\'s', async () => {
    const store = await rooms();
    const stamp = await peerSenderPayload(store, BUD, { conversationId: 'c-group', wake: personSpeaks('ext-alice') });
    expect(stamp).not.toHaveProperty('chainOwnerOnly');
    const fromGroup = wakeOf({ origin: { type: 'agent', id: BUD }, trusted: false, kind: 'room_mention', priority: 'peer', payload: { text: 'hi', ...stamp } });
    expect(await presence(store, 'c-peer', [fromGroup], AGT)).toEqual({ kind: 'other' });
    expect(await presence(store, 'c-group', [fromGroup], AGT)).toEqual({ kind: 'group', groupKey: GROUP });
  });

  it('a peer started from a stranger\'s private chat is anyone else, even in a peer chat of the owner\'s agents', async () => {
    const store = await rooms();
    const stamp = await peerSenderPayload(store, BUD, { conversationId: 'c-stranger', wake: personSpeaks('ext-bob') });
    const fromStranger = wakeOf({ origin: { type: 'agent', id: BUD }, trusted: false, kind: 'agent_message', priority: 'peer', payload: { text: 'hi', ...stamp } });
    expect(await presence(store, 'c-peer', [fromStranger], AGT)).toEqual({ kind: 'other' });
  });

  it('a peer chat with an agent of another owner is anyone else, even when the chain started with the owner', async () => {
    const store = await rooms();
    const stamp = await peerSenderPayload(store, BUD, { conversationId: 'c-app', wake: ownerSpeaks() });
    const fromBuddy = wakeOf({ origin: { type: 'agent', id: BUD }, trusted: false, kind: 'agent_message', priority: 'peer', payload: { text: 'hi', ...stamp } });
    expect(await presence(store, 'c-peer-foreign', [fromBuddy], AGT)).toEqual({ kind: 'other' });
  });

  it('a group (a platform room with others in it) is the group, whoever woke the run', async () => {
    expect(await presence(await rooms(), 'c-group', [personSpeaks('ext-alice')])).toEqual({ kind: 'group', groupKey: GROUP });
    expect(await presence(await rooms(), 'c-group', [ownerSpeaks()])).toEqual({ kind: 'group', groupKey: GROUP });
  });

  it('a stranger\'s direct chat is anyone else', async () => {
    expect(await presence(await rooms(), 'c-stranger', [personSpeaks('ext-bob')])).toEqual({ kind: 'other' });
  });

  it('a person\'s message with no readable chat record is anyone else, while owner automation with none is the owner', async () => {
    const store = createMemoryStore();
    await store.put('agents', { id: AGT, name: 'Juno', ownerId: OWNER, createdAt: AT } as never);
    expect(await presence(store, 'c-missing', [personSpeaks(OWNER)])).toEqual({ kind: 'other' });
    const routine = wakeOf({ origin: { type: 'automation', id: 'rtn-1' }, trusted: true, kind: 'routine', priority: 'background' });
    expect(await presence(store, 'c-missing', [routine])).toEqual({ kind: 'owner' });
  });

  it('a run whose agent is unknown is anyone else', async () => {
    const store = createMemoryStore();
    await store.put('conversations', { id: 'c-app', kind: 'direct', agentIds: [AGT], memberIds: [OWNER], ownerId: OWNER, createdAt: AT } as never);
    expect(await presence(store, 'c-app', [ownerSpeaks()])).toEqual({ kind: 'other' });
  });
});

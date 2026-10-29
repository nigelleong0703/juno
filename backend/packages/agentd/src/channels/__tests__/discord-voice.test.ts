/**
 * Discord voice: fake voice link, decoder and transcriber. Covers per-speaker chunking and attribution,
 * the mention-in-text-chat wake carrying the transcript, the single final wake on leave, and the
 * not-configured refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { encryptSecret } from '@agent-desktop/contracts/secrets';
import type { Agent } from '@agent-desktop/public-contracts';
import type { Transcriber } from 'juno-agent/modules/transcription';
import { withDefaultOwner } from '../../__tests__/test-app.js';
import { DiscordVoice, type VoiceConnection } from '../discord/voice.js';
import type { JoinVoice, VoiceLink } from '../discord/voice-link.js';

const BOT = '555';
const OWNER = 'owner-1';
const OWNER_DISCORD = 'u-ann';
const AT = '2026-10-19T00:00:00.000Z';
const CONN: VoiceConnection = { rowId: 'discord:' + BOT, ownerId: OWNER, agentId: 'agent-1', botUserId: BOT, token: 'tok', send: () => undefined };

class RecordingEnqueuer implements Enqueuer {
  wakes: WakeEvent[] = [];
  async enqueue(event: WakeEvent): Promise<{ accepted: boolean }> { this.wakes.push(event); return { accepted: true }; }
  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}

function makeAgent(id: string): Agent {
  return {
    id, name: 'Juno', handle: id, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'T',
    status: 'idle', section: 'Inbox', pinned: false, lastActivity: 'x', unreadCount: 0,
    model: {
      planner: { provider: 'openai', model: 'gpt-4' },
      computer: { provider: 'openai', model: 'gpt-4-vision' },
      fast: { provider: 'openai', model: 'gpt-3.5-turbo' },
    },
    channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
    createdBy: OWNER, createdAt: AT, updatedAt: AT,
  };
}

/** One second of 48 kHz stereo PCM at a constant level; the fake decoder passes packets through. */
function loud(level: number, seconds = 1): Buffer {
  const out = Buffer.alloc(48_000 * 4 * seconds);
  for (let i = 0; i < out.length; i += 2) out.writeInt16LE(level, i);
  return out;
}

class FakeLink implements VoiceLink {
  speaking: ((userId: string) => void) | undefined;
  queued = new Map<string, Buffer[]>();
  destroyed = false;
  onSpeaking(callback: (userId: string) => void): void { this.speaking = callback; }
  async *utterance(userId: string): AsyncGenerator<Buffer> {
    for (const packet of this.queued.get(userId) ?? []) yield packet;
  }
  destroy(): void { this.destroyed = true; }
  say(userId: string, ...packets: Buffer[]): void {
    this.queued.set(userId, packets);
    this.speaking?.(userId);
  }
}

describe('discord voice', () => {
  let store: Store;
  let enqueuer: RecordingEnqueuer;
  let link: FakeLink;
  let posts: Array<{ path: string; content: string }>;
  let frames: string[];

  const names: Record<string, string> = { [OWNER_DISCORD]: 'Ann', 'u-bob': 'Bob' };
  const fakeFetch: typeof fetch = async (input, init) => {
    const path = String(input).replace('https://discord.com/api/v10', '');
    if (init?.method === 'POST') {
      posts.push({ path, content: (JSON.parse(String(init.body)) as { content: string }).content });
      return Response.json({ id: 'p' });
    }
    if (path === '/channels/vc1') return Response.json({ id: 'vc1', type: 2, guild_id: 'g1', name: 'Standup' });
    if (path === '/channels/vc2') return Response.json({ id: 'vc2', type: 2, guild_id: 'g2', name: 'Planning' });
    if (path === '/channels/text1') return Response.json({ id: 'text1', type: 0, guild_id: 'g1', name: 'general' });
    return Response.json({ message: 'unknown' }, { status: 404 });
  };
  /** The fake transcriber reads the level of the clip: 3000 is Ann's line, 5000 is Bob's. */
  const transcriber: Transcriber = {
    async transcribe(wav) {
      const level = wav.readInt16LE(44);
      return level === 3000 ? 'ship it on Friday' : level === 5000 ? 'I will write the docs' : '';
    },
  };
  const join: JoinVoice = async () => link;

  function build(options: { transcriber?: Transcriber | undefined } = { transcriber }): DiscordVoice {
    const voice = new DiscordVoice({
      store, enqueuer, transcriber: options.transcriber, fetchFn: fakeFetch, join, decoder: () => (packet) => packet,
    });
    voice.attach({ ...CONN, send: (frame) => { frames.push(frame); } });
    voice.dispatch(CONN.rowId, 'GUILD_CREATE', {
      id: 'g1',
      voice_states: [{ user_id: OWNER_DISCORD, channel_id: 'vc1', member: { user: { id: OWNER_DISCORD, username: 'ann', global_name: 'Ann' } } }],
    });
    voice.dispatch(CONN.rowId, 'VOICE_STATE_UPDATE', {
      guild_id: 'g1', user_id: 'u-bob', channel_id: 'vc1', member: { user: { id: 'u-bob', username: 'bob', global_name: 'Bob' } },
    });
    return voice;
  }

  beforeEach(async () => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 3).toString('base64'));
    store = withDefaultOwner(createMemoryStore(), OWNER);
    enqueuer = new RecordingEnqueuer();
    link = new FakeLink();
    posts = [];
    frames = [];
    await store.put('agents', makeAgent('agent-1'));
    await store.put('channels', {
      id: CONN.rowId, ownerId: OWNER, agentId: 'agent-1', kind: 'discord', channelId: BOT, ownerExternalId: OWNER_DISCORD,
      secretHashHex: 'x'.repeat(64), botToken: encryptSecret('tok'), status: 'active', createdAt: AT, updatedAt: AT,
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('says transcription is not configured and joins nothing', async () => {
    const voice = build({ transcriber: undefined });
    const reply = await voice.join({ ownerId: OWNER, agentId: 'agent-1', conversationId: 'cvn-1' });
    expect(reply).toMatchObject({ ok: false });
    expect(!reply.ok && reply.error).toContain('transcription is not configured');
    expect(posts).toEqual([]);
    expect(frames).toEqual([]);
  });

  it('joins the owner\'s voice channel and announces who the notes are for in its text chat', async () => {
    const voice = build();
    const reply = await voice.join({ ownerId: OWNER, agentId: 'agent-1', conversationId: 'cvn-1' });
    expect(reply.ok).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe('/channels/vc1/messages');
    expect(posts[0]?.content).toContain('Juno is taking notes for Ann');
  });

  it('refuses a channel that is not a voice channel and asks for one when the owner is not in voice', async () => {
    const voice = build();
    const notVoice = await voice.join({ ownerId: OWNER, agentId: 'agent-1', conversationId: 'cvn-1', channelId: 'text1' });
    expect(!notVoice.ok && notVoice.error).toContain('not a voice channel');
    voice.dispatch(CONN.rowId, 'VOICE_STATE_UPDATE', { guild_id: 'g1', user_id: OWNER_DISCORD, channel_id: null });
    const nowhere = await voice.join({ ownerId: OWNER, agentId: 'agent-1', conversationId: 'cvn-1' });
    expect(!nowhere.ok && nowhere.error).toContain('cannot see you in a voice channel');
  });

  it('transcribes each speaker separately, drops silence, and reads back by minutes', async () => {
    const voice = build();
    await voice.join({ ownerId: OWNER, agentId: 'agent-1', conversationId: 'cvn-1' });
    link.say(OWNER_DISCORD, loud(3000), loud(3000));
    link.say('u-bob', loud(5000));
    await voice.settled();
    link.say('u-bob', loud(0, 2), Buffer.alloc(100));
    await voice.settled();
    const all = await voice.transcript({ ownerId: OWNER, agentId: 'agent-1' });
    expect(all.ok && all.text).toContain('Ann: ship it on Friday');
    expect(all.ok && all.text).toContain('Bob: I will write the docs');
    expect(all.ok && all.text.match(/ship it/g)).toHaveLength(1);
    expect(all.ok && all.text.match(/docs/g)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    const stale = await voice.transcript({ ownerId: OWNER, agentId: 'agent-1', sinceMinutes: 0.0001 });
    expect(stale.ok && stale.text).toContain('Nothing has been said');
  });

  it('wakes the originating conversation once on leave, with the transcript, and not again when the channel empties', async () => {
    const voice = build();
    await voice.join({ ownerId: OWNER, agentId: 'agent-1', conversationId: 'cvn-1' });
    link.say(OWNER_DISCORD, loud(3000));
    await voice.settled();
    await voice.leave({ ownerId: OWNER, agentId: 'agent-1' });
    voice.dispatch(CONN.rowId, 'VOICE_STATE_UPDATE', { guild_id: 'g1', user_id: OWNER_DISCORD, channel_id: null });
    voice.dispatch(CONN.rowId, 'VOICE_STATE_UPDATE', { guild_id: 'g1', user_id: 'u-bob', channel_id: null });
    await voice.settled();
    await vi.waitFor(() => expect(enqueuer.wakes).toHaveLength(1));
    const wake = enqueuer.wakes[0];
    expect(wake).toMatchObject({ kind: 'hand_back', conversationId: 'cvn-1', agentId: 'agent-1', trusted: false });
    expect(wake?.payload['source']).toBe('discord_voice');
    expect(String(wake?.payload['text'])).toContain('Ann: ship it on Friday');
    expect(link.destroyed).toBe(true);
    expect(frames.map((f) => JSON.parse(f) as { op: number; d: { channel_id: string | null } }).at(-1)).toMatchObject({ op: 4, d: { channel_id: null } });
  });

  it('ends the session when the last human leaves the channel', async () => {
    const voice = build();
    await voice.join({ ownerId: OWNER, agentId: 'agent-1', conversationId: 'cvn-1' });
    voice.dispatch(CONN.rowId, 'VOICE_STATE_UPDATE', { guild_id: 'g1', user_id: OWNER_DISCORD, channel_id: null });
    expect(enqueuer.wakes).toHaveLength(0);
    voice.dispatch(CONN.rowId, 'VOICE_STATE_UPDATE', { guild_id: 'g1', user_id: 'u-bob', channel_id: null });
    await vi.waitFor(() => expect(enqueuer.wakes).toHaveLength(1));
    expect(String(enqueuer.wakes[0]?.payload['text'])).toContain('the channel is empty');
  });

  describe('on the shared Juno bot', () => {
    const OWNER2 = 'owner-2';
    let links: Map<string, FakeLink>;
    let voice: DiscordVoice;

    async function seed(agentId: string, ownerId: string, guildId: string, discordId: string): Promise<void> {
      await store.put('agents', { ...makeAgent(agentId), createdBy: ownerId });
      await store.put('channels', {
        id: `discord:${guildId}.${agentId}`, ownerId, agentId, kind: 'discord', channelId: `${guildId}.${agentId}`, installationId: 'discord:' + guildId,
        ownerExternalId: discordId, secretHashHex: 'x'.repeat(64), status: 'active', createdAt: AT, updatedAt: AT,
      });
    }

    beforeEach(async () => {
      links = new Map();
      for (const [guildId, ownerId] of [['g1', OWNER], ['g2', OWNER2]] as const) {
        await store.put('channelInstallations', { id: 'discord:' + guildId, ownerId, kind: 'discord', teamId: guildId, botToken: encryptSecret('shared'), botUserId: 'shared-bot', createdAt: AT, updatedAt: AT });
      }
      await seed('agent-a', OWNER, 'g1', OWNER_DISCORD);
      await seed('agent-b', OWNER2, 'g2', 'u-cat');
      await seed('agent-c', OWNER, 'g1', OWNER_DISCORD);
      voice = new DiscordVoice({
        store, enqueuer, transcriber, fetchFn: fakeFetch, decoder: () => (packet) => packet,
        join: async ({ guildId }) => { const created = new FakeLink(); links.set(guildId, created); return created; },
      });
      voice.attach({ rowId: 'discord-shared', shared: true, botUserId: 'shared-bot', token: 'shared', send: (frame) => { frames.push(frame); } });
      const member = (id: string, name: string) => ({ user_id: id, member: { user: { id, username: name, global_name: name } } });
      voice.dispatch('discord-shared', 'GUILD_CREATE', { id: 'g1', voice_states: [{ ...member(OWNER_DISCORD, 'Ann'), channel_id: 'vc1' }, { ...member('u-bob', 'Bob'), channel_id: 'vc1' }] });
      voice.dispatch('discord-shared', 'GUILD_CREATE', { id: 'g2', voice_states: [{ ...member('u-cat', 'Cat'), channel_id: 'vc2' }, { ...member('u-dan', 'Dan'), channel_id: 'vc2' }] });
    });

    it('joins each owner\'s own server with that owner\'s Discord id, independently', async () => {
      expect(await voice.join({ ownerId: OWNER, agentId: 'agent-a', conversationId: 'cvn-a' })).toMatchObject({ ok: true });
      expect(await voice.join({ ownerId: OWNER2, agentId: 'agent-b', conversationId: 'cvn-b' })).toMatchObject({ ok: true });
      expect(posts.map((p) => p.path)).toEqual(['/channels/vc1/messages', '/channels/vc2/messages']);
      expect(posts[0]?.content).toContain('taking notes for Ann');
      expect(posts[1]?.content).toContain('taking notes for Cat');
      expect([...links.keys()].sort()).toEqual(['g1', 'g2']);
    });

    it('refuses a channel of another server and a second agent in a server the bot already holds', async () => {
      const elsewhere = await voice.join({ ownerId: OWNER, agentId: 'agent-a', conversationId: 'cvn-a', channelId: 'vc2' });
      expect(!elsewhere.ok && elsewhere.error).toContain('not in the Discord server');
      await voice.join({ ownerId: OWNER, agentId: 'agent-a', conversationId: 'cvn-a' });
      const taken = await voice.join({ ownerId: OWNER, agentId: 'agent-c', conversationId: 'cvn-c' });
      expect(!taken.ok && taken.error).toContain('the Juno bot is already in voice channel Standup');
      const again = await voice.join({ ownerId: OWNER, agentId: 'agent-a', conversationId: 'cvn-a' });
      expect(!again.ok && again.error).toContain('discord_voice_leave');
    });

    it('wakes the session\'s own agent and conversation, and leaves the other server\'s session running', async () => {
      await voice.join({ ownerId: OWNER, agentId: 'agent-a', conversationId: 'cvn-a' });
      await voice.join({ ownerId: OWNER2, agentId: 'agent-b', conversationId: 'cvn-b' });
      links.get('g1')?.say(OWNER_DISCORD, loud(3000));
      await voice.settled();
      await voice.leave({ ownerId: OWNER, agentId: 'agent-a' });
      await vi.waitFor(() => expect(enqueuer.wakes).toHaveLength(1));
      expect(enqueuer.wakes[0]).toMatchObject({ kind: 'hand_back', ownerId: OWNER, agentId: 'agent-a', conversationId: 'cvn-a' });
      expect(String(enqueuer.wakes[0]?.payload['text'])).toContain('Ann: ship it on Friday');
      expect(links.get('g1')?.destroyed).toBe(true);
      expect(links.get('g2')?.destroyed).toBe(false);
      voice.dispatch('discord-shared', 'VOICE_STATE_UPDATE', { guild_id: 'g2', user_id: 'u-cat', channel_id: null });
      voice.dispatch('discord-shared', 'VOICE_STATE_UPDATE', { guild_id: 'g2', user_id: 'u-dan', channel_id: null });
      await vi.waitFor(() => expect(enqueuer.wakes).toHaveLength(2));
      expect(enqueuer.wakes[1]).toMatchObject({ ownerId: OWNER2, agentId: 'agent-b', conversationId: 'cvn-b' });
    });

    it('adds the recent transcript to a shared message in the voice channel\'s chat, only for that server', async () => {
      await voice.join({ ownerId: OWNER, agentId: 'agent-a', conversationId: 'cvn-a' });
      await voice.join({ ownerId: OWNER2, agentId: 'agent-b', conversationId: 'cvn-b' });
      links.get('g1')?.say(OWNER_DISCORD, loud(3000));
      await voice.settled();
      const event = (chatId: string) => ({ chatId, chatType: 'group' as const, threadId: chatId, externalMessageId: 'm' + chatId, from: { id: 'u-bob', name: 'Bob' }, text: 'what did we decide?' });
      expect(voice.decorate('discord-shared', event('vc1')).text).toContain('Ann: ship it on Friday');
      expect(voice.decorate('discord-shared', event('vc2')).text).toBe('what did we decide?');
    });
  });
});

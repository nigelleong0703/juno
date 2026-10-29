/**
 * CH8 Lark meetings: join + announce, the invitation paths, the events poller (page token, transcript, mention wake,
 * one final wake) and the error mapping. A fake Lark (fetch) and a recording enqueuer; no network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { ChannelRow, Enqueuer, Store, WakeEvent } from '@agent-desktop/contracts';
import { encryptSecret } from '@agent-desktop/contracts/secrets';
import type { Agent } from '@agent-desktop/public-contracts';
import { clearFeishuTokenCache } from '@agent-desktop/channels/feishu/api';
import { deliverMeetingReports } from '../../meetings/session.js';
import { createMeetingPort, handleMeetingInvite, parseMeetingInvite, startMeetingPoller, type MeetingDeps } from '../feishu/meeting.js';

const OWNER = 'owner-1';
const AT = '2026-10-19T00:00:00.000Z';
const OWNER_OPEN = 'ou_owner';
const BOT = 'ou_bot';
const CALLER = { ownerId: OWNER, agentId: 'agent-1', conversationId: 'cvn-group' };

class Recorder implements Enqueuer {
  wakes: WakeEvent[] = [];
  async enqueue(event: WakeEvent) { this.wakes.push(event); return { accepted: true }; }
  async stopRun() {}
  async resolveAwakeable() {}
  async scheduleRoutine() {}
}

interface Call { path: string; body: Record<string, unknown> }

/** A scripted Lark: events pages are served in order, keyed by the page_token the poller sends. */
function makeLark(opts: { joinCode?: number; pages?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
    const path = url.pathname + url.search;
    calls.push({ path, body });
    if (url.pathname.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 't', expire: 7200 });
    if (url.pathname.endsWith('/bot/v3/info')) return Response.json({ code: 0, bot: { open_id: BOT, app_name: 'Juno' } });
    if (url.pathname.endsWith('/bots/join')) {
      return opts.joinCode ? Response.json({ code: opts.joinCode, msg: 'nope' }) : Response.json({ code: 0, data: { meeting: { id: 'm-1', meeting_no: body['join_identify'] ? '123456789' : '', topic: 'Weekly sync' } } });
    }
    if (url.pathname.endsWith('/bots/events')) {
      const token = url.searchParams.get('page_token') ?? '';
      return Response.json({ code: 0, data: opts.pages?.[token] ?? { events: [], has_more: false, page_token: token } });
    }
    if (url.pathname.endsWith('/im/v1/messages')) return Response.json({ code: 0, data: { message_id: 'om_1', chat_id: 'oc_dm' } });
    return Response.json({ code: 0, data: {} });
  };
  return { fetchFn, calls, to: (suffix: string) => calls.filter((c) => c.path.includes(suffix)) };
}

const speech = (text: string, who = 'Alice') => ({ event_id: 'e-' + text, event_type: 'transcript_received', event_time: '1760832000000', payload: { transcript_received_items: [{ speaker: { id: 'ou_a', user_name: who }, text, start_time_ms: '1760832001000' }] } });
const chat = (content: string, id = 'c1', from = 'ou_a') => ({ event_id: id, event_type: 'chat_received', event_time: '1760832002000', payload: { chat_received_items: [{ operator: { id: from, user_name: 'Alice' }, content, message_type: 1, send_time: '1760832002000' }] } });
const left = (reason: number, id = 'ou_a') => ({ event_id: 'l-' + String(reason) + id, event_type: 'participant_left', event_time: '1760832010000', payload: { participant_left_items: [{ participant: { id }, leave_reason: reason }] } });

describe('Lark meetings', () => {
  let store: Store;
  let enqueuer: Recorder;

  const deps = (fetchFn: typeof fetch): MeetingDeps => ({ store, enqueuer, fetchFn });
  const channel = (): Promise<ChannelRow | null> => store.get('channels', 'feishu:cli_a1');

  beforeEach(async () => {
    vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 3).toString('base64'));
    clearFeishuTokenCache();
    store = createMemoryStore();
    enqueuer = new Recorder();
    await store.put('channels', {
      id: 'feishu:cli_a1', ownerId: OWNER, agentId: 'agent-1', kind: 'feishu', channelId: 'cli_a1', secretHashHex: 'h',
      botToken: encryptSecret('app-secret'), ownerExternalId: OWNER_OPEN, createdAt: AT, updatedAt: AT,
    });
    await (store.forOwner?.(OWNER) ?? store).put('agents', { id: 'agent-1', name: 'Juno', createdBy: OWNER } as unknown as Agent);
  });

  it('joins, announces who the notes are for, and stores the session', async () => {
    const lark = makeLark();
    const port = createMeetingPort(deps(lark.fetchFn));
    expect(await port.available('agent-1')).toBe(true);
    expect(await port.available('agent-2')).toBe(false);
    const out = await port.join(CALLER, { meetingNumber: '123456789', password: 'pw' });
    expect(out.ok).toBe(true);
    expect(lark.to('/bots/join')[0]?.body).toEqual({ join_type: 1, join_identify: { meeting_no: '123456789' }, password: 'pw' });
    expect(lark.to('/bots/message')[0]?.body).toEqual({ meeting_id: 'm-1', msg_type: 'text', content: 'Juno is taking notes for its owner' });
    const session = await store.get('meetingSessions', 'meet-agent-1-m-1');
    expect(session).toMatchObject({ status: 'active', conversationId: 'cvn-group', meetingId: 'm-1', ownerId: OWNER });
  });

  it('maps 20017 and 121003 to explanations and stores nothing', async () => {
    for (const [code, words] of [[20017, 'beta'], [121003, 'waiting room']] as const) {
      const out = await createMeetingPort(deps(makeLark({ joinCode: code }).fetchFn)).join(CALLER, { meetingNumber: '123456789' });
      expect(out.ok).toBe(false);
      expect(out.message).toContain(words);
    }
    expect((await store.list('meetingSessions', {})).items).toEqual([]);
  });

  it('an invitation from the owner joins at once with its call_id', async () => {
    const lark = makeLark();
    const row = await channel();
    await handleMeetingInvite(deps(lark.fetchFn), row as ChannelRow, { meeting: { meeting_no: '123456789', topic: 'Weekly sync' }, call_id: 'call-7', inviter: { id: { open_id: OWNER_OPEN } } });
    expect(lark.to('/bots/join')[0]?.body).toMatchObject({ call_id: 'call-7' });
    const session = await store.get('meetingSessions', 'meet-agent-1-m-1');
    expect(session?.status).toBe('active');
    expect(session?.conversationId).toMatch(/^cvn-/);
    expect(lark.to('receive_id_type=open_id').length).toBeGreaterThan(0);
  });

  it('an invitation from a stranger asks the owner and waits; the owner\'s yes joins with the call_id', async () => {
    const lark = makeLark();
    const row = await channel();
    await handleMeetingInvite(deps(lark.fetchFn), row as ChannelRow, { meeting_no: '123456789', call_id: 'call-9', inviter: { id: { open_id: 'ou_stranger' } } });
    expect(lark.to('/bots/join')).toEqual([]);
    const dm = lark.to('receive_id_type=open_id')[0]?.body;
    expect(dm?.['receive_id']).toBe(OWNER_OPEN);
    expect(String(dm?.['content'])).toContain('Shall I join');
    expect((await store.get('meetingSessions', 'meet-invite-agent-1-123456789'))?.status).toBe('invited');
    await createMeetingPort(deps(lark.fetchFn)).join(CALLER, { meetingNumber: '123456789' });
    expect(lark.to('/bots/join')[0]?.body).toMatchObject({ call_id: 'call-9' });
    expect(await store.get('meetingSessions', 'meet-invite-agent-1-123456789')).toBeNull();
  });

  it('reads the invitation leniently and rejects a bad number', () => {
    expect(parseMeetingInvite({ event: { meeting: { meeting_no: '123456789' }, call_id: 'c' } })).toEqual({ meetingNumber: '123456789', callId: 'c' });
    expect(parseMeetingInvite({ meeting_no: '12345' })).toBeNull();
  });

  describe('polling', () => {
    async function joined(lark: ReturnType<typeof makeLark>) {
      await createMeetingPort(deps(lark.fetchFn)).join(CALLER, { meetingNumber: '123456789' });
    }

    it('follows the page token and accumulates transcript lines', async () => {
      const lark = makeLark({ pages: {
        '': { events: [speech('hello everyone'), chat('see the doc')], has_more: false, page_token: 'p1' },
        p1: { events: [speech('second thing', 'Bob')], has_more: false, page_token: 'p2' },
      } });
      await joined(lark);
      const poller = startMeetingPoller(deps(lark.fetchFn), 3_600_000);
      await poller.tick();
      await poller.tick();
      poller.stop();
      const events = lark.to('/bots/events');
      expect(events[0]?.path).not.toContain('page_token');
      expect(events[1]?.path).toContain('page_token=p1');
      const session = await store.get('meetingSessions', 'meet-agent-1-m-1');
      expect(session?.pageToken).toBe('p2');
      expect(session?.lines.map((l) => l.who + ':' + l.text)).toEqual(['Alice:hello everyone', 'Alice:see the doc', 'Bob:second thing']);
      expect(enqueuer.wakes).toEqual([]);
    });

    it('wakes the agent for a chat that mentions the bot, with the transcript, and ignores its own messages', async () => {
      const lark = makeLark({ pages: { '': { events: [speech('budget is 5k'), chat('@Juno what is the budget?', 'q1'), chat('Juno says: 5k', 'own', BOT)], has_more: false, page_token: 'p1' } } });
      await joined(lark);
      const poller = startMeetingPoller(deps(lark.fetchFn), 3_600_000);
      await poller.tick();
      poller.stop();
      expect(enqueuer.wakes).toHaveLength(1);
      const wake = enqueuer.wakes[0] as WakeEvent;
      const session = await store.get('meetingSessions', 'meet-agent-1-m-1');
      // The wake runs in the meeting's own conversation, not in the chat that asked; the chat lines are items there.
      expect(session?.meetingConversationId).toBeDefined();
      expect(session?.meetingConversationId).not.toBe('cvn-group');
      expect(wake).toMatchObject({ conversationId: session?.meetingConversationId, agentId: 'agent-1', trusted: false, id: 'wk-meeting-q-meet-agent-1-m-1-q1', payload: { speakerRole: 'stranger', speakerName: 'Alice' } });
      const items = await store.list('items', { where: { conversationId: session?.meetingConversationId ?? '' } });
      expect(items.items.map((i) => (i.type === 'user_message' ? i.text : ''))).toContain('@Juno what is the budget?');
      expect(String(wake.payload['text'])).toContain('what is the budget');
      expect(String(wake.payload['text'])).toContain('budget is 5k');
    });

    it('wakes the meeting subagent once when the meeting ends, then stops polling', async () => {
      const lark = makeLark({ pages: { '': { events: [speech('wrap up'), left(2)], has_more: false, page_token: 'p1' } } });
      await joined(lark);
      const poller = startMeetingPoller(deps(lark.fetchFn), 3_600_000);
      await poller.tick();
      await poller.tick();
      poller.stop();
      expect(enqueuer.wakes).toHaveLength(1);
      const ended = await store.get('meetingSessions', 'meet-agent-1-m-1');
      expect(enqueuer.wakes[0]).toMatchObject({ id: 'wk-meeting-end-meet-agent-1-m-1', kind: 'webhook', conversationId: ended?.meetingConversationId });
      expect(String(enqueuer.wakes[0]?.payload['text'])).toContain('wrap up');
      expect(lark.to('/bots/events')).toHaveLength(1);
      expect(ended).toMatchObject({ status: 'ended', endReason: 'ended', report: 'pending' });
      // The subagent's run finishes with a reply in the meeting thread: it goes to the chat that asked, once.
      const conversationId = ended?.meetingConversationId ?? '';
      const at = new Date(Date.now() + 1000).toISOString();
      const owned = store.forOwner?.(OWNER) ?? store;
      await owned.put('runs', { id: 'run-end', agentId: 'agent-1', conversationId, title: 'end', status: 'completed', kind: 'background', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: at, finishedAt: at, lastActivityAt: at } as never);
      await owned.put('items', { id: 'itm-r', conversationId, type: 'agent_message', at, agentId: 'agent-1', markdown: 'Notes: wrap up done.', citations: [], runId: 'run-end' } as never, { conversationId, runId: 'run-end' });
      await deliverMeetingReports(deps(lark.fetchFn), Date.now());
      await deliverMeetingReports(deps(lark.fetchFn), Date.now());
      expect(enqueuer.wakes).toHaveLength(2);
      expect(enqueuer.wakes[1]).toMatchObject({ id: 'wk-meeting-report-meet-agent-1-m-1', kind: 'hand_back', conversationId: 'cvn-group' });
      expect(String(enqueuer.wakes[1]?.payload['text'])).toContain('Notes: wrap up done.');
    });

    it('being removed ends the session; an events error that says the meeting is over ends it too', async () => {
      const lark = makeLark({ pages: { '': { events: [left(3, BOT)], has_more: false, page_token: 'p1' } } });
      await joined(lark);
      const poller = startMeetingPoller(deps(lark.fetchFn), 3_600_000);
      await poller.tick();
      poller.stop();
      expect(await store.get('meetingSessions', 'meet-agent-1-m-1')).toMatchObject({ status: 'ended', endReason: 'removed' });
    });

    it('meeting_leave leaves, ends the session and wakes for the notes; the transcript stays readable', async () => {
      const lark = makeLark({ pages: { '': { events: [speech('bye')], has_more: false, page_token: 'p1' } } });
      await joined(lark);
      const port = createMeetingPort(deps(lark.fetchFn));
      const poller = startMeetingPoller(deps(lark.fetchFn), 3_600_000);
      await poller.tick();
      poller.stop();
      const out = await port.leave(CALLER);
      expect(out.ok).toBe(true);
      expect(lark.to('/bots/leave')[0]?.body).toEqual({ meeting_id: 'm-1' });
      expect(enqueuer.wakes.map((w) => w.id)).toEqual(['wk-meeting-end-meet-agent-1-m-1']);
      expect((await port.transcript(CALLER)).message).toContain('Alice: bye');
      expect((await port.say(CALLER, 'hi')).ok).toBe(false);
    });
  });
});

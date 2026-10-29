/**
 * Lark / Feishu live meetings (CH8): the agent's channel app joins a video meeting as the app bot and works from
 * the real-time transcript events (no minutes product involved).
 *
 * Three entry points share one `attend` path: the agent tools (`createMeetingPort`), the `vc.bot.meeting_invited_v1`
 * invitation (`handleMeetingInvite`), and the poller (`startMeetingPoller`) that reads `GET vc/v1/bots/events` every
 * few seconds with the stored page token, appends transcript lines to the `meetingSessions` row, wakes the agent when
 * the meeting chat addresses the bot, and hands the record back once when the meeting is over.
 * Everything after the events (the meeting's own conversation, the record file, the wakes, the end) is the platform-neutral
 * meeting session layer in ../meetings/session.ts. Every Lark call goes through `feishuCall`, so the tenant token cache is the channel's own.
 */
import { createLogger } from '@agent-desktop/log';
import { decryptSecret } from '@agent-desktop/contracts/secrets';
import type { ChannelRow, MeetingLine, MeetingSession, Store } from '@agent-desktop/contracts';
import type { MeetingOutcome, MeetingPort } from 'juno-agent/modules/tools/tools/meetingTools';
import { runWithOwner } from 'juno-agent/owner-context';
import { channelConversationId } from '../../routes/channels.js';
import { feishuCall, fetchFeishuBotInfo, type FeishuCall, type FeishuCredentials } from '@agent-desktop/channels/feishu/api';
import { addressesAgent, endMeeting, markNoted, openMeeting, ownerNameOf, pendingLines, platformOf, recordLines, scoped, wakeInMeeting, wakeLines, type MeetingLayerDeps, type NewLine } from '../../meetings/session.js';
import { endMeetSessionByLeave, startMeetSession, type MeetDeps } from '../../meetings/meet.js';

const log = createLogger({ service: 'agentd' });

const POLL_MS = 3000;
const MAX_PAGES_PER_TICK = 5;
/** Consecutive failed polls (about a minute) before an unreadable meeting is given up on. */
const LOST_AFTER_FAILURES = 20;
const NOTES_CHARS = 60_000;

const BOT_JOIN = '/open-apis/vc/v1/bots/join';
const BOT_LEAVE = '/open-apis/vc/v1/bots/leave';
const BOT_MESSAGE = '/open-apis/vc/v1/bots/message';
const BOT_EVENTS = '/open-apis/vc/v1/bots/events';

export interface MeetingDeps extends MeetingLayerDeps {
  fetchFn?: typeof fetch;
  /** Google Meet through the agent's computer (via computerd): present, the port also opens Meet sessions. */
  meet?: MeetDeps['meet'];
}

// ---- small readers -----------------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function asString(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Lark times arrive as ms or seconds, as numbers or strings, or as RFC 3339. */
function parseTime(value: unknown): number | undefined {
  const text = asString(value).trim();
  if (text === '') return undefined;
  if (/^\d+$/.test(text)) return text.length >= 13 ? Number(text) : Number(text) * 1000;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function credsOf(row: ChannelRow): FeishuCredentials {
  return { appId: row.channelId, appSecret: row.botToken === undefined ? '' : decryptSecret(row.botToken), domain: row.domain ?? 'feishu' };
}

// ---- Lark API ----------------------------------------------------------------------------------------

/** What a failed meeting call means for the owner, in words the agent can pass on. */
export function describeMeetingError(call: { status: number; code?: number; error: string }): string {
  switch (call.code) {
    case 20017:
      return 'Lark has not enabled bot meetings for this workspace (error 20017): the app-bot-in-meetings feature is still a beta that the tenant has to be switched on for. Ask the workspace admin or Lark support to enable it for this app, then try again.';
    case 121003:
      return 'Lark would not let the bot in (error 121003). Usual causes: the meeting number is wrong, the meeting needs a password (missing or wrong), the meeting has not started yet, the host has a waiting room or join approval and has not admitted the bot, or the meeting does not allow external or app participants.';
    case 20001:
      return 'That meeting has already ended.';
    case 20002:
      return 'Lark does not know that meeting (it may be over, or the id is wrong).';
    case 10005:
      return 'The bot is not in that meeting (it was removed, or it never joined).';
    default:
      return 'Lark refused the request' + (call.code === undefined ? '' : ' (error ' + String(call.code) + ')') + ': ' + call.error;
  }
}

function dataOf(call: FeishuCall<Record<string, unknown>>): Record<string, unknown> {
  return call.ok ? asRecord(call.data['data']) : {};
}

async function botJoin(f: typeof fetch, creds: FeishuCredentials, input: { meetingNumber: string; password?: string | undefined; callId?: string | undefined }) {
  const body: Record<string, unknown> = { join_type: 1, join_identify: { meeting_no: input.meetingNumber } };
  if (input.password !== undefined && input.password !== '') body['password'] = input.password;
  if (input.callId !== undefined && input.callId !== '') body['call_id'] = input.callId;
  return feishuCall(f, creds, 'POST', BOT_JOIN, body);
}

function botSay(f: typeof fetch, creds: FeishuCredentials, meetingId: string, text: string) {
  return feishuCall(f, creds, 'POST', BOT_MESSAGE, { meeting_id: meetingId, msg_type: 'text', content: text });
}

function botLeave(f: typeof fetch, creds: FeishuCredentials, meetingId: string) {
  return feishuCall(f, creds, 'POST', BOT_LEAVE, { meeting_id: meetingId });
}

function botEvents(f: typeof fetch, creds: FeishuCredentials, meetingId: string, pageToken: string | undefined) {
  const query = new URLSearchParams({ meeting_id: meetingId, page_size: '100' });
  if (pageToken !== undefined && pageToken !== '') query.set('page_token', pageToken);
  return feishuCall(f, creds, 'GET', BOT_EVENTS + '?' + query.toString());
}

/** A direct message to the owner by open_id: the reply carries the DM's chat_id, which names the conversation. */
async function dmOwner(f: typeof fetch, creds: FeishuCredentials, ownerOpenId: string, text: string): Promise<FeishuCall<string>> {
  const res = await feishuCall(f, creds, 'POST', '/open-apis/im/v1/messages?receive_id_type=open_id', { receive_id: ownerOpenId, msg_type: 'text', content: JSON.stringify({ text }) });
  if (!res.ok) return res;
  const chatId = asString(dataOf(res)['chat_id']);
  return chatId === '' ? { ok: false, status: 502, error: 'Lark did not return the chat of the direct message' } : { ok: true, data: chatId };
}

// ---- sessions ----------------------------------------------------------------------------------------

const sessionId = (agentId: string, meetingId: string): string => 'meet-' + agentId + '-' + meetingId;
const inviteId = (agentId: string, meetingNumber: string): string => 'meet-invite-' + agentId + '-' + meetingNumber;

async function feishuChannelOf(store: Store, agentId: string): Promise<ChannelRow | undefined> {
  const page = await store.list('channels', { where: { agentId, kind: 'feishu' }, limit: 20 });
  return page.items.find((row) => row.status !== 'invalid_token' && row.botToken !== undefined);
}

/** The agent's live meeting: the one this chat or meeting conversation belongs to, else the newest. `platform` limits it to one kind. */
async function activeSessionOf(store: Store, agentId: string, conversationId?: string, platform?: 'feishu' | 'meet'): Promise<MeetingSession | undefined> {
  const page = await store.list('meetingSessions', { where: { agentId, status: 'active' }, orderBy: 'at', order: 'desc', limit: 20 });
  const items = page.items.filter((s) => platform === undefined || platformOf(s) === platform);
  return items.find((s) => s.conversationId === conversationId || s.meetingConversationId === conversationId) ?? items[0];
}

function offset(session: MeetingSession, at: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(at) - Date.parse(session.startedAt)) / 1000));
  const h = Math.floor(seconds / 3600);
  const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return (h > 0 ? String(h) + ':' : '') + mm + ':' + ss;
}

function formatLines(session: MeetingSession, lines: readonly MeetingLine[], maxChars: number): string {
  const rendered = lines.map((line) => '[' + offset(session, line.at) + '] ' + line.who + (line.chat ? ' (meeting chat)' : '') + ': ' + line.text);
  let total = 0;
  let from = rendered.length;
  while (from > 0 && total + (rendered[from - 1] ?? '').length + 1 <= maxChars) { from -= 1; total += (rendered[from] ?? '').length + 1; }
  const kept = rendered.slice(from).join('\n');
  return from > 0 ? '(' + String(from) + ' earlier lines left out)\n' + kept : kept;
}

function titleOf(session: MeetingSession): string {
  return (session.topic === undefined || session.topic === '' ? 'meeting' : '"' + session.topic + '"') + ' (' + session.meetingNumber + ')';
}

// ---- wakes -------------------------------------------------------------------------------------------

/** `unseen`: what was said since the subagent last saw the meeting (empty for a second question in the same pass). */
function questionText(session: MeetingSession, who: string, content: string, unseen: readonly MeetingLine[]): string {
  return [
    '[Live meeting ' + titleOf(session) + ': ' + who + ' wrote to you in the meeting chat]',
    content,
    '',
    ...(unseen.length === 0 ? [] : ['What was said and typed since you last saw the meeting:', wakeLines(unseen), '']),
    'Answer in the meeting with meeting_say: short, in the language of the question. Say nothing there if it was not really a question for you. End with an empty reply: only meeting_say reaches the room.',
  ].join('\n');
}

// ---- attending ---------------------------------------------------------------------------------------

interface AttendInput {
  row: ChannelRow;
  ownerId: string;
  conversationId: string;
  meetingNumber: string;
  password?: string | undefined;
  callId?: string | undefined;
}

/** Join, record the session and announce. The same path serves the tool and the invitation. */
async function attend(deps: MeetingDeps, input: AttendInput): Promise<MeetingOutcome> {
  const f = deps.fetchFn ?? fetch;
  const { row } = input;
  const creds = credsOf(row);
  const store = scoped(deps.store, input.ownerId);
  const joined = await botJoin(f, creds, input);
  if (!joined.ok) return { ok: false, message: describeMeetingError(joined) };
  const meeting = asRecord(dataOf(joined)['meeting']);
  const meetingId = asString(meeting['id']);
  if (meetingId === '') return { ok: false, message: 'Lark accepted the join but returned no meeting id, so the meeting cannot be followed. Leave and try again.' };
  const id = sessionId(row.agentId, meetingId);
  const existing = await store.get('meetingSessions', id);
  const now = new Date().toISOString();
  const topic = asString(meeting['topic']);
  if (existing?.status === 'active') return { ok: true, message: 'Already in meeting ' + titleOf(existing) + '; taking notes.' };
  const session: MeetingSession = {
    id, ownerId: input.ownerId, agentId: row.agentId, channelRowId: row.id, conversationId: input.conversationId, status: 'active', platform: 'feishu',
    meetingNumber: input.meetingNumber, meetingId, ...(topic === '' ? {} : { topic }), lines: [], startedAt: now, updatedAt: now,
  };
  await store.put('meetingSessions', await openMeeting(deps, session));
  await store.delete('meetingSessions', inviteId(row.agentId, input.meetingNumber)).catch(() => undefined);
  const agent = await store.get('agents', row.agentId);
  const owner = await ownerNameOf(store, input.ownerId);
  const said = await botSay(f, creds, meetingId, (agent?.name ?? 'The assistant') + ' is taking notes for ' + (owner ?? 'its owner'));
  if (!said.ok) log.warn({ session: id, error: said.error }, 'meeting announcement was not posted');
  return {
    ok: true,
    message: 'Joined ' + titleOf(session) + ' and told the room you are taking notes' + (said.ok ? '' : ' (the announcement itself failed: ' + describeMeetingError(said) + ')') +
      '. Questions to you in the meeting chat will wake you; answer with meeting_say. When the meeting ends you are woken to write the notes.',
  };
}

// ---- the agent-facing port ---------------------------------------------------------------------------

export function createMeetingPort(deps: MeetingDeps): MeetingPort {
  const f = (): typeof fetch => deps.fetchFn ?? fetch;
  const meet = deps.meet;
  return {
    ...(meet === undefined ? {} : {
      meetJoined: (caller: Parameters<NonNullable<MeetingPort['meetJoined']>>[0], input: Parameters<NonNullable<MeetingPort['meetJoined']>>[1]) => startMeetSession({ ...deps, meet }, caller, input),
      meetLeft: (caller: Parameters<NonNullable<MeetingPort['meetLeft']>>[0]) => endMeetSessionByLeave({ ...deps, meet }, caller),
    }),
    async available(agentId) {
      return (await feishuChannelOf(deps.store, agentId)) !== undefined;
    },

    async join(caller, input) {
      const row = await feishuChannelOf(deps.store, caller.agentId);
      if (row === undefined) return { ok: false, message: 'This agent has no Feishu / Lark channel, so it cannot attend meetings.' };
      const store = scoped(deps.store, caller.ownerId);
      const invite = await store.get('meetingSessions', inviteId(caller.agentId, input.meetingNumber));
      return attend(deps, {
        row, ownerId: caller.ownerId, conversationId: caller.conversationId, meetingNumber: input.meetingNumber,
        password: input.password ?? invite?.password, callId: invite?.callId,
      });
    },

    async leave(caller) {
      const store = scoped(deps.store, caller.ownerId);
      const session = await activeSessionOf(store, caller.agentId, caller.conversationId, 'feishu');
      if (session?.meetingId === undefined) return { ok: false, message: 'You are not in a meeting.' };
      const row = await store.get('channels', session.channelRowId);
      if (row === null) return { ok: false, message: 'The Lark channel of this meeting is gone.' };
      const left = await botLeave(f(), credsOf(row), session.meetingId);
      if (!left.ok && left.code !== 20001 && left.code !== 10005) return { ok: false, message: describeMeetingError(left) };
      await endMeeting(deps, session, 'left');
      return { ok: true, message: 'Left ' + titleOf(session) + '. Your meeting subagent writes the notes and its report reaches you in a follow-up message; do not write them now.' };
    },

    async say(caller, text) {
      const store = scoped(deps.store, caller.ownerId);
      const session = await activeSessionOf(store, caller.agentId, caller.conversationId, 'feishu');
      if (session?.meetingId === undefined) return { ok: false, message: 'You are not in a meeting.' };
      const row = await store.get('channels', session.channelRowId);
      if (row === null) return { ok: false, message: 'The Lark channel of this meeting is gone.' };
      const sent = await botSay(f(), credsOf(row), session.meetingId, text);
      return sent.ok ? { ok: true, message: 'Posted in the meeting chat.' } : { ok: false, message: describeMeetingError(sent) };
    },

    async transcript(caller, sinceMinutes) {
      const store = scoped(deps.store, caller.ownerId);
      let session = await activeSessionOf(store, caller.agentId, caller.conversationId);
      if (session === undefined) {
        // (no live meeting: the latest one that ended)
        const recent = await store.list('meetingSessions', { where: { agentId: caller.agentId, status: 'ended' }, orderBy: 'at', order: 'desc', limit: 1 });
        session = recent.items[0];
      }
      if (session === undefined) return { ok: false, message: 'There is no meeting to read: you have not attended one.' };
      const cutoff = sinceMinutes === undefined ? 0 : Date.now() - sinceMinutes * 60_000;
      const lines = session.lines.filter((line) => Date.parse(line.at) >= cutoff);
      const head = titleOf(session) + (session.status === 'active' ? ' (live)' : ' (ended)') + ':\n';
      return { ok: true, message: head + (formatLines(session, lines, NOTES_CHARS) || '(nothing said' + (sinceMinutes === undefined ? '' : ' in that time') + ')') };
    },
  };
}

// ---- ending ------------------------------------------------------------------------------------------

/** End a session (the layer marks it ended and hands the record back once; the wake id is fixed, so a retry cannot post it twice). */
async function finish(deps: MeetingDeps, session: MeetingSession, reason: string): Promise<void> {
  await endMeeting(deps, session, reason);
}

// ---- invitation --------------------------------------------------------------------------------------

export interface MeetingInvite {
  meetingNumber: string;
  callId?: string;
  inviterId?: string;
  topic?: string;
  password?: string;
}

/** The `vc.bot.meeting_invited_v1` body, read leniently: the field names are not in the CLI's docs. */
export function parseMeetingInvite(data: unknown): MeetingInvite | null {
  const root = asRecord(data);
  const body = Object.keys(asRecord(root['event'])).length > 0 ? asRecord(root['event']) : root;
  const meeting = asRecord(body['meeting']);
  const meetingNumber = asString(meeting['meeting_no'] ?? body['meeting_no']).trim();
  if (!/^\d{9}$/.test(meetingNumber)) return null;
  const who = (value: unknown): string => {
    const rec = asRecord(value);
    return asString(asRecord(rec['id'])['open_id'] ?? rec['open_id'] ?? rec['id']);
  };
  const callId = asString(body['call_id'] ?? meeting['call_id']);
  const inviterId = who(body['inviter'] ?? body['operator'] ?? body['inviter_id']);
  const topic = asString(meeting['topic'] ?? body['topic']);
  const password = asString(body['password'] ?? meeting['password']);
  return {
    meetingNumber,
    ...(callId === '' ? {} : { callId }),
    ...(inviterId === '' ? {} : { inviterId }),
    ...(topic === '' ? {} : { topic }),
    ...(password === '' ? {} : { password }),
  };
}

/** Send the owner a DM (by open_id) and make sure the DM conversation exists with that message in it, so the agent knows what a later "yes" refers to. */
async function noteToOwner(deps: MeetingDeps, row: ChannelRow, text: string): Promise<{ conversationId: string } | undefined> {
  if (row.ownerExternalId === undefined) return undefined;
  const sent = await dmOwner(deps.fetchFn ?? fetch, credsOf(row), row.ownerExternalId, text);
  if (!sent.ok) {
    log.warn({ channel: row.id, error: sent.error }, 'meeting note to the owner was not sent');
    return undefined;
  }
  const store = scoped(deps.store, row.ownerId);
  const chatId = sent.data;
  const conversationId = channelConversationId(row.ownerId, 'feishu', row.channelId, chatId);
  const now = new Date().toISOString();
  if ((await store.get('conversations', conversationId)) === null) {
    const conversation = {
      id: conversationId, kind: 'direct' as const, agentIds: [row.agentId], memberIds: [row.ownerId], unreadCount: 0, lastItemAt: now, createdAt: now,
      ownerId: row.ownerId, channel: { kind: 'feishu', channelId: row.channelId, threadId: chatId, chatId },
    };
    await store.put('conversations', conversation);
    await store.emit({ type: 'conversation.created', conversation });
  }
  // Stored without an `item.added` event: delivery would send it to the owner a second time.
  await store.put('items', { id: 'itm-meeting-' + String(Date.now()) + '-' + chatId.slice(-6), conversationId, type: 'agent_message', at: now, agentId: row.agentId, markdown: text, citations: [] }, { conversationId });
  return { conversationId };
}

/** An invitation to join a meeting: the owner's own invitation joins at once; anyone else's waits for the owner's yes. */
export async function handleMeetingInvite(deps: MeetingDeps, row: ChannelRow, data: unknown): Promise<void> {
  const invite = parseMeetingInvite(data);
  if (invite === null) {
    log.warn({ channel: row.id }, 'meeting invitation could not be read');
    return;
  }
  await runWithOwner(row.ownerId, async () => {
    const store = scoped(deps.store, row.ownerId);
    const fromOwner = row.ownerExternalId !== undefined && invite.inviterId === row.ownerExternalId;
    const label = invite.topic === undefined ? invite.meetingNumber : '"' + invite.topic + '" (' + invite.meetingNumber + ')';
    if (!fromOwner) {
      await store.put('meetingSessions', pendingInvite(row, invite));
      await noteToOwner(deps, row, 'Someone' + (invite.inviterId === undefined ? '' : ' (' + invite.inviterId + ')') + ' invited me to the meeting ' + label + '. Shall I join and take notes? Reply yes and I will.');
      return;
    }
    const dm = await noteToOwner(deps, row, 'Joining the meeting ' + label + ' you invited me to.');
    if (dm === undefined) return;
    const outcome = await attend(deps, { row, ownerId: row.ownerId, conversationId: dm.conversationId, meetingNumber: invite.meetingNumber, password: invite.password, callId: invite.callId });
    if (!outcome.ok) await noteToOwner(deps, row, 'I could not join the meeting ' + label + '. ' + outcome.message);
  });
}

function pendingInvite(row: ChannelRow, invite: MeetingInvite): MeetingSession {
  const now = new Date().toISOString();
  return {
    id: inviteId(row.agentId, invite.meetingNumber), ownerId: row.ownerId, agentId: row.agentId, channelRowId: row.id, conversationId: '', status: 'invited',
    meetingNumber: invite.meetingNumber, ...(invite.topic === undefined ? {} : { topic: invite.topic }), ...(invite.callId === undefined ? {} : { callId: invite.callId }),
    ...(invite.password === undefined ? {} : { password: invite.password }), lines: [], startedAt: now, updatedAt: now,
  };
}

// ---- polling -----------------------------------------------------------------------------------------

interface Bot { openId: string; name: string }

interface Harvest {
  lines: MeetingLine[];
  questions: Array<{ eventId: string; who: string; content: string }>;
  ended?: string;
}

/** Turn one page of meeting events into transcript lines, questions for the bot and an end signal. */
export function harvestEvents(events: unknown[], bot: Bot, harvest: Harvest = { lines: [], questions: [] }): Harvest {
  for (const raw of events) {
    const event = asRecord(raw);
    const type = asString(event['event_type']);
    const payload = asRecord(event['payload']);
    const eventAt = parseTime(event['event_time']);
    const iso = (ms: number | undefined): string => new Date(ms ?? eventAt ?? Date.now()).toISOString();
    if (type === 'transcript_received') {
      for (const item of asArray(payload['transcript_received_items'])) {
        const rec = asRecord(item);
        const text = asString(rec['text']).trim();
        if (text !== '') harvest.lines.push({ at: iso(parseTime(rec['start_time_ms'])), who: asString(asRecord(rec['speaker'])['user_name']) || 'Unknown speaker', text });
      }
    } else if (type === 'chat_received') {
      for (const item of asArray(payload['chat_received_items'])) {
        const rec = asRecord(item);
        const content = asString(rec['content']).trim();
        const operator = asRecord(rec['operator']);
        // A reaction (message_type 3) is not a message; the bot's own messages are never answered.
        if (content === '' || Number(rec['message_type']) === 3 || asString(operator['id']) === bot.openId) continue;
        const who = asString(operator['user_name']) || 'Someone';
        harvest.lines.push({ at: iso(parseTime(rec['send_time'])), who, text: content, chat: true });
        if (addressesAgent(content, bot.name)) harvest.questions.push({ eventId: asString(event['event_id']) || content, who, content });
      }
    } else if (type === 'participant_left') {
      for (const item of asArray(payload['participant_left_items'])) {
        const rec = asRecord(item);
        const reason = Number(rec['leave_reason']);
        if (asString(asRecord(rec['participant'])['id']) === bot.openId) harvest.ended = reason === 2 ? 'ended' : 'removed';
        else if (reason === 2) harvest.ended ??= 'ended';
      }
    }
  }
  return harvest;
}

export interface MeetingPoller {
  /** One pass over the active sessions (the timer calls it; tests call it directly). */
  tick(): Promise<void>;
  stop(): void;
}

export function startMeetingPoller(deps: MeetingDeps, intervalMs = POLL_MS): MeetingPoller {
  const busy = new Set<string>();
  const failures = new Map<string, number>();
  const bots = new Map<string, Bot>();
  let stopped = false;

  const botOf = async (row: ChannelRow): Promise<Bot | undefined> => {
    const known = bots.get(row.id);
    if (known !== undefined) return known;
    const info = await fetchFeishuBotInfo(deps.fetchFn ?? fetch, credsOf(row));
    if (!info.ok) return undefined;
    bots.set(row.id, info.data);
    return info.data;
  };

  const poll = async (listed: MeetingSession): Promise<void> => {
    if (listed.meetingId === undefined) return;
    const store = scoped(deps.store, listed.ownerId);
    const row = await store.get('channels', listed.channelRowId);
    if (row === null || row.status === 'invalid_token') return finish(deps, listed, 'lost');
    const bot = await botOf(row);
    if (bot === undefined) return;
    let session = listed;
    for (let page = 0; page < MAX_PAGES_PER_TICK; page += 1) {
      const res = await botEvents(deps.fetchFn ?? fetch, credsOf(row), listed.meetingId, session.pageToken);
      if (!res.ok) {
        if (res.code === 20001 || res.code === 10005 || res.code === 20002) return finish(deps, session, res.code === 20001 ? 'ended' : 'removed');
        const count = (failures.get(session.id) ?? 0) + 1;
        failures.set(session.id, count);
        log.warn({ session: session.id, error: res.error, count }, 'meeting events poll failed');
        if (count >= LOST_AFTER_FAILURES) { failures.delete(session.id); return finish(deps, session, 'lost'); }
        return;
      }
      failures.delete(session.id);
      const data = dataOf(res);
      const found = harvestEvents(asArray(data['events']), bot);
      const token = asString(data['page_token']);
      const fresh: NewLine[] = found.lines.map((line, index) => ({ ...line, id: session.id + '|' + (token || 'start') + '|' + String(index) + '|' + line.at + '|' + line.who + '|' + line.text }));
      session = { ...(await recordLines(deps, session, fresh)), ...(token === '' ? {} : { pageToken: token }) };
      if (found.ended !== undefined) return finish(deps, session, found.ended);
      if (found.lines.length > 0 || token !== '') await store.put('meetingSessions', session);
      // The first question carries every line the subagent has not seen and moves its cursor.
      for (const question of found.questions) {
        await wakeInMeeting(deps, session, 'wk-meeting-q-' + session.id + '-' + question.eventId, questionText(session, question.who, question.content, pendingLines(session)), [question.who]);
        session = markNoted(session);
      }
      if (found.questions.length > 0) await store.put('meetingSessions', session);
      if (data['has_more'] !== true) return;
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const page = await deps.store.list('meetingSessions', { where: { status: 'active' }, limit: 200 });
    await Promise.all(page.items.map(async (session) => {
      if (busy.has(session.id)) return;
      busy.add(session.id);
      try {
        await runWithOwner(session.ownerId, () => poll(session));
      } catch (error) {
        log.warn({ err: error, session: session.id }, 'meeting poll failed');
      } finally {
        busy.delete(session.id);
      }
    }));
  };

  const timer = setInterval(() => { void tick().catch((error: unknown) => log.warn({ err: error }, 'meeting poll pass failed')); }, intervalMs);
  timer.unref();
  return { tick, stop: () => { stopped = true; clearInterval(timer); } };
}

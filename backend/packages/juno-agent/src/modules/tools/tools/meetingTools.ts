/**
 * Live-meeting tools, platform-neutral by URL. Two ways to attend:
 *  - Lark/Feishu (CH8): the agent's app joins as the bot and works from the real-time transcript; the host (agentd)
 *    implements `MeetingPort`, and only an agent with a Feishu channel can use it.
 *  - Google Meet: the agent joins as a guest from ITS OWN computer through the sandbox `agent-meet` helper (one call
 *    per action, no step-by-step browser driving). Available to any agent that has a computer.
 * Joining and leaving act for the owner, so they refuse a wake the owner did not author.
 */
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { ComputerError, MEET_URL, type MeetInput, type MeetResult } from '../../../ports/computer/index.js';
import { requireComputerClient, type ComputerClientProvider } from '../computer/client.js';
import type { PluginTool } from '../plugin-tool.js';
import { computerFailure } from '../computer/shared.js';

/** Who is asking, so the host can find the agent's channel and the chat to answer in. */
export interface MeetingCaller {
  ownerId: string;
  agentId: string;
  conversationId: string;
}

/** What a meeting action did, in words the model can pass on. */
export interface MeetingOutcome {
  ok: boolean;
  message: string;
}

export interface MeetingPort {
  /** Whether the agent holds a channel that can attend meetings (a Feishu / Lark app). */
  available(agentId: string): Promise<boolean>;
  join(caller: MeetingCaller, input: { meetingNumber: string; password?: string }): Promise<MeetingOutcome>;
  leave(caller: MeetingCaller): Promise<MeetingOutcome>;
  say(caller: MeetingCaller, text: string): Promise<MeetingOutcome>;
  transcript(caller: MeetingCaller, sinceMinutes?: number): Promise<MeetingOutcome>;
  /**
   * Google Meet: the agent's computer asked to join (or is in). The host opens the meeting session (its own conversation, a
   * record file, a backend watcher). Absent: Meet works as a plain tool without a session.
   */
  meetJoined?(caller: MeetingCaller, input: { url: string; name: string; state: string; brief?: string }): Promise<void>;
  /** Google Meet: the agent left on purpose; the host ends the session and hands the record back to the chat that asked. */
  meetLeft?(caller: MeetingCaller): Promise<void>;
}

const joinSchema = z.object({
  url: z.string().trim().min(1).max(2000).optional(),
  meetingNumber: z.string().trim().regex(/^\d{9}$/, 'a meeting number is exactly 9 digits').optional(),
  password: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  brief: z.string().trim().min(1).max(2000).optional(),
}).strict();
const saySchema = z.object({ text: z.string().trim().min(1).max(4000) }).strict();
const transcriptSchema = z.object({ sinceMinutes: z.number().int().min(1).max(24 * 60).optional() }).strict();
const emptySchema = z.object({}).strict();

/** Where a join goes: the agent's own computer (Google Meet) or the Feishu bot. Pure, so it is unit-tested. */
export type JoinRoute =
  | { kind: 'meet'; url: string }
  | { kind: 'feishu'; meetingNumber: string; password?: string }
  | { kind: 'error'; message: string };

export function routeJoin(input: z.infer<typeof joinSchema>): JoinRoute {
  if (input.url !== undefined) {
    const url = input.url.replace(/[#].*$/, '').replace(/\/$/, '');
    if (MEET_URL.test(url)) return { kind: 'meet', url };
    // A Lark/Feishu meeting link ends with the 9-digit number: https://vc.feishu.cn/j/123456789
    const number = /(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/j\/(\d{9})(?:[/?]|$)/.exec(input.url)?.[1];
    if (number !== undefined) return { kind: 'feishu', meetingNumber: number, ...(input.password === undefined ? {} : { password: input.password }) };
    return { kind: 'error', message: 'unsupported meeting link: only Google Meet (https://meet.google.com/...) and Lark/Feishu (.../j/<9 digits>) links can be joined.' };
  }
  if (input.meetingNumber !== undefined) return { kind: 'feishu', meetingNumber: input.meetingNumber, ...(input.password === undefined ? {} : { password: input.password }) };
  return { kind: 'error', message: 'give the meeting url (Google Meet or Lark/Feishu link), or a 9-digit Feishu meetingNumber.' };
}

/** What join says for each state the helper reports after the click; exported for tests. */
export function joinText(result: Extract<MeetResult, { action: 'join' }>, name: string): { text: string; isError: boolean } {
  switch (result.state) {
    case 'waiting_admission':
      return { text: `Asked to join; waiting for the host to admit ${name}. (${result.detail}) Do not assume you are in until meeting_transcript or a later join shows it.`, isError: false };
    case 'in_meeting':
      return { text: `Joined the meeting as ${name}. (${result.detail})`, isError: false };
    case 'denied':
      return { text: `Could not join: ${result.detail}`, isError: true };
    case 'captcha':
      return { text: `Could not join: Meet shows a captcha that a person has to solve. ${result.detail}`, isError: true };
    default:
      return { text: `Could not join (${result.state}): ${result.detail}`, isError: true };
  }
}

/** One chat message per line; exported for tests. */
export function chatText(messages: Extract<MeetResult, { action: 'chat_read' }>['messages']): string {
  if (messages.length === 0) {
    return 'No chat messages in the meeting yet. (Google Meet: only the in-call chat is readable; spoken words are not transcribed yet.)';
  }
  const lines = messages.map((m) => `[${m.sender || 'unknown'}${m.at ? ' ' + m.at : ''}] ${m.text}`);
  return `Meeting chat (${messages.length} message${messages.length === 1 ? '' : 's'}, newest last; spoken words are not transcribed yet):\n${lines.join('\n')}`;
}

function result(outcome: MeetingOutcome): ToolResult {
  return { content: [{ type: 'text', text: outcome.message }], ...(outcome.ok ? {} : { isError: true }) };
}

function text(message: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: message }], ...(isError ? { isError: true } : {}) };
}

function refuse(message: string): ToolResult {
  return text('Error: ' + message, true);
}

function caller(ctx: ToolContext): MeetingCaller {
  return { ownerId: ctx.wake.ownerId || ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId };
}

async function agentName(ctx: ToolContext): Promise<string> {
  const agent = await ctx.store.get('agents', ctx.agentId) as { name?: unknown } | null;
  return typeof agent?.name === 'string' && agent.name.trim() ? agent.name.trim().slice(0, 100) : 'Juno';
}

/**
 * `port` is the Feishu implementation (absent: no Feishu path); `computer` is the agent's sandbox (absent: no Meet
 * path). The registry registers these tools whenever either exists.
 */
export function createMeetingTools(port: MeetingPort | undefined, computer?: ComputerClientProvider): Tool[] {
  const meet = async (ctx: ToolContext, input: MeetInput): Promise<MeetResult> => {
    const client = requireComputerClient(computer);
    if (!client.meet) throw new ComputerError('unavailable', 'Google Meet is not available: this deployment has no sandbox meeting helper.');
    return client.meet(ctx.agentId, input, ctx.signal);
  };
  /** Whether this agent's computer is currently in (or asking to enter) a Meet; false on any trouble, so Feishu can answer. */
  const meetActive = async (ctx: ToolContext): Promise<boolean> => {
    if (computer === undefined) return false;
    try {
      const state = await meet(ctx, { action: 'state' });
      return state.action === 'state' && (state.state === 'in_meeting' || state.state === 'waiting_admission');
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      return false;
    }
  };
  const notInMeeting = refuse('you are not in a meeting. Join one with meeting_join first.');

  const join: Tool = {
    name: 'meeting_join',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '' },
        meetingNumber: { type: 'string', description: '' },
        password: { type: 'string', description: '' },
        name: { type: 'string', description: '' },
        brief: { type: 'string', description: '' },
      },
      additionalProperties: false,
    },
    replay: 'never',
    sideEffect: true,
    async execute(args, ctx) {
      const parsed = joinSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('meeting_join', args, parsed.error);
      if (!ctx.wake.trusted) return refuse('only the owner can ask you to join a meeting; this message did not come from the owner.');
      const route = routeJoin(parsed.data);
      if (route.kind === 'error') return refuse(route.message);
      if (route.kind === 'feishu') {
        if (port === undefined || !(await port.available(ctx.agentId))) return refuse('this agent has no Lark/Feishu app connected, so it cannot join a Feishu meeting.');
        return result(await port.join(caller(ctx), { meetingNumber: route.meetingNumber, ...(route.password === undefined ? {} : { password: route.password }) }));
      }
      if (computer === undefined) return refuse('this agent has no computer, so it cannot join a Google Meet.');
      try {
        const name = parsed.data.name ?? await agentName(ctx);
        const joined = await meet(ctx, { action: 'join', url: route.url, name });
        if (joined.action !== 'join') throw new ComputerError('failed', `meet join returned a ${joined.action} result`);
        const line = joinText(joined, name);
        if (!line.isError && port?.meetJoined) await port.meetJoined(caller(ctx), { url: route.url, name, state: joined.state, ...(parsed.data.brief === undefined ? {} : { brief: parsed.data.brief }) });
        return text(line.text, line.isError);
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
  const leave: Tool = {
    name: 'meeting_leave',
    description: '',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    replay: 'never',
    sideEffect: true,
    async execute(args, ctx) {
      if (!emptySchema.safeParse(args).success) return refuse('meeting_leave takes no arguments');
      if (!ctx.wake.trusted) return refuse('only the owner can ask you to leave a meeting.');
      try {
        if (await meetActive(ctx)) {
          const left = await meet(ctx, { action: 'leave' });
          if (left.action === 'leave' && port?.meetLeft) await port.meetLeft(caller(ctx));
          return left.action === 'leave' ? text(`Left the meeting. (${left.detail})`) : refuse(`unexpected ${left.action} result`);
        }
        if (port !== undefined && await port.available(ctx.agentId)) return result(await port.leave(caller(ctx)));
        return notInMeeting;
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
  const say: Tool = {
    name: 'meeting_say',
    description: '',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    replay: 'never',
    sideEffect: true,
    async execute(args, ctx) {
      const parsed = saySchema.safeParse(args);
      if (!parsed.success) return invalidArguments('meeting_say', args, parsed.error);
      try {
        if (await meetActive(ctx)) {
          const sent = await meet(ctx, { action: 'chat_send', text: parsed.data.text });
          return sent.action === 'chat_send' ? text('Posted to the meeting chat.') : refuse(`unexpected ${sent.action} result`);
        }
        if (port !== undefined && await port.available(ctx.agentId)) return result(await port.say(caller(ctx), parsed.data.text));
        return notInMeeting;
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
  const transcript: Tool = {
    name: 'meeting_transcript',
    description: '',
    parameters: { type: 'object', properties: { sinceMinutes: { type: 'integer', minimum: 1 } }, additionalProperties: false },
    replay: 'safe',
    sideEffect: false,
    async execute(args, ctx) {
      const parsed = transcriptSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('meeting_transcript', args, parsed.error);
      try {
        // The session record (both platforms) is the transcript; the live chat read is the fallback for a Meet with no session.
        if (port !== undefined) {
          const recorded = await port.transcript(caller(ctx), parsed.data.sinceMinutes);
          if (recorded.ok) return result(recorded);
        }
        if (await meetActive(ctx)) {
          const read = await meet(ctx, { action: 'chat_read', name: await agentName(ctx) });
          return read.action === 'chat_read' ? text(chatText(read.messages)) : refuse(`unexpected ${read.action} result`);
        }
        if (port !== undefined && await port.available(ctx.agentId)) return result(await port.transcript(caller(ctx), parsed.data.sinceMinutes));
        return notInMeeting;
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
  return [join, leave, say, transcript];
}

/**
 * The meeting tools as the meetings plugin registers them. Google Meet runs on the agent's own computer, so any agent
 * with one is offered the tools; Feishu needs the agent's channel (`port.available`). With neither there are none.
 */
export function meetingPluginTools(port: MeetingPort | undefined, computer: ComputerClientProvider | undefined): PluginTool[] {
  if (port === undefined && computer === undefined) return [];
  const visibleFor = async (agentId: string): Promise<boolean> => computer !== undefined || (port !== undefined && await port.available(agentId));
  return createMeetingTools(port, computer).map((tool) => ({ tool, visibleFor }));
}

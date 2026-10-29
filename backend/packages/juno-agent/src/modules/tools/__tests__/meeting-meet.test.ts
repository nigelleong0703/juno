// Meeting tools, Google Meet path: URL routing, the one-call join on the agent's computer, and the result texts.
import { describe, expect, it } from 'vitest';
import type { ComputerClient } from '../../../ports/computer/index.js';
import type { MeetInput, MeetResult } from '../../../ports/computer/index.js';
import { chatText, createMeetingTools, joinText, routeJoin, type MeetingPort } from '../tools/meetingTools.js';
import { createMemoryStore } from '../../../testing/store.js';
import { textOf, toolCtx } from './codingFixtures.js';

describe('meeting_join routing by URL', () => {
  it('sends meet.google.com to the agent computer and Feishu links or numbers to the bot', () => {
    expect(routeJoin({ url: 'https://meet.google.com/abc-defg-hij?authuser=0' })).toEqual({ kind: 'meet', url: 'https://meet.google.com/abc-defg-hij?authuser=0' });
    expect(routeJoin({ url: 'https://vc.feishu.cn/j/123456789' })).toEqual({ kind: 'feishu', meetingNumber: '123456789' });
    expect(routeJoin({ meetingNumber: '123456789', password: 'x' })).toEqual({ kind: 'feishu', meetingNumber: '123456789', password: 'x' });
    expect(routeJoin({ url: 'https://zoom.us/j/123' }).kind).toBe('error');
    expect(routeJoin({}).kind).toBe('error');
  });
});

describe('result texts', () => {
  it('states exactly what happened after the click', () => {
    expect(joinText({ action: 'join', state: 'waiting_admission', detail: 'clicked' }, 'Test')).toMatchObject({ isError: false });
    expect(joinText({ action: 'join', state: 'waiting_admission', detail: 'clicked' }, 'Test').text).toContain('waiting for the host to admit Test');
    expect(joinText({ action: 'join', state: 'denied', detail: 'no' }, 'Test').isError).toBe(true);
    expect(joinText({ action: 'join', state: 'captcha', detail: 'x' }, 'Test').text).toContain('captcha');
    expect(chatText([])).toContain('No chat messages');
    expect(chatText([{ id: '1', sender: 'Ann', text: 'hi', at: '10:02' }])).toContain('[Ann 10:02] hi');
  });
});

function meetClient(calls: MeetInput[], state: MeetResult = { action: 'state', state: 'in_meeting', detail: 'in the meeting' }): { provider: () => ComputerClient } {
  const client = {
    async meet(_agent: string, input: MeetInput): Promise<MeetResult> {
      calls.push(input);
      switch (input.action) {
        case 'join': return { action: 'join', state: 'waiting_admission', detail: 'clicked Ask to join' };
        case 'state': return state;
        case 'chat_read': return { action: 'chat_read', messages: [{ id: 'm1', sender: 'Ann', text: 'hello' }] };
        case 'chat_send': return { action: 'chat_send', sent: true };
        case 'audio_read': return { action: 'audio_read', on: false, segments: [] };
        case 'leave': return { action: 'leave', state: 'ended', detail: 'left' };
      }
    },
  } as unknown as ComputerClient;
  return { provider: () => client };
}

const tool = (tools: ReturnType<typeof createMeetingTools>, name: string) => tools.find((t) => t.name === name)!;

describe('Meet tools on the agent computer', () => {
  it('join is one call with the agent name as default display name', async () => {
    const calls: MeetInput[] = [];
    const store = createMemoryStore();
    await store.put('agents', { id: 'agent-1', name: 'Nova' } as never, { agentId: 'agent-1' } as never).catch(() => undefined);
    const tools = createMeetingTools(undefined, meetClient(calls).provider);
    const ctx = { ...toolCtx(store), wake: { ...toolCtx(store).wake, trusted: true } };
    const out = await tool(tools, 'meeting_join').execute({ url: 'https://meet.google.com/abc-defg-hij', name: 'Test' }, ctx);
    expect(calls).toEqual([{ action: 'join', url: 'https://meet.google.com/abc-defg-hij', name: 'Test' }]);
    expect(textOf(out)).toContain('waiting for the host to admit Test');
  });

  it('join refuses an untrusted wake; say and transcript use the chat while in a meeting', async () => {
    const calls: MeetInput[] = [];
    const store = createMemoryStore();
    const tools = createMeetingTools(undefined, meetClient(calls).provider);
    const base = toolCtx(store);
    const untrusted = { ...base, wake: { ...base.wake, trusted: false } };
    expect(textOf(await tool(tools, 'meeting_join').execute({ url: 'https://meet.google.com/abc-defg-hij' }, untrusted))).toContain('only the owner');
    expect(calls).toEqual([]);
    expect(textOf(await tool(tools, 'meeting_say').execute({ text: 'hi all' }, untrusted))).toBe('Posted to the meeting chat.');
    expect(textOf(await tool(tools, 'meeting_transcript').execute({}, untrusted))).toContain('[Ann] hello');
    expect(calls.filter((c) => c.action === 'chat_send')).toEqual([{ action: 'chat_send', text: 'hi all' }]);
  });

  it('say falls back to Feishu when no Meet is active, and says so when there is nothing', async () => {
    const store = createMemoryStore();
    const feishu: MeetingPort = {
      async available() { return true; },
      async join() { return { ok: true, message: 'j' }; },
      async leave() { return { ok: true, message: 'l' }; },
      async say() { return { ok: true, message: 'feishu said' }; },
      async transcript() { return { ok: true, message: 't' }; },
    };
    const idle = meetClient([], { action: 'state', state: 'ended', detail: 'over' }).provider;
    expect(textOf(await tool(createMeetingTools(feishu, idle), 'meeting_say').execute({ text: 'x' }, toolCtx(store)))).toBe('feishu said');
    const none = await tool(createMeetingTools(undefined, idle), 'meeting_say').execute({ text: 'x' }, toolCtx(store));
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain('not in a meeting');
  });
});

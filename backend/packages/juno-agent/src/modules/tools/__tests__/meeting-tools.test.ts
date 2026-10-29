// Meeting tools (CH8): registered only for an agent whose host says it can attend; joining and leaving need the owner's own wake.
import { describe, expect, it } from 'vitest';
import { meetingPluginTools, type MeetingPort } from '../tools/meetingTools.js';
import { createToolRegistry } from '../index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { NoopEnqueuer, requireTool, textOf, toolCtx } from './codingFixtures.js';

function port(available: boolean, calls: string[] = []): MeetingPort {
  return {
    async available() { return available; },
    async join(_caller, input) { calls.push('join ' + input.meetingNumber); return { ok: true, message: 'joined' }; },
    async leave() { calls.push('leave'); return { ok: true, message: 'left' }; },
    async say(_caller, text) { calls.push('say ' + text); return { ok: true, message: 'posted' }; },
    async transcript() { return { ok: true, message: 'lines' }; },
  };
}

const names = async (meetings?: MeetingPort) => (await (await createToolRegistry({ store: createMemoryStore(), enqueuer: new NoopEnqueuer(), pluginTools: meetingPluginTools(meetings, undefined) })).forAgent('agent-1')).map((t) => t.name).filter((n) => n.startsWith('meeting_'));

describe('meeting tools', () => {
  it('are offered only when the host can attend meetings for that agent', async () => {
    expect(await names()).toEqual([]);
    expect(await names(port(false))).toEqual([]);
    expect(await names(port(true))).toEqual(['meeting_join', 'meeting_leave', 'meeting_say', 'meeting_transcript']);
  });

  it('join and leave refuse a wake the owner did not author; say still works', async () => {
    const calls: string[] = [];
    const registry = await createToolRegistry({ store: createMemoryStore(), enqueuer: new NoopEnqueuer(), pluginTools: meetingPluginTools(port(true, calls), undefined) });
    const base = toolCtx(createMemoryStore());
    const untrusted = { ...base, wake: { ...base.wake, trusted: false } };
    expect(textOf(await requireTool(registry, 'meeting_join').execute({ meetingNumber: '123456789' }, untrusted))).toContain('only the owner');
    expect(textOf(await requireTool(registry, 'meeting_leave').execute({}, untrusted))).toContain('only the owner');
    expect(textOf(await requireTool(registry, 'meeting_say').execute({ text: 'hi' }, untrusted))).toBe('posted');
    expect(calls).toEqual(['say hi']);
    const trusted = { ...base, wake: { ...base.wake, trusted: true } };
    expect(textOf(await requireTool(registry, 'meeting_join').execute({ meetingNumber: '123456789' }, trusted))).toBe('joined');
    expect((await requireTool(registry, 'meeting_join').execute({ meetingNumber: '12' }, trusted)).isError).toBe(true);
  });
});

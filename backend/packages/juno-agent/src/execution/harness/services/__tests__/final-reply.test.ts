import { describe, expect, it } from 'vitest';
import type { WakeEvent } from '../../../../contracts/index.js';
import { createMemoryStore } from '../../../../testing/store.js';
import { NEVER_CANCELLED } from '../cancel.js';
import { ackStep, citationsOf, replyStep, selectCitations } from '../final-reply.js';
import { postStreamedBubble } from '../block-stream.js';
import { unwrapProxyCalls } from '../../../brain/tool-proxy.js';
import type { RunContext, RunInput, RunServices } from '../run-types.js';

const wake = (kind: WakeEvent['kind'], origin: WakeEvent['origin']['type']): WakeEvent => ({
  id: 'w', ownerId: 'o', agentId: 'a', sessionKey: 'a:c', conversationId: 'c', kind, origin: { type: origin },
  trusted: true, priority: 'background', payload: {}, at: '2026-10-09T00:00:00.000Z', status: 'accepted',
});

/** Run one replyStep for a run started by `wakeEvents`; returns its outcome and the agent bubbles it wrote. */
async function reply(wakeEvents: WakeEvent[], text: string, deliveredTexts: string[] = []): Promise<{ outcome: string; posted: string[] }> {
  const store = createMemoryStore();
  let drawn = 0;
  const ctx = { run: async (_name: string, action: () => Promise<unknown>) => action(), rand: { uuidv4: () => 'id' + String(drawn++) } } as unknown as RunContext;
  const services = { store } as unknown as RunServices;
  const input: RunInput = { agentId: 'a', conversationId: 'c', sessionKey: 'a:c', wakeEvents };
  const outcome = await replyStep(ctx, services, input, 0, text, NEVER_CANCELLED, deliveredTexts, 'run-1');
  const items = await store.list('items', { where: { conversationId: 'c' }, limit: 20 });
  return { outcome: typeof outcome === 'string' ? outcome : 'retry', posted: items.items.flatMap((item) => (item.type === 'agent_message' ? [item.markdown] : [])) };
}

describe('the final reply is the one exit, for every kind of run', () => {
  it('posts a non-blank final reply whatever started the run: a routine, a goal check-in, a calendar wake, a timer, a finished task, a webhook', async () => {
    for (const started of [wake('routine', 'automation'), wake('goal_checkin', 'automation'), wake('webhook', 'automation'), wake('calendar_due', 'system'), wake('timer', 'system'), wake('task_done', 'system'), wake('user_message', 'user')]) {
      expect(await reply([started], 'Time to stretch.'), started.kind).toEqual({ outcome: 'completed', posted: ['Time to stretch.'] });
    }
  });

  it('posts nothing for a blank final reply, however the run started', async () => {
    for (const started of [wake('routine', 'automation'), wake('calendar_due', 'system'), wake('user_message', 'user')]) {
      expect(await reply([started], '  \n '), started.kind).toEqual({ outcome: 'silent', posted: [] });
    }
  });

  it('posts a reply nobody is waiting on as ONE message however many paragraphs it has, and still splits a chat reply', async () => {
    const text = 'Your 3pm is moved to 4pm.\n\nThe room changed too.\n\nNothing else to do.';
    for (const started of [wake('routine', 'automation'), wake('monitor', 'automation'), wake('calendar_due', 'system'), wake('goal_checkin', 'automation'), wake('webhook', 'automation'), wake('connector_event', 'automation'), wake('task_done', 'system')]) {
      expect(await reply([started], text), started.kind).toEqual({ outcome: 'completed', posted: [text] });
    }
    expect((await reply([wake('user_message', 'user')], text)).posted).toEqual(['Your 3pm is moved to 4pm.', 'The room changed too.', 'Nothing else to do.']);
  });

  it('keeps a card attached to the one message of an automatic wake', async () => {
    const card = '```card\n{"version":1,"blocks":[{"type":"text","text":"Gym at 6"}]}\n```';
    const out = await reply([wake('calendar_due', 'system')], `Reminder.\n\nDetails.\n\n${card}\n\nBye.`);
    expect(out.posted).toEqual(['Reminder.\n\nDetails.\n\nBye.']);
  });

  it('still drops an exact repeat of something already delivered in this chat', async () => {
    expect(await reply([wake('calendar_due', 'system')], 'Gym time.', ['Gym time.'])).toEqual({ outcome: 'completed', posted: [] });
  });
});

describe('final reply citations', () => {
  const c = (n: number) => ({ id: `web:${n}`, title: `T${n}`, url: `https://x.test/${n}` });
  it('reads web tool citations and ignores malformed ones', () => {
    expect(citationsOf({ citations: [c(1), { id: 2 }, null] })).toEqual([c(1)]);
    expect(citationsOf(undefined)).toEqual([]);
  });
  it('dedupes by url, puts mentioned sources first, caps at 8', () => {
    const all = [c(1), c(2), c(1), ...[3, 4, 5, 6, 7, 8, 9, 10].map(c)];
    const out = selectCitations(all, 'see https://x.test/9');
    expect(out).toHaveLength(8);
    expect(out[0]).toEqual(c(9));
    expect(out.slice(1).map((x) => x.id)).toEqual(['web:1', 'web:2', 'web:3', 'web:4', 'web:5', 'web:6', 'web:7']);
  });
});

/** The opening line a run gets when its first turn makes these calls, resolved the way the turn driver resolves them. */
async function openingLineFor(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): Promise<string[]> {
  const store = createMemoryStore();
  await store.put('conversations', { id: 'c', kind: 'direct' } as never);
  let drawn = 0;
  const ctx = { run: async (_name: string, action: () => Promise<unknown>) => action(), rand: { uuidv4: () => 'id' + String(drawn++) } } as unknown as RunContext;
  const services = { store } as unknown as RunServices;
  const input: RunInput = { agentId: 'a', conversationId: 'c', sessionKey: 'a:c', wakeEvents: [wake('user_message', 'user')] };
  await ackStep(ctx, services, input, 0, 'Let me check.', unwrapProxyCalls(calls).map((call) => call.name), NEVER_CANCELLED, [], 'run-1');
  const items = await store.list('items', { where: { conversationId: 'c' }, limit: 20 });
  return items.items.flatMap((item) => (item.type === 'agent_message' ? [item.markdown] : []));
}

describe('the opening line judges the tool a proxied call reaches', () => {
  const proxied = (name: string) => ({ id: 'call-' + name, name: 'tool_call', arguments: { name, arguments: {} } });

  it('posts no opening line when the only call is a quiet tool reached through tool_call', async () => {
    expect(await openingLineFor([proxied('memory_note')])).toEqual([]);
  });

  it('still announces real work reached through tool_call', async () => {
    expect(await openingLineFor([proxied('tasks_list')])).toEqual(['Let me check.']);
  });
});

describe('the daily cap on unsolicited messages (BACKEND §5.10)', () => {
  const day = new Date().toISOString().slice(0, 10);
  const logged = (n: number) => ({ id: 'plog-' + String(n), ownerId: 'o', kind: 'goal-checkin' as const, date: day, at: new Date().toISOString() });

  async function replyWithLog(started: WakeEvent, earlier: number) {
    const store = createMemoryStore();
    for (let n = 0; n < earlier; n += 1) await store.put('proactiveLog', logged(n));
    const ctx = { run: async (_name: string, action: () => Promise<unknown>) => action(), rand: { uuidv4: () => 'id0' } } as unknown as RunContext;
    const logs: string[] = [];
    const services = { store, log: (_fields: unknown, message: string) => logs.push(message) } as unknown as RunServices;
    const input: RunInput = { agentId: 'a', conversationId: 'c', sessionKey: 'a:c', wakeEvents: [started] };
    const outcome = await replyStep(ctx, services, input, 0, 'Your passport expires next month.', NEVER_CANCELLED, [], 'run-1');
    const items = (await store.list('items', { where: { conversationId: 'c' }, limit: 20 })).items.filter((item) => item.type === 'agent_message');
    return { outcome, posted: items.length, rows: (await store.list('proactiveLog', { limit: 20 })).items.length, logs };
  }
  const scheduled = (reason: string): WakeEvent => ({ ...wake('goal_checkin', 'automation'), payload: { reason, title: 'Renew passport' } });

  it('posts a scheduled goal check-in while there is room and counts it', async () => {
    expect(await replyWithLog(scheduled('scheduled'), 2)).toEqual({ outcome: 'completed', posted: 1, rows: 3, logs: [] });
  });

  it('drops the third-plus message of the day with a log line and posts nothing', async () => {
    expect(await replyWithLog(scheduled('scheduled'), 3)).toEqual({ outcome: 'silent', posted: 0, rows: 3, logs: ['proactive message dropped: daily cap reached'] });
    expect(await replyWithLog(scheduled('proactive'), 3)).toMatchObject({ outcome: 'silent', posted: 0 });
  });

  it('does not count or drop what the owner asked for or set up: a manual check, a deadline reminder, a routine, a monitor', async () => {
    for (const started of [scheduled('manual'), scheduled('deadline'), wake('routine', 'automation'), wake('monitor', 'automation')]) {
      expect(await replyWithLog(started, 3), started.kind).toMatchObject({ outcome: 'completed', posted: 1, rows: 3 });
    }
  });
});

describe('a multi-bubble reply is paced', () => {
  it('posts the first bubble at once and sleeps a capped reading pause before each later one, one step per bubble', async () => {
    const store = createMemoryStore();
    let drawn = 0;
    const steps: string[] = [];
    const pauses: number[] = [];
    const ctx = {
      run: async (name: string, action: () => Promise<unknown>) => { steps.push(name); return action(); },
      sleep: async (ms: number) => { pauses.push(ms); },
      rand: { uuidv4: () => 'id' + String(drawn++) },
    } as unknown as RunContext;
    const input: RunInput = { agentId: 'a', conversationId: 'c', sessionKey: 'a:c', wakeEvents: [wake('user_message', 'user')] };
    await replyStep(ctx, { store } as unknown as RunServices, input, 0, `Short one.\n\n${'x'.repeat(500)}`, NEVER_CANCELLED, [], 'run-1');
    expect(steps.filter((name) => /^reply:0:\d$/.test(name))).toEqual(['reply:0:0', 'reply:0:1']);
    expect(pauses).toEqual([2000]);
  });
});

describe('a reply whose first paragraphs were already streamed', () => {
  async function setup(streamedTexts: string[]) {
    const store = createMemoryStore();
    const services = { store, log: () => undefined } as unknown as RunServices;
    const input: RunInput = { agentId: 'a', conversationId: 'c', sessionKey: 'a:c', wakeEvents: [wake('user_message', 'user')] };
    const steps: string[] = [];
    const pauses: number[] = [];
    const ctx = {
      run: async (name: string, action: () => Promise<unknown>) => { steps.push(name); return action(); },
      sleep: async (ms: number) => { pauses.push(ms); },
      rand: { uuidv4: () => 'id' },
    } as unknown as RunContext;
    for (const [index, markdown] of streamedTexts.entries()) await postStreamedBubble(services, input, 'run-1', 0, index, markdown);
    const bubbles = async () => (await store.list('items', { where: { conversationId: 'c' }, orderBy: 'at', limit: 20 })).items.flatMap((item) => (item.type === 'agent_message' ? [item.markdown] : []));
    return { store, services, input, ctx, steps, pauses, bubbles };
  }

  it('posts only the rest, shortens its pause by the time since the last streamed post, and posts nothing twice on a replay', async () => {
    const { ctx, services, input, steps, pauses, bubbles } = await setup(['One.']);
    const text = 'One.\n\nTwo.\n\nThree.';
    expect(await replyStep(ctx, services, input, 0, text, NEVER_CANCELLED, [], 'run-1')).toBe('completed');
    expect(await bubbles()).toEqual(['One.', 'Two.', 'Three.']);
    expect(steps.filter((name) => /^reply:0:\d$/.test(name))).toEqual(['reply:0:1', 'reply:0:2']);
    expect(pauses.length).toBe(2);
    expect(pauses[0]).toBeLessThanOrEqual(400 + 15 * 4);
    // The same step run again (a retry after a crash): everything exists, nothing is added.
    await replyStep(ctx, services, input, 0, text, NEVER_CANCELLED, [], 'run-1');
    expect(await bubbles()).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('rewrites a streamed bubble whose text differs from the final layout and deletes the extra ones', async () => {
    const { ctx, services, input, bubbles } = await setup(['Intro line.', 'Row one.', 'Row two.']);
    await replyStep(ctx, services, input, 0, '# Plan\n\nIntro line.\n\nRow one.\n\nRow two.', NEVER_CANCELLED, [], 'run-1');
    expect(await bubbles()).toEqual(['# Plan\n\nIntro line.\n\nRow one.\n\nRow two.']);
  });

  it('does not stream an automatic wake: one message, and no reconcile step', async () => {
    const { ctx, services, input, steps, bubbles } = await setup([]);
    const automatic: RunInput = { ...input, wakeEvents: [wake('routine', 'automation')] };
    await replyStep(ctx, services, automatic, 0, 'A.\n\nB.', NEVER_CANCELLED, [], 'run-1');
    expect(await bubbles()).toEqual(['A.\n\nB.']);
    expect(steps.some((name) => name.includes('streamed'))).toBe(false);
  });

  it('takes the streamed paragraphs back when the reply repeats what the chat already has', async () => {
    const { ctx, services, input, bubbles } = await setup(['Same.']);
    await replyStep(ctx, services, input, 0, 'Same.\n\nSame again.', NEVER_CANCELLED, ['Same.\n\nSame again.'], 'run-1');
    expect(await bubbles()).toEqual([]);
  });
});

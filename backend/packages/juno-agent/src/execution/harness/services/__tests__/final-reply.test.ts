import { describe, expect, it } from 'vitest';
import type { WakeEvent } from '../../../../contracts/index.js';
import { createMemoryStore } from '../../../../testing/store.js';
import { NEVER_CANCELLED } from '../cancel.js';
import { ackStep, citationsOf, emptyFinalStep, isLongWork, replyStep, selectCitations } from '../final-reply.js';
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

  it('posts a reply as ONE message however many paragraphs it has, whatever started the run (a chat reply included)', async () => {
    const text = 'Your 3pm is moved to 4pm.\n\nThe room changed too.\n\nNothing else to do:\n\n- a\n- b';
    for (const started of [wake('routine', 'automation'), wake('monitor', 'automation'), wake('calendar_due', 'system'), wake('goal_checkin', 'automation'), wake('webhook', 'automation'), wake('connector_event', 'automation'), wake('task_done', 'system'), wake('user_message', 'user')]) {
      expect(await reply([started], text), started.kind).toEqual({ outcome: 'completed', posted: [text] });
    }
  });

  it('keeps a card attached to the one message', async () => {
    const card = '```card\n{"version":1,"blocks":[{"type":"text","text":"Gym at 6"}]}\n```';
    const out = await reply([wake('calendar_due', 'system')], `Reminder.\n\nDetails.\n\n${card}\n\nBye.`);
    expect(out.posted).toEqual(['Reminder.\n\nDetails.\n\nBye.']);
  });

  it('writes the same item when the step runs again (a retry after a crash posts nothing twice)', async () => {
    const store = createMemoryStore();
    const ctx = { run: async (_name: string, action: () => Promise<unknown>) => action(), rand: { uuidv4: () => 'id' } } as unknown as RunContext;
    const input: RunInput = { agentId: 'a', conversationId: 'c', sessionKey: 'a:c', wakeEvents: [wake('user_message', 'user')] };
    await replyStep(ctx, { store } as unknown as RunServices, input, 0, 'Once.', NEVER_CANCELLED, [], 'run-1');
    await replyStep(ctx, { store } as unknown as RunServices, input, 0, 'Once.', NEVER_CANCELLED, [], 'run-1');
    expect((await store.list('items', { where: { conversationId: 'c' }, limit: 20 })).items).toHaveLength(1);
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

describe('a reaction answers only a run that did nothing else', () => {
  const runWith = async (tools: string[]) => {
    const store = createMemoryStore();
    await store.put('runs', { id: 'run-r', steps: tools.map((tool) => ({ tool, status: 'completed' })) } as never);
    const ctx = { run: async (_name: string, action: () => Promise<unknown>) => action() } as unknown as RunContext;
    return emptyFinalStep(ctx, { store, log: () => undefined } as unknown as RunServices, 'run-r', { text: '', stopReason: 'stop' }, [], { retried: false });
  };

  it('a lone reaction is the answer; a reaction followed by real work still gets the normal retry', async () => {
    expect(await runWith(['react'])).toBe('fine');
    expect(await runWith(['react', 'memory_note'])).toBe('fine');
    expect(await runWith(['react', 'web_search', 'browser.navigate'])).toEqual({ retry: expect.stringContaining('Answer the person now') });
  });

  it('a turn that reacts, or a run that already did, has no opening line besides the tapback', async () => {
    const store = createMemoryStore();
    await store.put('conversations', { id: 'c', kind: 'direct' } as never);
    await store.put('runs', { id: 'run-k', steps: [{ tool: 'react', status: 'completed' }] } as never);
    const ctx = { run: async (_name: string, action: () => Promise<unknown>) => action(), rand: { uuidv4: () => 'id' } } as unknown as RunContext;
    const input: RunInput = { agentId: 'a', conversationId: 'c', sessionKey: 'a:c', wakeEvents: [wake('user_message', 'user')] };
    const services = { store } as unknown as RunServices;
    // Longer work keeps its one short line after the tapback: the browser, a helper, or several searches in one turn.
    expect(await ackStep(ctx, services, input, 2, 'Opening the site now.', ['react', 'browser.navigate'], NEVER_CANCELLED, [], 'run-k')).toBe('posted');
    expect(isLongWork(['web_search', 'web_search'])).toBe(true);
    expect(isLongWork(['tool_search', 'web_search', 'react'])).toBe(false);
    expect(await ackStep(ctx, services, input, 0, "I'll search now.", ['react', 'web_search'], NEVER_CANCELLED, [], 'run-k')).toBe('skipped');
    expect(await ackStep(ctx, services, input, 1, "I'll search now.", ['web_search'], NEVER_CANCELLED, [], 'run-k')).toBe('skipped');
  });
});

describe('the opening line is one bubble and is recorded as delivered', () => {
  it('posts the whole opening text as one bubble and counts it as said, so an empty final turn is fine afterwards', async () => {
    const store = createMemoryStore();
    await store.put('conversations', { id: 'c', kind: 'direct' } as never);
    const ctx = { run: async (_name: string, action: () => Promise<unknown>) => action(), rand: { uuidv4: () => 'id' } } as unknown as RunContext;
    const input: RunInput = { agentId: 'a', conversationId: 'c', sessionKey: 'a:c', wakeEvents: [wake('user_message', 'user')] };
    const delivered: string[] = [];
    const text = '好嘞，就去 KillineyGO。\n\n我帮你查下地址和开门时间。';
    expect(await ackStep(ctx, { store } as unknown as RunServices, input, 0, text, ['web_search'], NEVER_CANCELLED, delivered, 'run-1')).toBe('posted');
    expect(delivered).toEqual([text]);
    expect((await store.list('items', { where: { conversationId: 'c' }, limit: 20 })).items.map((item) => (item.type === 'agent_message' ? item.markdown : ''))).toEqual([text]);
    expect(await emptyFinalStep(ctx, { store } as unknown as RunServices, 'run-1', { text: '', stopReason: 'stop' }, delivered, { retried: false })).toBe('fine');
  });
});

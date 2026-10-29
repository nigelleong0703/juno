// Cache-first prompt: the prefix is append-only. The frozen system row never changes; a changed
// section (date, tasks, computer, profile ...) arrives as a <context_update> row appended at the end;
// the tools array keeps a stable order; replayed history never carries plain-text thinking.
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { newRow, putRow } from '../../../modules/home/mirror.js';
import { agentFilePath } from '../../../modules/home/paths.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import type { BrainContext } from '../../../contracts/index.js';
import { writeTaskPlan } from '../../../modules/tasks/plan-write.js';
import { buildContext, hydrateContext, slimContext } from '../context.js';
import { createBrain } from '../index.js';
import { rulesUpdatedNote, findSystemEntry, metaOf } from '../context-notes.js';
import { appendToTranscript, readTranscript } from '../transcript.js';
import { offloadImages, withImages } from '../transcript-images.js';
import { assistantMessage, toolMessage } from '../messages.js';
import { mergeToolOrder, orderTools } from '../tool-order.js';
import { stripReplayedThinking } from '../replay-sanitize.js';
import { AGENT, PEER, agentDoc, seed, wakeFor } from './agent-resources.fixtures.js';
import { withoutNotes } from './context-text.js';

const KEY = AGENT + ':conv-1';
const base = { agentId: AGENT, conversationId: 'conv-1', sessionKey: KEY, wake: [wakeFor(AGENT)] };

/** Wire-visible bytes of a message list (timestamps never reach the wire). */
function wire(messages: Message[]): string[] {
  return messages.map((message) => JSON.stringify({ ...message, timestamp: 0 }));
}

function noteTexts(messages: Message[]): string[] {
  return messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<context_update>')).map((m) => String(m.content));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T05:30:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('append-only context', () => {
  it('keeps every earlier message byte-identical when the time, tasks and computer change, and appends one note', async () => {
    const store = await seed();
    let cwd = '/work/a';
    const environment = async () => ({ os: 'linux', platform: 'x86_64', user: 'u', home: '/home/u', workingDirectory: cwd });
    const first = await buildContext(store, { ...base, noteKey: 'ctx0:r1', environment });
    await appendToTranscript(store, KEY, [assistantMessage({ text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, stopReason: 'stop' })], 'turn-0');

    // Three minutes later, a plan appears and the computer moved: the volatile state changed.
    vi.setSystemTime(new Date('2026-10-12T05:33:00Z'));
    cwd = '/work/b';
    await writeTaskPlan(store, AGENT, 'conv-1', 'run-1', [{ id: 't1', text: 'Check the page', status: 'pending' }], true);
    const second = await buildContext(store, { ...base, previousContext: first, noteKey: 'ctxN:r1:1', environment });

    const before = wire(first.messages);
    const after = wire(second.messages);
    expect(after.slice(0, before.length)).toEqual(before);
    // Appended after the assistant turn: exactly one new note, carrying only what changed.
    const added = second.messages.slice(before.length + 1);
    expect(added).toHaveLength(1);
    const note = String(added[0]?.content);
    expect(note).toContain('## Current tasks');
    expect(note).toContain('Check the page');
    expect(note).toContain('/work/b');
    expect(note).not.toContain('## Session');
    expect(note).not.toContain('13:30');
    expect(note).not.toContain('Run started');

    // The next build with nothing changed appends nothing, even three minutes on.
    vi.setSystemTime(new Date('2026-10-12T05:36:00Z'));
    const third = await buildContext(store, { ...base, previousContext: second, noteKey: 'ctxN:r1:2', environment });
    expect(wire(third.messages)).toEqual(after);
  });

  it('delivers the date at most once a day and the exact time only in the run-start line', async () => {
    const store = await seed();
    const first = await buildContext(store, { ...base, noteKey: 'ctx0:r1' });
    const firstNote = noteTexts(first.messages)[0] ?? '';
    expect(firstNote).toContain('## Current date\nToday for the user: Monday 2026-10-12');
    expect(firstNote).toContain('Run started Monday 2026-10-12 05:30');
    // The system message carries neither the date nor the time.
    expect(String(first.messages[0]?.content)).not.toMatch(/2026-10-12|05:30/);

    // A new run the same day: the run-start line is appended, the date section is not repeated.
    vi.setSystemTime(new Date('2026-10-12T09:41:00Z'));
    const sameDay = await buildContext(store, { ...base, noteKey: 'ctx0:r2' });
    const notes = noteTexts(sameDay.messages);
    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain('Run started Monday 2026-10-12 09:41');
    expect(notes[1]).not.toContain('## Current date');

    // The next day the date is delivered again.
    vi.setSystemTime(new Date('2026-10-13T09:41:00Z'));
    const nextDay = await buildContext(store, { ...base, noteKey: 'ctx0:r3' });
    expect(noteTexts(nextDay.messages)[2]).toContain('## Current date\nToday for the user: Tuesday 2026-10-13');
    expect(wire(nextDay.messages).slice(0, wire(sameDay.messages).length)).toEqual(wire(sameDay.messages));
  });

  it('replays deterministically: the slim journaled context hydrates to the same messages, and a re-run writes the same note row', async () => {
    const store = await seed();
    const built = await buildContext(store, { ...base, noteKey: 'ctx0:r1' });
    const slim = slimContext(built);
    expect(slim.messages).toBeUndefined();
    const hydrated = await hydrateContext(store, slim);
    expect(wire(hydrated.messages)).toEqual(wire(built.messages));

    // A crash after the write and before the journal entry re-executes the build: the same row id, not a second note.
    const again = await buildContext(store, { ...base, noteKey: 'ctx0:r1' });
    expect(noteTexts(again.messages)).toHaveLength(1);
    expect(again.messages).toHaveLength(built.messages.length);
  });

  it('drops older screenshots in batches: the newest 3 stay images, the prefix changes once per 5 new ones, replays match', async () => {
    const store = await seed();
    const blobs = createMemoryBlobStore();
    const png = (n: number): string => Buffer.from(`png-${n}`).toString('base64');
    let context = await buildContext(store, { ...base, noteKey: 'ctx0:r1' });
    let previous = wire(context.messages);
    const breaks: number[] = [];
    for (let n = 1; n <= 14; n += 1) {
      const call = `shot-${n}`;
      await appendToTranscript(store, KEY, [
        assistantMessage({ text: '', toolCalls: [{ id: call, name: 'computer.screenshot', arguments: {} }], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, stopReason: 'tool_calls' }),
        await offloadImages(blobs, toolMessage('computer.screenshot', call, { content: [{ type: 'text', text: `Captured screen ${n}` }, { type: 'image', mimeType: 'image/png', data: png(n) }] })),
      ], `turn-${n}`);
      context = await buildContext(store, { ...base, previousContext: context, noteKey: `ctxN:r1:${n}` });
      const now = wire(context.messages);
      if (JSON.stringify(now.slice(0, previous.length)) !== JSON.stringify(previous)) breaks.push(n);
      previous = now;
      // A replay from the journaled reference rebuilds the same bytes.
      expect(wire((await hydrateContext(store, slimContext(context))).messages)).toEqual(now);
      // The transcript names the bytes; the model request carries them.
      const sent = await withImages(blobs, context.messages);
      const images = sent.flatMap((m) => (m.role === 'toolResult' ? m.content.filter((b) => b.type === 'image') : []));
      expect(images.length).toBe(n < 7 ? n : n < 12 ? n - 5 : n - 10);
      expect(images.at(-1)).toEqual({ type: 'image', mimeType: 'image/png', data: png(n) });
    }
    // 7 = 2 kept + one batch of 5 dropped; 12 = the next batch. No other build rewrote anything.
    expect(breaks).toEqual([7, 12]);
    const results = context.messages.filter((m) => m.role === 'toolResult');
    // Only image blocks changed: every caption is intact and the omitted ones say so, oldest first.
    expect(results.map((m) => m.content[0])).toEqual(Array.from({ length: 14 }, (_, i) => ({ type: 'text', text: `Captured screen ${i + 1}` })));
    expect(results[0]?.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('[image #1 omitted') });
    expect(results[9]?.content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('[image #10 omitted') });
    expect(results[10]?.content[1]).toMatchObject({ type: 'image', data: '', blobKey: expect.stringMatching(/^blobs\//) });
  });

  it('does not put a note between a tool call and its result', async () => {
    const store = await seed();
    const first = await buildContext(store, { ...base, noteKey: 'ctx0:r1' });
    await appendToTranscript(store, KEY, [assistantMessage({ text: '', toolCalls: [{ id: 'call-1', name: 'x', arguments: {} }], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, stopReason: 'tool_calls' })], 'turn-0');
    await writeTaskPlan(store, AGENT, 'conv-1', 'run-1', [{ id: 't1', text: 'Later', status: 'pending' }], true);
    const pending = await buildContext(store, { ...base, previousContext: first, noteKey: 'ctxN:r1:1' });
    expect(noteTexts(pending.messages)).toHaveLength(1);
    await appendToTranscript(store, KEY, [toolMessage('x', 'call-1', { content: [{ type: 'text', text: 'done' }] })], 'result-0');
    const settled = await buildContext(store, { ...base, previousContext: pending, noteKey: 'ctxN:r1:2' });
    const roles = settled.messages.map((m) => m.role);
    expect(roles.slice(-3)).toEqual(['assistant', 'toolResult', 'user']);
    expect(String(settled.messages.at(-1)?.content)).toContain('Later');
  });

  it('keeps the system message frozen when the agent profile is edited and appends the new profile instead', async () => {
    const store = await seed();
    const first = await buildContext(store, { ...base, noteKey: 'ctx0:r1' });
    await putRow(store, newRow('owner-1', agentFilePath(AGENT, 'IDENTITY.md'), 'Now a pirate.', 'user', new Date().toISOString()));
    const second = await buildContext(store, { ...base, noteKey: 'ctx0:r2' });
    expect(wire(second.messages).slice(0, wire(first.messages).length)).toEqual(wire(first.messages));
    expect(String(second.messages[0]?.content)).not.toContain('pirate');
    const update = noteTexts(second.messages).at(-1) ?? '';
    expect(update).toContain('replaces the system message above');
    expect(update).toContain('Now a pirate.');
  });
});

describe('a changed prompt version', () => {
  it('rewrites the frozen system row once and appends one note saying the rules changed, leaving older messages untouched', async () => {
    const store = await seed();
    const first = await buildContext(store, { ...base, noteKey: 'ctx0:r1' });
    await appendToTranscript(store, KEY, [assistantMessage({ text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, stopReason: 'stop' })], 'turn-0');
    // Pretend the row was written by an earlier version of the prompt.
    const entries = await readTranscript(store, KEY);
    const system = findSystemEntry(entries);
    if (system === undefined) throw new Error('no system row');
    await store.put('transcripts', { ...system, message: { ...system.message, content: 'OLD RULES', contextMeta: { ...(metaOf(system.message) ?? {}), promptHash: 'old' } } });

    const second = await buildContext(store, { ...base, noteKey: 'ctx0:r2' });
    expect(String(second.messages[0]?.content)).not.toContain('OLD RULES');
    expect(wire(second.messages).slice(1, first.messages.length)).toEqual(wire(first.messages).slice(1));
    const notes = noteTexts(second.messages);
    expect(notes.filter((note) => note.includes(rulesUpdatedNote()))).toHaveLength(1);
    expect(notes.at(-1)).not.toContain('replaces the system message above');

    // Once per change: the next build appends nothing about the rules.
    const third = await buildContext(store, { ...base, previousContext: second, noteKey: 'ctxN:r2:1' });
    expect(wire(third.messages)).toEqual(wire(second.messages));
  });
});

describe('stable tools array', () => {
  const names = (tools: Array<{ name: string }>) => tools.map((tool) => tool.name);

  it('keeps built-ins first and appends added tools in the order they were added', () => {
    const builtin = ['state_update', 'todo_write', 'browser.navigate'];
    const first = mergeToolOrder(undefined, builtin);
    expect(first).toEqual(builtin);
    const withMcp = mergeToolOrder(first, [...builtin, 'mcp.zeta.search']);
    const later = mergeToolOrder(withMcp, ['mcp.alpha.read', ...builtin, 'mcp.zeta.search', 'mcp.beta.list']);
    // Discovery order shuffled, an older server gained a tool, a new one appeared: nothing moves, new names go last.
    expect(later).toEqual([...builtin, 'mcp.zeta.search', 'mcp.alpha.read', 'mcp.beta.list']);
    const tools = ['mcp.beta.list', 'mcp.zeta.search', ...builtin, 'mcp.alpha.read'].map((name) => ({ name }));
    expect(names(orderTools(tools, later))).toEqual(later);
    // A removed tool is dropped (one prefix change); the rest keep their slots.
    expect(mergeToolOrder(later, later.filter((name) => name !== 'todo_write'))).toEqual(later.filter((name) => name !== 'todo_write'));
  });

  it('persists the order on the frozen system row and carries it on the context across rebuilds', async () => {
    const store = await seed();
    const first = await buildContext(store, { ...base, noteKey: 'ctx0:r1', toolNames: ['a', 'b', 'c'] });
    expect(first.toolOrder).toEqual(['a', 'b', 'c']);
    // A new run discovers the tools in another order plus a new one: persisted slots win.
    const second = await buildContext(store, { ...base, noteKey: 'ctx0:r2', toolNames: ['c', 'd', 'b', 'a'] });
    expect(second.toolOrder).toEqual(['a', 'b', 'c', 'd']);
    // A rebuild that discovered nothing keeps the order.
    const third = await buildContext(store, { ...base, previousContext: second, noteKey: 'ctxN:r2:1' });
    expect(third.toolOrder).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('replayed thinking', () => {
  const identity = { api: 'openai-completions', provider: 'openai', model: 'gpt-6-luna' };
  const turn = (model: string, thinkingSignature?: string): Message => ({
    role: 'assistant', api: 'openai-completions', provider: 'openai', model, stopReason: 'stop', timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: 'thinking', thinking: 'The user just said hi', ...(thinkingSignature === undefined ? {} : { thinkingSignature }) }, { type: 'text', text: 'Hi!' }],
  });
  const drop = { reasoningItems: false, wireReasoningField: false };

  it('removes plain-text thinking from every replayed turn, same model or not', () => {
    const out = stripReplayedThinking([turn('opencode-go/longcat', 'reasoning_content'), turn('gpt-6-luna', 'reasoning_content'), turn('gpt-6-luna')], identity, drop);
    for (const message of out) {
      expect(JSON.stringify(message)).not.toContain('The user just said hi');
      expect(message.role === 'assistant' && message.content).toEqual([{ type: 'text', text: 'Hi!' }]);
    }
  });

  it('keeps a Responses reasoning item only from the same provider/api/model, and the wire reasoning field only when asked', () => {
    const item = JSON.stringify({ type: 'reasoning', id: 'rs_1', encrypted_content: 'abc', summary: [] });
    const responses = { api: 'openai-responses', provider: 'openai', model: 'gpt-6-luna' };
    const own = { ...turn('gpt-6-luna', item), api: 'openai-responses' } as Message;
    const foreign = { ...turn('other', item), api: 'openai-responses' } as Message;
    const kept = stripReplayedThinking([own, foreign], responses, { reasoningItems: true, wireReasoningField: false });
    expect(kept[0]?.role === 'assistant' && kept[0].content.map((b) => b.type)).toEqual(['thinking', 'text']);
    expect(kept[1]?.role === 'assistant' && kept[1].content.map((b) => b.type)).toEqual(['text']);
    const field = stripReplayedThinking([turn('gpt-6-luna', 'reasoning_content')], identity, { reasoningItems: false, wireReasoningField: true });
    expect(field[0]?.role === 'assistant' && field[0].content.map((b) => b.type)).toEqual(['thinking', 'text']);
  });
});

describe('compaction keeps the system row and the user\'s words', () => {
  it('re-delivers the sections after a compaction and keeps recent user messages verbatim ahead of the summary', async () => {
    const store = await seed();
    const provider = {
      getLimits: async () => ({ contextWindow: 4096, maxOutputTokens: 512 }),
      call: async () => ({ text: 'Earlier work summarized.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, stopReason: 'stop' as const }),
    };
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider });
    const long = 'x'.repeat(1500);
    const first = await brain.buildContext({ ...base, noteKey: 'ctx0:r1' });
    const system = String((first.messages as Message[])[0]?.content);
    const rows: Message[] = [];
    for (let index = 0; index < 8; index += 1) rows.push({ role: 'user', content: 'question ' + String(index) + ' ' + long, timestamp: index });
    await appendToTranscript(store, KEY, rows, 'seed');
    const compacted: BrainContext = await brain.compact(await brain.buildContext({ ...base, previousContext: first, noteKey: 'ctxN:r1:1' }));
    expect(compacted.compactionEpoch).toBe(1);
    const rebuilt = await brain.buildContext({ ...base, noteKey: 'ctx0:r2' });
    const messages = rebuilt.messages as Message[];
    expect(String(messages[0]?.content)).toBe(system);
    expect(JSON.stringify(messages)).toContain('Earlier work summarized.');
    expect(JSON.stringify(messages)).toContain('[Earlier user messages, verbatim]');
    // The notes the summary swallowed are gone from the projection, so the sections are delivered again.
    expect(noteTexts(messages).join('\n')).toContain('## Session');
    expect(withoutNotes(messages).some((m) => m.role === 'user')).toBe(true);
  });
});

describe('the user\'s details section', () => {
  it('appears as a note once saved, stays out of the frozen system row, and updates as a note when edited', async () => {
    const store = await seed();
    // The run serves the owner alone: both agents are the owner's and the wake comes from the owner.
    for (const id of [AGENT, PEER]) await store.put('agents', { ...agentDoc(id, []), ownerId: 'owner-1' } as never);
    const ownerRun = { ...base, wake: [{ ...wakeFor(AGENT), origin: { type: 'user' as const, id: 'owner-1' } }] };
    const first = await buildContext(store, { ...ownerRun, noteKey: 'ctx0:r1' });
    expect(noteTexts(first.messages).join('\n')).not.toContain("Your user's details");

    const put = (body: Record<string, unknown>) => store.put('profiles', { id: 'profile-owner-1', updatedAt: new Date().toISOString(), ...body } as never);
    const entry = (key: string, value: string) => ({ id: key, key, value, visibility: 'private', source: { by: 'user', at: new Date().toISOString() } });
    await put({ entries: [entry('Name', 'Jane Tan'), entry('Phone', '+65 9123 4567')] });
    const second = await buildContext(store, { ...ownerRun, previousContext: first, noteKey: 'ctxN:r1:1' });
    const added = noteTexts(second.messages).filter((text) => !noteTexts(first.messages).includes(text));
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("## Your user's details");
    expect(added[0]).toContain('Jane Tan');
    expect(JSON.stringify(second.messages[0])).not.toContain('Jane Tan');

    await put({ entries: [entry('Name', 'Jane Tan'), entry('Phone', '+65 9123 4567'), entry('Home address', '10 Anson Rd\nSingapore 079903')] });
    const third = await buildContext(store, { ...ownerRun, previousContext: second, noteKey: 'ctxN:r1:2' });
    const latest = noteTexts(third.messages).at(-1) ?? '';
    expect(latest).toContain('10 Anson Rd');
    expect(latest.match(/Your user's details/g)).toHaveLength(1);
  });
});

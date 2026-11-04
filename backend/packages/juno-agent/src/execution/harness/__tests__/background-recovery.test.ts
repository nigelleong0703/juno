import { describe, expect, it } from 'vitest';
import { DurablePromise } from '@agent-desktop/durable';
import type { BackgroundCallStart, Doc, Tool, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { abortBackgroundCall, endBackgroundTask } from '../../../modules/tasks/background-registry.js';
import { runBackgroundCall } from '../services/background-call.js';
import { executeSingleToolCall } from '../services/run-tools.js';
import { recoveryFingerprint } from '../services/recovery-ledger.js';
import type { RunServices } from '../services/run-types.js';

const AT = '2026-10-29T00:00:00.000Z';
const wake: WakeEvent = { id: 'w', ownerId: 'owner', agentId: 'agent', conversationId: 'conv', sessionKey: 'agent:conv', kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: AT, status: 'accepted' };
const binding = { ownerId: 'owner', agentId: 'agent', conversationId: 'conv', connectionId: 'connection', account: 'account-a' };
const args = { to: 'fixture', text: 'hello' };

function context(prefix: string) {
  let sequence = 0;
  return {
    rand: { uuidv4: () => prefix + '-' + String(++sequence) },
    run: <T>(_name: string, action: () => Promise<T>) => DurablePromise.resolve(action()),
    awakeable: <T>() => ({ id: prefix + '-awake', promise: DurablePromise.resolve({ interruptedByMessage: true } as T) }),
    drainInbox: () => DurablePromise.resolve<WakeEvent[]>([]),
  };
}

async function fixture(overrides: Partial<Tool> = {}) {
  const raw = createMemoryStore();
  const store = raw.forOwner!('owner');
  let effects = 0;
  const tool: Tool = {
    name: 'fixture_send', description: 'Send to the fixture', parameters: {}, mcp: true, replay: 'never', sideEffect: true,
    origin: { connectionId: 'connection', connectionName: 'Fixture', account: 'account-a', toolName: 'send', access: 'action', actions: 'allow' },
    execute: async () => { effects++; return { content: [{ type: 'text', text: 'delivered' }] }; },
    ...overrides,
  };
  const reader: Tool = { name: 'fixture_read', description: 'Look at the fixture', parameters: {}, replay: 'safe', sideEffect: false, execute: async () => ({ content: [{ type: 'text', text: 'nothing there' }]}) };
  const registry = { get: (name: string) => [tool, reader].find((candidate) => candidate.name === name), forAgent: async () => [tool, reader] };
  const deps = { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), toolRegistry: registry };
  await store.put('agents', { id: 'agent', name: 'Fixture', createdBy: 'owner' } as never);
  await store.put('conversations', { id: 'conv', kind: 'direct', memberIds: ['owner'], agentIds: ['agent'] } as never);
  const run = async (id: string) => store.put('runs', { id, agentId: 'agent', conversationId: 'conv', kind: 'chat', title: id, status: 'completed', steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT });
  await run('original');
  const intent = { ...binding, tool: tool.name, fingerprint: recoveryFingerprint(tool.name, args, binding, true) };
  const step = async (id: string, runId = 'original', execution?: object) => {
    const row: Doc<'steps'> = { id, runId, index: 0, kind: 'mcp', tool: tool.name, verb: 'Executed', target: tool.name, status: 'running', durationMs: 0, startedAt: AT };
    await store.put('steps', execution === undefined ? row : Object.assign(row, { execution }), { runId });
    return row;
  };
  const input = (id: string, runId = 'original', arguments_: Record<string, unknown> = args): BackgroundCallStart => ({ taskId: 'mcp-' + id, ownerId: 'owner', agentId: 'agent', conversationId: 'conv', runId, toolName: tool.name, arguments: arguments_, wake });
  const background = async (id: string, runId = 'original', arguments_: Record<string, unknown> = args) => {
    const wakes: WakeEvent[] = [];
    let done = false;
    await runBackgroundCall({ ...context(id), key: 'mcp-' + id, done: async () => done, markDone: () => { done = true; }, now: () => DurablePromise.resolve(Date.parse(AT)), sendWake: (event) => { wakes.push(event); } }, deps, input(id, runId, arguments_));
    return wakes;
  };
  const services: RunServices = { ...deps, brain: { buildContext: async () => ({ agentId: 'agent', sessionKey: 'agent:conv' }), step: async () => { throw new Error('no model calls expected'); }, shouldCompact: () => false, compact: async (ctx) => ctx } };
  return { raw, store, tool, deps, intent, step, run, input, background, services, effects: () => effects };
}

function reviews(f: Awaited<ReturnType<typeof fixture>>) { return f.store.list('requests', { limit: 100 }); }

describe('background recovery through production tool handlers', () => {
  it('keeps interrupted read-only queries out of the reconciliation ledger and allows a later query', async () => {
    const f = await fixture({ sideEffect: false, replay: 'safe' });
    await f.step('read-interrupted', 'original', { fencedAt: AT });
    const interrupted = await f.background('read-interrupted');
    expect(interrupted[0]?.payload).toMatchObject({ status: 'failed' });
    expect(f.effects()).toBe(0);
    expect((await reviews(f)).items).toHaveLength(0);
    await f.run('read-again');
    await f.step('read-new', 'read-again');
    const next = await f.background('read-new', 'read-again');
    expect(next[0]?.payload).toMatchObject({ status: 'completed' });
    expect(f.effects()).toBe(1);
    expect((await reviews(f)).items).toHaveLength(0);
  });

  it('tells the agent once per attempt (no card), holds an identical call until the agent has read, then lets it through', async () => {
    const secret = 'Bearer abcdefghijklmnopqrstuvwxyz';
    const f = await fixture({ reconcile: async () => ({ status: 'unknown', reason: 'lookup failed ' + secret }) });
    await f.step('lost', 'original', { fencedAt: AT, intent: f.intent });
    const wakes = await f.background('lost');
    await f.background('lost');
    expect((await reviews(f)).items).toHaveLength(0);
    expect(JSON.stringify(wakes)).toContain('may or may not have happened');
    expect(JSON.stringify([wakes, await f.store.get('steps', 'lost')])).not.toContain(secret);
    await f.run('foreground');
    const callAgain = (id: string) => executeSingleToolCall(context('foreground'), f.services, { agentId: 'agent', conversationId: 'conv', sessionKey: 'agent:conv', wakeEvents: [wake] }, 'foreground', 0, 0, { id, name: f.tool.name, arguments: { ...args, background: false, taskTitle: 'A different label' } });
    const held = await callAgain('retry');
    expect(typeof held).not.toBe('symbol');
    if (typeof held !== 'symbol') expect(held.result.content[0]).toMatchObject({ text: expect.stringContaining('This call was not made') });
    expect(f.effects()).toBe(0);
    // The agent looks (a read step after the notice), and the identical call is then allowed: it is a new fenced call, and the old one stops holding.
    const laterThanNotice = new Date(Date.now() + 60_000).toISOString();
    await f.store.patch('runs', 'foreground', { steps: [{ id: 'look', runId: 'foreground', index: 0, kind: 'mcp', tool: 'fixture_read', verb: 'Executed', target: 'fixture_read', status: 'completed', durationMs: 1, startedAt: laterThanNotice }] });
    await callAgain('retry-2');
    expect(f.effects()).toBe(1);
    expect(await f.store.get('steps', 'lost')).toMatchObject({ execution: { releasedAt: expect.any(String) } });
  });

  it('adopts a legacy background fence as an uncertain action (the agent is told) without using a guessed receipt or repeating it', async () => {
    let checks = 0;
    const f = await fixture({ reconcile: async () => { checks++; return { status: 'succeeded', evidence: 'guessed', result: { content: [] } }; } });
    await f.step('legacy', 'original', { fencedAt: AT });
    const wakes = await f.background('legacy');
    expect(checks).toBe(0);
    expect(f.effects()).toBe(0);
    expect(await f.store.get('steps', 'legacy')).toMatchObject({ execution: { legacyBinding: true, intent: f.intent, notice: { runId: 'original' } } });
    expect((await reviews(f)).items).toHaveLength(0);
    expect(JSON.stringify(wakes)).toContain('may or may not have happened');
  });

  it('holds back a foreground call that repeats a historical background fence', async () => {
    const f = await fixture();
    await f.step('legacy', 'original', { fencedAt: AT });
    await f.run('next');
    const result = await executeSingleToolCall(context('next'), f.services, { agentId: 'agent', conversationId: 'conv', sessionKey: 'agent:conv', wakeEvents: [wake] }, 'next', 0, 0, { id: 'retry', name: f.tool.name, arguments: { ...args, background: false } });
    expect(typeof result).not.toBe('symbol');
    expect(f.effects()).toBe(0);
    expect((await reviews(f)).items).toHaveLength(0);
    expect(await f.store.get('steps', 'legacy')).toMatchObject({ execution: { notice: { runId: 'next' } } });
  });

  it('reuses a trusted result, redacts evidence and the result, and does not call the external write', async () => {
    const secret = 'Bearer abcdefghijklmnopqrstuvwxyz';
    const f = await fixture({ reconcile: async () => ({ status: 'succeeded', evidence: 'receipt ' + secret, result: { content: [{ type: 'text', text: 'delivered ' + secret }] } }) });
    await f.step('receipt', 'original', { fencedAt: AT, intent: f.intent });
    const wakes = await f.background('receipt');
    await f.background('receipt');
    expect(f.effects()).toBe(0);
    expect(wakes[0]?.payload).toMatchObject({ status: 'completed' });
    expect(await f.store.get('steps', 'receipt')).toMatchObject({ execution: { reconciliation: { status: 'succeeded' } } });
    expect(JSON.stringify([wakes, await f.store.get('steps', 'receipt')])).not.toContain(secret);
    expect((await reviews(f)).items).toHaveLength(0);
  });

  it('uses a separate attempt fence after confirmed absence and never repeats a completed retry', async () => {
    const f = await fixture({ reconcile: async () => ({ status: 'not_executed', evidence: 'authoritative operation lookup' }) });
    await f.step('absent', 'original', { fencedAt: AT, intent: f.intent });
    await f.background('absent');
    await f.background('absent');
    expect(f.effects()).toBe(1);
    const attempts = (await f.store.list('steps', { limit: 20 })).items.filter((row) => row.id.startsWith('stp_retry_'));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ execution: { intent: { attempt: 1 } } });
  });

  it('consumes one person-authorized repeat across foreground/background control changes', async () => {
    const f = await fixture();
    await f.step('uncertain', 'original', { fencedAt: AT, intent: f.intent });
    // The person was asked (ask_about_uncertain_action) and answered "do it again".
    const asked = { id: 'req-asked', kind: 'question', status: 'answered', title: 'Agent Question', summary: 'Send it again?', agentId: 'agent', conversationId: 'conv', runId: 'original', createdAt: AT,
      payload: { kind: 'question', ui: { version: 1, blocks: [] } },
      reconciliation: { stepId: 'uncertain', tool: f.tool.name, fingerprint: f.intent.fingerprint, connectionId: binding.connectionId, account: binding.account, state: 'authorized' } } as never;
    await f.store.put('requests', asked);
    await f.run('retry');
    await f.step('authorized', 'retry');
    await f.background('authorized', 'retry', { ...args, background: true, taskTitle: 'Retry label' });
    await f.background('authorized', 'retry');
    expect(f.effects()).toBe(1);
    expect(await f.store.get('requests', 'req-asked')).toMatchObject({ reconciliation: { state: 'completed', attemptStepId: 'authorized' } });
    expect(await f.store.get('steps', 'authorized')).toMatchObject({ execution: { intent: { attempt: 1 } } });
  });

  it('drops a stopped noncooperative call and its late result cache and artifact writes', async () => {
    let finish!: (result: ToolResult) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const f = await fixture({ execute: async () => { started(); return new Promise<ToolResult>((resolve) => { finish = resolve; }); } });
    await f.step('stopped');
    await f.store.put('backgroundTasks', { id: 'mcp-stopped', ...binding, runId: 'original', kind: 'mcp', label: f.tool.name, notify: true, chainId: 'original', generation: 1, status: 'running', startedAt: AT });
    const running = f.background('stopped');
    await ready;
    await endBackgroundTask(f.store, 'mcp-stopped', 'stopped', AT);
    abortBackgroundCall('mcp-stopped');
    expect(await running).toEqual([]);
    finish({ content: [{ type: 'text', text: 'late ' + 'x'.repeat(10_000) }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await f.store.get('steps', 'stopped')).not.toHaveProperty('execution.result');
    expect((await f.store.list('artifacts')).items).toHaveLength(0);
    expect((await reviews(f)).items).toHaveLength(0);
  });
});

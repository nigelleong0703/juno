import { describe, expect, it } from 'vitest';
import type { ObjectContext } from '@agent-desktop/durable';
import type { Routine } from '@agent-desktop/public-contracts';
import type { Store, Tool, ToolResult, WakeEvent } from '../../../../contracts/index.js';
import { createMemoryStore } from '../../../../testing/store.js';
import { createMemoryBlobStore } from '../../../../testing/blobs.js';
import { RecordingEnqueuer } from '../../../testing/enqueuer.js';
import { MONITOR_RECONNECT_GIVE_UP_MS } from '../../../../modules/tasks/routines/monitor.js';
import { createRoutineTimerHandlers } from '../routineTimer.js';
import type { TimerState } from '../routineTimer-state.js';
import { requestScopedStore } from '../../../../owner-context.js';

const NOW = '2026-10-22T10:00:00.000Z';
const at = (offsetMs: number): string => new Date(Date.parse(NOW) + offsetMs).toISOString();

const routine: Routine & { ownerId: string } = {
  id: 'mon', ownerId: 'owner', agentId: 'agent', name: 'New issues', instructions: 'tell me about new issues',
  trigger: { kind: 'check', everyMinutes: 30, human: 'Every 30 minutes', tool: 'list_issues', args: { repo: 'acme/app' }, items: 'issues', id: 'id' },
  delivery: { channel: 'chat', target: 'chat' }, notify: { mode: 'always' }, enabled: true, status: 'active',
  monitor: { expiresAt: at(30 * 86_400_000), failures: 0 }, runs: [], createdAt: NOW,
};

interface Sent { handler: 'arm' | 'receive'; payload: unknown }

/** One handler invocation: journaled steps, durable clock, and the sends it made. */
function invocation(state: Map<string, unknown>, nowIso = NOW, options: { failReceive?: boolean } = {}) {
  const journal = new Map<string, unknown>();
  const initial = structuredClone(state.get('state'));
  const sends: Sent[] = [];
  const ctx = {
    key: 'mon',
    date: { now: async () => Date.parse(nowIso) },
    get: async () => structuredClone(initial),
    set: (name: string, value: unknown) => { state.set(name, structuredClone(value)); },
    run: async (name: string, action: () => Promise<unknown>) => {
      if (journal.has(name)) return structuredClone(journal.get(name));
      const value = await action();
      journal.set(name, structuredClone(value));
      return value;
    },
    objectSendClient: () => ({
      fire: () => undefined,
      arm: (payload: unknown) => { sends.push({ handler: 'arm', payload }); },
      receive: (payload: unknown) => {
        if (options.failReceive === true) throw new Error('enqueue failed');
        sends.push({ handler: 'receive', payload });
      },
    }),
    objectClient: () => ({ getState: async () => ({}) }),
  } as unknown as ObjectContext;
  return { ctx, sends, wakes: (): WakeEvent[] => sends.flatMap((sent) => (sent.handler === 'receive' ? [sent.payload as WakeEvent] : [])) };
}

function readTool(source: { result: () => ToolResult; access?: 'read' | 'action' }): Tool {
  return {
    name: 'list_issues', description: 'List issues', parameters: { type: 'object', properties: {} }, replay: 'never', sideEffect: true, mcp: true,
    origin: { connectionId: 'con', connectionName: 'Tracker', toolName: 'list_issues', access: source.access ?? 'read' },
    execute: async () => source.result(),
  };
}

const issues = (...ids: number[]): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ issues: ids.map((id) => ({ id, title: 'Issue ' + String(id) })) }) }] });
const broken = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

async function setup(options: { tools?: Tool[]; seen?: string[]; failures?: number; monitor?: Routine['monitor'] } = {}) {
  const store = createMemoryStore();
  await store.put('routines', { ...routine, ...(options.monitor === undefined ? {} : { monitor: options.monitor }) });
  await store.put('agents', { id: 'agent', name: 'Agent', ownerId: 'owner' } as never);
  await store.put('conversations', { id: 'chat', kind: 'direct', agentIds: ['agent'], memberIds: ['owner'], unreadCount: 0, lastItemAt: NOW, createdAt: NOW });
  await store.put('monitorState', { id: 'mon', agentId: 'agent', seen: options.seen ?? ['1', '2'], failures: options.failures ?? 0, updatedAt: NOW });
  const source = { result: () => issues(1, 2) };
  const tools = options.tools ?? [readTool(source)];
  const handlers = createRoutineTimerHandlers({ store, enqueuer: new RecordingEnqueuer(), blobs: createMemoryBlobStore(), tools: { forAgent: async () => tools, get: () => undefined } });
  return { store, handlers, source };
}

describe('monitor check in the routine timer', () => {
  it('wakes the agent once for a new item, with the item as untrusted data, and remembers it', async () => {
    const { store, handlers, source } = await setup();
    source.result = () => issues(1, 2, 3);
    const first = invocation(new Map());
    expect(await handlers.checkNow(first.ctx)).toEqual({ outcome: 'woke' });
    const [wake] = first.wakes();
    expect(first.wakes()).toHaveLength(1);
    expect(wake).toMatchObject({ kind: 'monitor', trusted: false, conversationId: 'chat', origin: { type: 'automation', id: 'mon' }, payload: { count: 1, instructions: 'tell me about new issues' } });
    expect(String(wake?.payload['text'])).toContain('Issue 3');
    expect(String(wake?.payload['text'])).not.toContain('Issue 1');
    expect((await store.get('monitorState', 'mon'))?.seen).toEqual(['1', '2', '3']);
    expect((await store.get('routines', 'mon'))?.monitor).toMatchObject({ lastCheckedAt: NOW, lastMatchAt: NOW, failures: 0 });
    expect(first.sends.some((sent) => sent.handler === 'arm')).toBe(true);
    // The same list again finds nothing new and wakes nobody.
    const second = invocation(new Map(), at(60_000));
    expect(await handlers.checkNow(second.ctx)).toEqual({ outcome: 'nothing_new' });
    expect(second.wakes()).toHaveLength(0);
  });

  it('keeps the seen set as it was when the wake could not be enqueued', async () => {
    const { store, handlers, source } = await setup();
    source.result = () => issues(1, 2, 3);
    await expect(handlers.checkNow(invocation(new Map(), NOW, { failReceive: true }).ctx)).rejects.toThrow('enqueue failed');
    expect((await store.get('monitorState', 'mon'))?.seen).toEqual(['1', '2']);
    // The retry reports the item.
    const retry = invocation(new Map());
    expect(await handlers.checkNow(retry.ctx)).toEqual({ outcome: 'woke' });
  });

  it('holds new items back, unseen, while the owner is over the wake cap', async () => {
    const { store, handlers, source } = await setup();
    source.result = () => issues(1, 2, 3);
    for (let i = 0; i < 30; i += 1) {
      await store.put('audit', { id: 'w' + String(i), at: at(-60_000 * (i + 1)), actor: 'system', action: 'monitor.wake', decision: 'auto_allowed', reason: 'earlier', initiator: { type: 'system', wakeKind: 'system' }, unattended: true }, { kind: 'monitor.wake' });
    }
    const capped = invocation(new Map());
    expect(await handlers.checkNow(capped.ctx)).toEqual({ outcome: 'held' });
    expect(capped.wakes()).toHaveLength(0);
    expect((await store.get('monitorState', 'mon'))?.seen).toEqual(['1', '2']);
    // An hour later those wakes no longer count.
    const later = invocation(new Map(), at(3_600_000 * 2));
    expect(await handlers.checkNow(later.ctx)).toEqual({ outcome: 'woke' });
  });

  it('tells the owner once after three failures in a row, backs off, and stops after ten', async () => {
    const { store, handlers, source } = await setup();
    source.result = () => broken('Tracker is down');
    const notices: WakeEvent[] = [];
    let last = invocation(new Map());
    for (let i = 1; i <= 10; i += 1) {
      last = invocation(new Map(), at(i * 3_600_000));
      const outcome = await handlers.checkNow(last.ctx);
      notices.push(...last.wakes());
      expect(outcome.outcome).toBe(i < 10 ? 'failed' : 'stopped');
    }
    const failing = notices.filter((wake) => String(wake.payload['text']).includes('failed 3 checks'));
    expect(failing).toHaveLength(1);
    expect(failing[0]).toMatchObject({ kind: 'monitor', trusted: true, payload: { notice: true } });
    const stored = await store.get('routines', 'mon');
    expect(stored).toMatchObject({ enabled: false, status: 'paused', monitor: { stoppedReason: 'failures', failures: 10 } });
    expect(last.sends.some((sent) => sent.handler === 'arm')).toBe(false);
  });

  it('shows needs-reconnect when the connector is gone, and gives up after 72 hours', async () => {
    const { store, handlers } = await setup({ tools: [] });
    expect(await handlers.checkNow(invocation(new Map()).ctx)).toEqual({ outcome: 'failed' });
    expect((await store.get('routines', 'mon'))?.monitor).toMatchObject({ needsReconnect: true, failures: 1 });
    const early = invocation(new Map(), at(MONITOR_RECONNECT_GIVE_UP_MS - 1000));
    expect(await handlers.checkNow(early.ctx)).toEqual({ outcome: 'failed' });
    const over = invocation(new Map(), at(MONITOR_RECONNECT_GIVE_UP_MS + 1000));
    expect(await handlers.checkNow(over.ctx)).toEqual({ outcome: 'stopped' });
    expect(await store.get('routines', 'mon')).toMatchObject({ enabled: false, monitor: { stoppedReason: 'reconnect' } });
    expect(over.wakes().some((wake) => String(wake.payload['text']).includes('72 hours'))).toBe(true);
  });

  it('refuses to run a tool that changes things, so an edited monitor can never act', async () => {
    const { handlers } = await setup({ tools: [readTool({ result: () => issues(1), access: 'action' })] });
    const run = invocation(new Map());
    expect(await handlers.checkNow(run.ctx)).toEqual({ outcome: 'failed' });
  });

  it('stops at its expiry and asks the agent to ask about renewing', async () => {
    const { store, handlers } = await setup({ monitor: { expiresAt: at(-1000), failures: 0 } });
    const run = invocation(new Map());
    expect(await handlers.checkNow(run.ctx)).toEqual({ outcome: 'expired' });
    expect(await store.get('routines', 'mon')).toMatchObject({ enabled: false, monitor: { stoppedReason: 'expired' } });
    expect(run.wakes()[0]?.payload['text']).toContain('renew');
    expect(run.sends.some((sent) => sent.handler === 'arm')).toBe(false);
  });

  it('arms one interval ahead, further after failures, and starts fresh when switched back on after stopping', async () => {
    const { store, handlers } = await setup({ failures: 2 });
    const armed = new Map<string, unknown>();
    await handlers.arm(invocation(armed).ctx, routine);
    expect((armed.get('state') as TimerState).nextRunAtTime).toBe(at(2 * 3_600_000));
    // Stopped by failures, then switched on by the owner.
    await store.patch('routines', 'mon', { enabled: true, status: 'active', monitor: { expiresAt: at(-1000), failures: 10, stoppedReason: 'failures', lastError: 'down' } });
    const again = new Map<string, unknown>();
    await handlers.arm(invocation(again).ctx, routine);
    expect((again.get('state') as TimerState).nextRunAtTime).toBe(at(30 * 60_000));
    expect((await store.get('monitorState', 'mon'))?.failures).toBe(0);
    const renewed = (await store.get('routines', 'mon'))?.monitor;
    expect(renewed?.stoppedReason).toBeUndefined();
    expect(Date.parse(renewed?.expiresAt ?? '')).toBeGreaterThan(Date.parse(NOW));
  });

  it('pauses while the monitors plugin is off: no check, no next check, and the routine is kept', async () => {
    const store = createMemoryStore();
    await store.put('routines', { ...routine });
    await store.put('agents', { id: 'agent', name: 'Agent', ownerId: 'owner' } as never);
    await store.put('conversations', { id: 'chat', kind: 'direct', agentIds: ['agent'], memberIds: ['owner'], unreadCount: 0, lastItemAt: NOW, createdAt: NOW });
    await store.put('monitorState', { id: 'mon', agentId: 'agent', seen: ['1'], failures: 0, updatedAt: NOW });
    const source = { result: () => issues(1, 2, 3) };
    const paused = createRoutineTimerHandlers({ store, enqueuer: new RecordingEnqueuer(), blobs: createMemoryBlobStore(), monitorChecks: false, tools: { forAgent: async () => [readTool(source)], get: () => undefined } });
    const check = invocation(new Map());
    expect(await paused.checkNow(check.ctx)).toEqual({ outcome: 'unavailable' });
    expect(check.wakes()).toHaveLength(0);
    const armed = new Map<string, unknown>();
    await paused.arm(invocation(armed).ctx, routine);
    expect((armed.get('state') as TimerState).armed).toBe(false);
    expect(await store.get('routines', 'mon')).toMatchObject({ enabled: true, status: 'active' });
    // Switched back on, the same routine arms and checks again.
    const resumed = createRoutineTimerHandlers({ store, enqueuer: new RecordingEnqueuer(), blobs: createMemoryBlobStore(), monitorChecks: true, tools: { forAgent: async () => [readTool(source)], get: () => undefined } });
    const back = new Map<string, unknown>();
    await resumed.arm(invocation(back).ctx, routine);
    expect((back.get('state') as TimerState).armed).toBe(true);
    expect(await resumed.checkNow(invocation(new Map()).ctx)).toEqual({ outcome: 'woke' });
  });

  // Regression (the e2e monitor scenario): the second check of an owner's monitor failed with "monitorState is already owned by
  // another owner". The timer runs with the request-scoped store, as production does; both checks must succeed and the state must
  // stay with that owner.
  it('two checks in a row for the same owner both succeed, and the state stays owned by that owner', async () => {
    const base = createMemoryStore() as Store & { forOwner(owner: string): Store };
    const scoped = base.forOwner('owner');
    await scoped.put('routines', { ...routine });
    await scoped.put('agents', { id: 'agent', name: 'Agent', ownerId: 'owner' } as never);
    await scoped.put('conversations', { id: 'chat', kind: 'direct', agentIds: ['agent'], memberIds: ['owner'], unreadCount: 0, lastItemAt: NOW, createdAt: NOW } as never);
    await scoped.put('monitorState', { id: 'mon', agentId: 'agent', seen: ['1', '2'], failures: 0, updatedAt: NOW } as never);
    const source = { result: () => issues(1, 2) };
    const handlers = createRoutineTimerHandlers({
      store: requestScopedStore(base), enqueuer: new RecordingEnqueuer(), blobs: createMemoryBlobStore(), tools: { forAgent: async () => [readTool(source)], get: () => undefined },
    });
    expect(await handlers.checkNow(invocation(new Map()).ctx)).toEqual({ outcome: 'nothing_new' });
    expect(await handlers.checkNow(invocation(new Map(), at(60_000)).ctx)).toEqual({ outcome: 'nothing_new' });
    expect((await scoped.get('monitorState', 'mon'))?.seen).toEqual(['1', '2']);
    expect(await base.forOwner('someone-else').get('monitorState', 'mon')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { TerminalError } from '@agent-desktop/durable';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store, WakeEvent } from '../../../contracts/index.js';
import type { Agent, Run, RunEngineSnapshot } from '@agent-desktop/public-contracts';
import { createPiAdapter } from '../engines/pi.js';
import { createEngineRegistry, type EngineAdapter } from '../engines/registry.js';
import { startEngineForRun, type RunStartContext } from '../services/run.js';
import type { RunInput } from '../services/run-types.js';

const at = new Date().toISOString();

const wake: WakeEvent = {
  id: 'wake-1',
  ownerId: 'owner',
  agentId: 'agent-1',
  sessionKey: 'agent-1:conv-1',
  conversationId: 'conv-1',
  kind: 'user_message',
  origin: { type: 'user' },
  trusted: true,
  priority: 'user',
  payload: { text: 'hi' },
  at,
  status: 'accepted',
};
const input: RunInput = {
  agentId: 'agent-1',
  conversationId: 'conv-1',
  sessionKey: 'agent-1:conv-1',
  wakeEvents: [wake],
};

function agentWithEngine(id: string, revision: string): Agent {
  return {
    id: 'agent-1',
    name: 'A',
    handle: 'a',
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'T',
    status: 'idle',
    section: 'Inbox',
    pinned: false,
    lastActivity: '',
    unreadCount: 0,
    model: {
      planner: { provider: 'p', model: 'm' },
      computer: { provider: 'p', model: 'm' },
      fast: { provider: 'p', model: 'm' },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: at,
    updatedAt: at,
    engine: { id, revision, updatedAt: at },
  };
}

/** In-memory RunStartContext: journaled init replay plus a visible Session release log. */
function starterContext(preloadedInit?: RunEngineSnapshot): { ctx: RunStartContext; released: string[] } {
  const released: string[] = [];
  let initValue: RunEngineSnapshot | undefined = preloadedInit;
  return {
    released,
    ctx: {
      runInit: async (action) => {
        if (initValue !== undefined) return initValue;
        const value = await action();
        initValue = value;
        return value;
      },
      runFail: async (action) => {
        await action();
      },
      releaseSession: async (sessionKey, runId) => {
        released.push(sessionKey + ':' + runId);
      },
    },
  };
}

const noCancel = { peek: async () => false };
const cancelled = { peek: async () => true };

async function runDoc(store: Store): Promise<Run | null> {
  return store.get('runs', 'run-1');
}

describe('Run engine start (workflow level)', () => {
  it('fails the Run with evidence and releases the Session on unknown engine', async () => {
    const store = createMemoryStore();
    // The shared pi engine is absent from the registry: the failure comes from the registry,
    // not from legacy per-agent engine data (which the runtime ignores).
    const registry = createEngineRegistry([]);
    const { ctx, released } = starterContext();
    await expect(startEngineForRun(ctx, store, registry, agentWithEngine('pi', '1'), input, 'run-1', noCancel))
      .rejects.toThrow(TerminalError);
    const doc = await runDoc(store);
    expect(doc?.status).toBe('failed');
    expect(doc?.error).toMatch(/unknown engine/i);
    expect(released).toEqual(['agent-1:conv-1:run-1']);
  });

  it('fails the Run with evidence and releases the Session on unavailable engine', async () => {
    const store = createMemoryStore();
    const unavailablePi: EngineAdapter = { ...createPiAdapter(), available: false, reason: 'engine not configured' };
    const registry = createEngineRegistry([unavailablePi]);
    const { ctx, released } = starterContext();
    await expect(startEngineForRun(ctx, store, registry, agentWithEngine('pi', '1'), input, 'run-1', noCancel))
      .rejects.toThrow(/unavailable/i);
    expect((await runDoc(store))?.status).toBe('failed');
    expect(released).toEqual(['agent-1:conv-1:run-1']);
  });

  it('rejects version drift on resume instead of continuing on a new build', async () => {
    const store = createMemoryStore();
    const upgraded: EngineAdapter = {
      ...createPiAdapter(),
      version: '2',
    };
    const registry = createEngineRegistry([upgraded]);
    const { ctx, released } = starterContext({ id: 'pi', version: '1', revision: '3' });
    await expect(startEngineForRun(ctx, store, registry, agentWithEngine('pi', '3'), input, 'run-1', noCancel))
      .rejects.toThrow(/changed mid-run/i);
    const doc = await runDoc(store);
    expect(doc?.status).toBe('failed');
    expect(doc?.engine).toEqual({ id: 'pi', version: '1', revision: '3' });
    expect(released).toEqual(['agent-1:conv-1:run-1']);
  });

  it('titles a completion run after the task it reports on, never after the raw result', async () => {
    const raw = 'report path: research_notes/dynamo-pods/report.md key points: ...';
    const done = (taskId: string): RunInput => ({
      ...input,
      wakeEvents: [{ ...wake, id: 'done-' + taskId, kind: 'task_done', origin: { type: 'system' }, trusted: false, priority: 'background', payload: { taskId, taskKind: 'child', status: 'completed', summary: raw, text: raw } }],
    });
    const titleFor = async (taskId: string): Promise<string | undefined> => {
      const store = createMemoryStore();
      await store.put('runs', { id: 'child-1', agentId: 'agent-1', title: 'Research Dynamo pods', status: 'completed', kind: 'background', steps: [], startedAt: at } as unknown as Run);
      await store.put('backgroundTasks', { id: 'shell-1', agentId: 'agent-1', kind: 'shell', label: 'npm test', title: 'Run the tests', status: 'completed', startedAt: at } as never);
      const { ctx } = starterContext();
      await startEngineForRun(ctx, store, createEngineRegistry([createPiAdapter()]), null, done(taskId), 'run-1', noCancel);
      return (await runDoc(store))?.title;
    };
    expect(await titleFor('child-1')).toBe('Wrapping up: Research Dynamo pods');
    expect(await titleFor('shell-1')).toBe('Wrapping up: Run the tests');
    expect(await titleFor('gone')).toBe('Wrapping up a task');
  });

  it('records what started the run, and gives a child run the origin of the root of its chain', async () => {
    const start = async (store: Store, runId: string, wakeEvent: WakeEvent): Promise<Run> => {
      const { ctx } = starterContext();
      await startEngineForRun(ctx, store, createEngineRegistry([createPiAdapter()]), null, { ...input, wakeEvents: [wakeEvent] }, runId, noCancel);
      const run = await store.get('runs', runId);
      if (run === null) throw new Error('run not written');
      return run;
    };
    const store = createMemoryStore();
    const typed = await start(store, 'run-owner', { ...wake, payload: { text: 'hi', itemId: 'item-1' } });
    expect(typed.origin).toEqual({ type: 'owner_message', conversationId: 'conv-1', itemId: 'item-1' });
    expect(typed.rootOrigin).toBeUndefined();

    const fired = await start(store, 'run-routine', { ...wake, kind: 'routine', origin: { type: 'automation', id: 'rt-1' }, trusted: true, priority: 'background', payload: { routineId: 'rt-1', occurrenceAt: '2026-10-29T08:00:00.000Z' } });
    expect(fired.origin).toEqual({ type: 'routine', routineId: 'rt-1', occurrenceAt: '2026-10-29T08:00:00.000Z' });
    expect(fired.routineId).toBe('rt-1');

    const childWake = (parentRunId: string): WakeEvent => ({ ...wake, kind: 'child_task', origin: { type: 'agent', id: parentRunId, label: 'child task' }, trusted: false, priority: 'background', payload: { parentRunId, prompt: 'p' } });
    const child = await start(store, 'run-child', childWake('run-routine'));
    expect(child.origin).toEqual({ type: 'parent_run', runId: 'run-routine' });
    expect(child.rootOrigin).toEqual(fired.origin);
    const grandchild = await start(store, 'run-grandchild', childWake('run-child'));
    expect(grandchild.rootOrigin).toEqual(fired.origin);

    const stranger = await start(store, 'run-stranger', { ...wake, trusted: false, payload: { text: 'hi', channelKind: 'telegram', speakerRole: 'stranger' } });
    expect(stranger.origin).toEqual({ type: 'channel', channel: 'telegram', conversationId: 'conv-1', speaker: 'stranger' });
    const owner = await start(store, 'run-tg-owner', { ...wake, payload: { text: 'hi', channelKind: 'telegram', speakerRole: 'owner' } });
    expect(owner.origin).toMatchObject({ type: 'channel', speaker: 'owner' });
    const done = await start(store, 'run-done', { ...wake, kind: 'task_done', origin: { type: 'system' }, trusted: false, priority: 'background', payload: { taskId: 'x' } });
    expect(done.origin).toEqual({ type: 'system', wakeKind: 'task_done' });
    expect(done.rootOrigin).toBeUndefined();
    // A completion wake continues the run that started the work: the wrap-up after the owner's task keeps the owner as root.
    const wrapUp = await start(store, 'run-wrap', { ...wake, kind: 'task_done', origin: { type: 'system' }, trusted: false, priority: 'background', payload: { taskId: 'x', originRunId: 'run-owner' } });
    expect(wrapUp.origin).toEqual({ type: 'system', wakeKind: 'task_done' });
    expect(wrapUp.rootOrigin).toEqual(typed.origin);
    const report = await start(store, 'run-report', { ...wake, kind: 'hand_back', origin: { type: 'system' }, trusted: false, priority: 'background', payload: { taskId: 'x', originRunId: 'run-routine' } });
    expect(report.rootOrigin).toEqual(fired.origin);
  });

  it('replays a matching journaled snapshot without re-journaling init', async () => {
    const store = createMemoryStore();
    const registry = createEngineRegistry([createPiAdapter()]);
    const { ctx, released } = starterContext({ id: 'pi', version: '1', revision: '3' });
    const { adapter, snapshot } = await startEngineForRun(ctx, store, registry, agentWithEngine('pi', '3'), input, 'run-1', noCancel);
    expect(adapter.id).toBe('pi');
    expect(snapshot).toEqual({ id: 'pi', version: '1', revision: '3' });
    expect(await runDoc(store)).toBeNull();
    expect(released).toEqual([]);
  });

  it('honors cancellation by stopping instead of failing', async () => {
    const store = createMemoryStore();
    const registry = createEngineRegistry([]);
    const { ctx, released } = starterContext();
    await expect(startEngineForRun(ctx, store, registry, agentWithEngine('pi', '1'), input, 'run-1', cancelled))
      .rejects.toThrow(TerminalError);
    expect((await runDoc(store))?.status).toBe('stopped');
    expect(released).toEqual(['agent-1:conv-1:run-1']);
  });

  it('journals the snapshot on first start and keeps the Session held', async () => {
    const store = createMemoryStore();
    const registry = createEngineRegistry([createPiAdapter()]);
    const { ctx, released } = starterContext();
    const { adapter, snapshot } = await startEngineForRun(ctx, store, registry, null, input, 'run-1', noCancel);
    expect(adapter.id).toBe('pi');
    expect(snapshot).toEqual({ id: 'pi', version: '1' });
    const doc = await runDoc(store);
    expect(doc?.status).toBe('running');
    expect(doc?.engine).toEqual({ id: 'pi', version: '1' });
    expect(released).toEqual([]);
  });
});

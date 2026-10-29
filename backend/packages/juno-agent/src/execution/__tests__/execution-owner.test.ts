/**
 * E66: background execution must run under the wake owner's scope.
 *
 * These tests drive the real Run body and Session admission (not a re-implementation) with the
 * owner-scoped store facade and the in-memory store, for two owners at once: runs, replies, steps,
 * transcripts, events and tool writes must land on the wake owner, a foreign/spoofed wake must be
 * refused, and a mixed batch or a mismatched session key must never become a run.
 */
import { createMemoryBlobStore } from '../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../testing/store.js';
import { sessionKey, type Brain, type Enqueuer, type EventBus, type Store, type Subscription, type Tool, type ToolRegistry, type WakeEvent } from '../../contracts/index.js';
import type { Agent, Conversation, Routine } from '@agent-desktop/public-contracts';
import { requestScopedStore, runWithOwner } from '../../owner-context.js';
import { docOwner, readWakeOwner, resolveAdmittedOwner, resolveWakeOwner, type WakeTarget } from '../execution-owner.js';
import { runWorkflowBody, type RunBodyContext } from '../harness/services/run.js';
import { flushInboxEvent, receiveEvent, type SessionIo, type SessionState } from '../harness/services/session.js';
import { resolveRoutineOwner } from '../harness/services/routineTimer.js';
import { createTriggersService } from '../harness/services/triggers.js';
import type { RunInput, RunServices } from '../harness/services/run-types.js';

const at = '2026-10-06T00:00:00.000Z';
const ownerA = 'owner-a';
const ownerB = 'owner-b';

type MemoryStore = Store & { eventBus: EventBus };

function scoped(raw: MemoryStore, ownerId: string): Store {
  const forOwner = raw.forOwner;
  if (forOwner === undefined) throw new Error('test store must implement forOwner');
  return forOwner(ownerId);
}

function bus(raw: MemoryStore, ownerId: string): EventBus {
  const forOwner = raw.eventBus.forOwner;
  if (forOwner === undefined) throw new Error('test event bus must implement forOwner');
  return forOwner(ownerId);
}

function agentFixture(id: string, ownerId: string): Agent {
  return {
    id,
    name: 'Agent ' + id,
    handle: id,
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
    createdBy: ownerId,
    createdAt: at,
    updatedAt: at,
  };
}

function conversationFixture(id: string, ownerId: string, agentId: string): Conversation {
  return {
    id,
    kind: 'direct',
    agentIds: [agentId],
    memberIds: [ownerId],
    unreadCount: 0,
    lastItemAt: at,
    createdAt: at,
  };
}

function routineFixture(id: string, agentId: string): Routine {
  return {
    id,
    agentId,
    name: 'Routine ' + id,
    instructions: '',
    trigger: { kind: 'schedule', human: 'Daily', tz: 'UTC' },
    delivery: { channel: 'chat' },
    notify: { mode: 'always' },
    enabled: true,
    status: 'active',
    runs: [],
    createdAt: at,
  };
}

function subscriptionFixture(id: string, agentId: string, conversationId: string): Subscription {
  return {
    id,
    agentId,
    conversationId,
    filter: { source: 'github' },
    expiresAt: '2099-01-01T00:00:00.000Z',
    createdAt: at,
  };
}

async function seed(raw: MemoryStore, ownerId: string, agentId: string, conversationId: string): Promise<void> {
  await scoped(raw, ownerId).put('agents', agentFixture(agentId, ownerId));
  await scoped(raw, ownerId).put('conversations', conversationFixture(conversationId, ownerId, agentId));
}

function wakeEvent(overrides: { agentId: string; conversationId: string; ownerId: string; id?: string; sessionKey?: string }): WakeEvent {
  return {
    id: overrides.id ?? 'wk-' + overrides.agentId,
    ownerId: overrides.ownerId,
    agentId: overrides.agentId,
    sessionKey: overrides.sessionKey ?? sessionKey(overrides.agentId, overrides.conversationId),
    conversationId: overrides.conversationId,
    kind: 'user_message',
    origin: { type: 'user' },
    trusted: true,
    priority: 'user',
    payload: { text: 'hi' },
    at,
    status: 'accepted',
  };
}

function runInput(agentId: string, conversationId: string, ownerId: string): RunInput {
  return {
    agentId,
    conversationId,
    sessionKey: sessionKey(agentId, conversationId),
    wakeEvents: [wakeEvent({ agentId, conversationId, ownerId })],
  };
}

function target(agentId: string, conversationId: string): WakeTarget {
  return { agentId, conversationId, sessionKey: sessionKey(agentId, conversationId) };
}

/** Brain that writes one tool-backed note, then replies — exercising tools, transcript and reply. */
function brainWithOneToolCall(): Brain {
  let step = 0;
  return {
    async buildContext(input) {
      return { sessionKey: input.sessionKey, agentId: input.agentId };
    },
    async step() {
      step += 1;
      if (step === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'call-1', name: 'note', arguments: {} }],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          stopReason: 'tool_calls',
        };
      }
      return {
        text: 'hello from the agent',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        stopReason: 'stop',
      };
    },
    shouldCompact: () => false,
    async compact(ctx) {
      return ctx;
    },
  };
}

const noteTool: Tool = {
  name: 'note',
  description: 'write an audit note',
  parameters: { type: 'object', properties: {} },
  replay: 'safe',
  sideEffect: false,
  async execute(_args, ctx) {
    await ctx.store.put('audit', {
      id: 'aud-' + ctx.runId,
      at,
      actor: 'agent',
      agentId: ctx.agentId,
      action: 'note',
      decision: 'auto_allowed',
      reason: 'test note',
      runId: ctx.runId,
      initiator: { type: 'system', wakeKind: 'test' },
      unattended: true,
    });
    return { content: [{ type: 'text', text: 'noted' }] };
  },
};

const toolRegistry: ToolRegistry = {
  forAgent: async () => [noteTool],
  get: name => (name === 'note' ? noteTool : undefined),
};

function runServices(store: Store): RunServices {
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: brainWithOneToolCall(), toolRegistry };
}

/** Records the wake events handed to the enqueuer, so a test can assert their owner. */
class RecordingEnqueuer implements Enqueuer {
  readonly wakes: WakeEvent[] = [];

  async enqueue(event: WakeEvent): Promise<{ accepted: boolean; reason?: string }> {
    this.wakes.push(event);
    return { accepted: true };
  }

  async stopRun(_runId: string): Promise<void> {}

  async resolveAwakeable(_awakeableId: string, _value: unknown): Promise<void> {}

  async scheduleRoutine(_routineId: string): Promise<void> {}
}

interface RunHarness {
  ctx: RunBodyContext;
  finished: Array<{ sessionKey: string; runId: string }>;
}

function runHarness(runId: string): RunHarness {
  const finished: Array<{ sessionKey: string; runId: string }> = [];
  let counter = 0;
  return {
    finished,
    ctx: {
      key: runId,
      rand: { uuidv4: () => runId + '-' + counter++ },
      run: <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
      awakeable: <T>() => ({ id: runId + '-awake', promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
      drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
      // A neutral fixture: the durable cancel promise stays pending until a stop fires. Resolving it
      // `false` instead would let RestatePromise.race pick the cancel branch and stop every run.
      cancel: { peek: async () => false, get: () => RestatePromise.resolve(new Promise<boolean>(() => {})) },
      runFinished: async (key: string, failedRunId: string) => {
        finished.push({ sessionKey: key, runId: failedRunId });
      },
    },
  };
}

interface SessionHarness {
  io: SessionIo;
  started: Array<{ runId: string; input: RunInput }>;
  state: () => SessionState | null;
  /** Fire every armed idle flush, exactly as Restate does when the durable timer elapses. */
  fireFlushes: () => Promise<void>;
}

function sessionHarness(key: string): SessionHarness {
  let state: SessionState | null = null;
  const started: Array<{ runId: string; input: RunInput }> = [];
  const flushes: Array<{ token: string; delayMs: number }> = [];
  const io: SessionIo = {
    key,
    readState: async () => state,
    writeState: next => {
      state = next;
    },
    now: async () => Date.parse(at),
    newRunId: () => 'run-' + (started.length + 1),
    deliver: () => {},
    scheduleIdleCompact: () => {}, scheduleFlush: (token, delayMs) => {
      flushes.push({ token, delayMs });
    },
    startRun: (runId, input) => {
      started.push({ runId, input });
    },
    cancelRun: () => {},
  };
  return {
    started,
    state: () => state,
    io,
    fireFlushes: async () => {
      const pending = flushes.splice(0);
      for (const { token } of pending) await flushInboxEvent(io, token);
    },
  };
}

describe('resolveWakeOwner', () => {
  it('treats a missing or malformed owner as absent instead of crashing', () => {
    expect(readWakeOwner(undefined)).toBeUndefined();
    expect(readWakeOwner({})).toBeUndefined();
    expect(readWakeOwner({ ownerId: 42 })).toBeUndefined();
    expect(readWakeOwner({ ownerId: '' })).toBeUndefined();
    expect(readWakeOwner({ ownerId: 'owner-a' })).toBe('owner-a');
  });

  it('refuses a raw wire wake that carries no owner field', () => {
    // Parsed JSON is the actual shape a Restate handler receives; a legacy or malformed producer must
    // be refused, not crash the handler on a missing property.
    const malformed: WakeEvent[] = JSON.parse('[{"id":"w1","agentId":"a","conversationId":"c"}]');
    expect(resolveWakeOwner(malformed, target('a', 'c'))).toEqual({ reason: 'missing_owner' });
  });

  it('refuses a batch that mixes owners', () => {
    const events = [
      wakeEvent({ agentId: 'a', conversationId: 'c', ownerId: ownerA, id: 'w1' }),
      wakeEvent({ agentId: 'a', conversationId: 'c', ownerId: ownerB, id: 'w2' }),
    ];
    expect(resolveWakeOwner(events, target('a', 'c'))).toEqual({ reason: 'mixed_owner_wake' });
  });

  it('refuses a wake whose session key does not match its target', () => {
    const event = wakeEvent({ agentId: 'a', conversationId: 'c', ownerId: ownerA, sessionKey: 'someone-else' });
    expect(resolveWakeOwner([event], target('a', 'c'))).toEqual({ reason: 'session_key_mismatch' });
  });

  it('refuses a non-canonical caller session key even when the events look right', () => {
    const event = wakeEvent({ agentId: 'a', conversationId: 'c', ownerId: ownerA });
    const wrongCaller = { ...target('a', 'c'), sessionKey: 'a:somewhere-else' };
    expect(resolveWakeOwner([event], wrongCaller)).toEqual({ reason: 'session_key_mismatch' });
  });

  it('refuses an invalid target instead of building a session key from it', () => {
    const event = wakeEvent({ agentId: 'a', conversationId: 'c', ownerId: ownerA });
    expect(resolveWakeOwner([event], { agentId: '', conversationId: 'c', sessionKey: ':c' })).toEqual({
      reason: 'invalid_target',
    });
  });

  it('accepts a single-owned batch addressing exactly its target', () => {
    const event = wakeEvent({ agentId: 'a', conversationId: 'c', ownerId: ownerA });
    expect(resolveWakeOwner([event], target('a', 'c'))).toEqual({ ownerId: ownerA });
  });
});

describe('resolveAdmittedOwner', () => {
  it('admits the owner recorded on the agent and conversation', async () => {
    const raw = createMemoryStore();
    await seed(raw, ownerA, 'agent-a', 'conv-a');
    const event = wakeEvent({ agentId: 'agent-a', conversationId: 'conv-a', ownerId: ownerA });
    await expect(resolveAdmittedOwner(raw, [event], target('agent-a', 'conv-a'))).resolves.toEqual({
      ownerId: ownerA,
    });
  });

  it('refuses a spoofed owner that does not own the agent', async () => {
    const raw = createMemoryStore();
    await seed(raw, ownerA, 'agent-a', 'conv-a');
    const event = wakeEvent({ agentId: 'agent-a', conversationId: 'conv-a', ownerId: ownerB });
    await expect(resolveAdmittedOwner(raw, [event], target('agent-a', 'conv-a'))).resolves.toEqual({
      reason: 'agent_owner_mismatch',
    });
  });

  it('refuses when the conversation belongs to another owner', async () => {
    const raw = createMemoryStore();
    await seed(raw, ownerA, 'agent-a', 'conv-a');
    await scoped(raw, ownerB).put('conversations', conversationFixture('conv-b', ownerB, 'agent-b'));
    const event = wakeEvent({ agentId: 'agent-a', conversationId: 'conv-b', ownerId: ownerA });
    await expect(resolveAdmittedOwner(raw, [event], target('agent-a', 'conv-b'))).resolves.toEqual({
      reason: 'conversation_owner_mismatch',
    });
  });

  it('refuses when the caller session key is not the canonical target', async () => {
    const raw = createMemoryStore();
    await seed(raw, ownerA, 'agent-a', 'conv-a');
    const event = wakeEvent({ agentId: 'agent-a', conversationId: 'conv-a', ownerId: ownerA });
    const wrongCaller = { ...target('agent-a', 'conv-a'), sessionKey: 'agent-a:conv-b' };
    await expect(resolveAdmittedOwner(raw, [event], wrongCaller)).resolves.toEqual({ reason: 'session_key_mismatch' });
  });
});

describe('session admission', () => {
  it('starts a run only for the wake owner and records it in the owner session', async () => {
    const raw = createMemoryStore();
    await seed(raw, ownerA, 'agent-a', 'conv-a');
    const harness = sessionHarness('agent-a:conv-a');
    const event = wakeEvent({ agentId: 'agent-a', conversationId: 'conv-a', ownerId: ownerA });

    const result = await admitAndRun(raw, event, ownerA, () =>
      receiveEvent(harness.io, runServices(requestScopedStore(raw)), event),
    );

    // The decision names the run the private reply window will start (the SDK correlates its turn by it).
    expect(result).toEqual({ accepted: true, runId: expect.any(String) });
    await harness.fireFlushes(); // the private idle window elapses
    expect(harness.started).toHaveLength(1);
    expect(harness.started[0]?.input.wakeEvents[0]?.ownerId).toBe(ownerA);
    expect(harness.state()?.activeRunId).toBe('run-1');
  });
});

describe('routine and trigger owner paths', () => {
  it('resolves a routine wake owner from the routine stamp, else its agent', async () => {
    const raw = createMemoryStore();
    await seed(raw, ownerA, 'agent-a', 'conv-a');

    const stamped = await scoped(raw, ownerA).put('routines', routineFixture('rtn-a', 'agent-a'));
    expect(await resolveRoutineOwner(raw, stamped)).toBe(ownerA);

    const legacy = await raw.put('routines', routineFixture('rtn-legacy', 'agent-a'));
    expect(await resolveRoutineOwner(raw, legacy)).toBe(ownerA);

    const orphan = await raw.put('routines', routineFixture('rtn-orphan', 'ghost-agent'));
    expect(await resolveRoutineOwner(raw, orphan)).toBeUndefined();
  });

  it('enqueues a matched webhook wake under the subscription owner and skips owner-less ones', async () => {
    const raw = createMemoryStore();
    await seed(raw, ownerA, 'agent-a', 'conv-a');
    await scoped(raw, ownerA).put('subscriptions', subscriptionFixture('sub-a', 'agent-a', 'conv-a'));
    await raw.put('subscriptions', subscriptionFixture('sub-orphan', 'ghost-agent', 'conv-x'));
    const enqueuer = new RecordingEnqueuer();
    const triggers = createTriggersService({ store: requestScopedStore(raw), enqueuer });

    const result = await triggers.deliverExternal({ id: 'evt-1', source: 'github', type: 'pr.merged' });

    expect(result.matched).toBe(1);
    expect(enqueuer.wakes).toHaveLength(1);
    expect(enqueuer.wakes[0]?.ownerId).toBe(ownerA);
    expect(enqueuer.wakes[0]?.agentId).toBe('agent-a');
  });
});

describe('run body owner scope', () => {
  it('writes the run, reply, transcript, tool note and events to the wake owner only', async () => {
    const raw = createMemoryStore();
    await seed(raw, ownerA, 'agent-a', 'conv-a');
    await seed(raw, ownerB, 'agent-b', 'conv-b');
    const facade = requestScopedStore(raw);
    const harness = runHarness('run-a');

    await runWorkflowBody(harness.ctx, runServices(facade), runInput('agent-a', 'conv-a', ownerA));

    const runsA = await scoped(raw, ownerA).list('runs');
    expect(runsA.items).toHaveLength(1);
    expect(runsA.items[0]?.status).toBe('completed');
    expect(docOwner(runsA.items[0])).toBe(ownerA);
    const reply = (await scoped(raw, ownerA).list('items')).items.find(item => item.type === 'agent_message');
    expect(reply).toBeDefined();
    expect((await scoped(raw, ownerA).list('transcripts')).items.length).toBeGreaterThan(0);
    // The tool's own audit row, under the wake owner; a default allow is not a decision, so no tool.policy row (H-57).
    const audit = (await scoped(raw, ownerA).list('audit')).items;
    expect(audit).toHaveLength(1);
    expect(audit.filter(entry => entry.action === 'tool.policy')).toHaveLength(0);
    expect((await scoped(raw, ownerA).list('steps')).items).toHaveLength(1);
    const eventTypes = (await bus(raw, ownerA).since(0)).map(entry => entry.event.type);
    expect(eventTypes).toContain('RUN_STARTED');
    expect(eventTypes).toContain('item.added');
    expect(eventTypes).toContain('RUN_FINISHED');

    // The other owner sees nothing of it — not by id, not in the event log.
    expect((await scoped(raw, ownerB).list('runs')).items).toEqual([]);
    expect((await scoped(raw, ownerB).list('items')).items).toEqual([]);
    expect((await scoped(raw, ownerB).list('transcripts')).items).toEqual([]);
    expect((await scoped(raw, ownerB).list('audit')).items).toEqual([]);
    expect(await bus(raw, ownerB).since(0)).toEqual([]);
    expect(harness.finished).toEqual([{ sessionKey: 'agent-a:conv-a', runId: 'run-a' }]);
  });

  it('refuses a spoofed wake with zero side effects', async () => {
    const raw = createMemoryStore();
    await seed(raw, ownerA, 'agent-a', 'conv-a');
    const facade = requestScopedStore(raw);
    const harness = runHarness('run-spoof');
    const input = runInput('agent-a', 'conv-a', ownerB);

    await expect(runWorkflowBody(harness.ctx, runServices(facade), input)).rejects.toThrow(/agent_owner_mismatch/);

    expect((await scoped(raw, ownerA).list('runs')).items).toEqual([]);
    expect((await scoped(raw, ownerB).list('runs')).items).toEqual([]);
    expect(await bus(raw, ownerA).since(0)).toEqual([]);
    expect(await bus(raw, ownerB).since(0)).toEqual([]);
    expect(harness.finished).toEqual([]);
  });

  it('refuses a run whose own session key is not canonical, with zero side effects', async () => {
    const raw = createMemoryStore();
    await seed(raw, ownerA, 'agent-a', 'conv-a');
    await seed(raw, ownerA, 'agent-a', 'conv-b');
    const facade = requestScopedStore(raw);
    const harness = runHarness('run-foreign-session');
    const input: RunInput = {
      ...runInput('agent-a', 'conv-a', ownerA),
      sessionKey: 'agent-a:conv-b',
    };

    await expect(runWorkflowBody(harness.ctx, runServices(facade), input)).rejects.toThrow(/session_key_mismatch/);

    expect((await scoped(raw, ownerA).list('runs')).items).toEqual([]);
    expect((await scoped(raw, ownerA).list('transcripts')).items).toEqual([]);
    expect(await bus(raw, ownerA).since(0)).toEqual([]);
    expect(harness.finished).toEqual([]);
  });

  it('refuses a mixed-owner wake batch', async () => {
    const raw = createMemoryStore();
    await seed(raw, ownerA, 'agent-a', 'conv-a');
    const harness = runHarness('run-mixed');
    const input: RunInput = {
      agentId: 'agent-a',
      conversationId: 'conv-a',
      sessionKey: 'agent-a:conv-a',
      wakeEvents: [
        wakeEvent({ agentId: 'agent-a', conversationId: 'conv-a', ownerId: ownerA, id: 'w1' }),
        wakeEvent({ agentId: 'agent-a', conversationId: 'conv-a', ownerId: ownerB, id: 'w2' }),
      ],
    };

    await expect(runWorkflowBody(harness.ctx, runServices(requestScopedStore(raw)), input)).rejects.toThrow(/mixed_owner_wake/);
    expect((await scoped(raw, ownerA).list('runs')).items).toEqual([]);
    expect(await bus(raw, ownerA).since(0)).toEqual([]);
    expect(harness.finished).toEqual([]);
  });

  it('keeps concurrent owner runs on their own scopes', async () => {
    const raw = createMemoryStore();
    await seed(raw, ownerA, 'agent-a', 'conv-a');
    await seed(raw, ownerB, 'agent-b', 'conv-b');
    const facade = requestScopedStore(raw);

    await Promise.all([
      runWorkflowBody(runHarness('run-a').ctx, runServices(facade), runInput('agent-a', 'conv-a', ownerA)),
      runWorkflowBody(runHarness('run-b').ctx, runServices(facade), runInput('agent-b', 'conv-b', ownerB)),
    ]);

    const runsA = (await scoped(raw, ownerA).list('runs')).items;
    const runsB = (await scoped(raw, ownerB).list('runs')).items;
    expect(runsA).toHaveLength(1);
    expect(runsB).toHaveLength(1);
    expect(docOwner(runsA[0])).toBe(ownerA);
    expect(docOwner(runsB[0])).toBe(ownerB);
    expect(runsA[0]?.agentId).toBe('agent-a');
    expect(runsB[0]?.agentId).toBe('agent-b');
    expect((await bus(raw, ownerA).since(0)).filter(entry => entry.event.type === 'RUN_STARTED')).toHaveLength(1);
    expect((await bus(raw, ownerB).since(0)).filter(entry => entry.event.type === 'RUN_STARTED')).toHaveLength(1);
  });
});

/** Mirror the Session handler's admission: validate, then run the body inside the admitted scope. */
async function admitAndRun<T>(raw: MemoryStore, event: WakeEvent, ownerId: string, body: () => Promise<T>): Promise<T> {
  const admitted = await resolveAdmittedOwner(raw, [event], target(event.agentId, event.conversationId));
  expect(admitted.ownerId).toBe(ownerId);
  return runWithOwner(ownerId, body);
}

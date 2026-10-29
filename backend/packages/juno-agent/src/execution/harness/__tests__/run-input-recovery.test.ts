/**
 * QR1 race guard: the user can answer between request.created and the run installing its awakeable id
 * on the request. The HTTP route then has no awakeable to resolve, so it persists the decision and leaves
 * delivery to the run; awaitUser must resume from that saved decision instead of hanging forever.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { AssistantTurn, Brain, BrainContext, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import type { StoredRequest } from '../../../contracts/requests.js';
import type { Run } from '@agent-desktop/public-contracts';
import { createRunCancellation, NEVER_CANCELLED } from '../services/cancel.js';
import { awaitUser, INTERRUPTED_BY_MESSAGE } from '../services/run-input.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

type DecidedRequest = StoredRequest;

const at = '2026-10-06T00:00:00.000Z';
const sessionKey = 'agent-1:conv-1';

const input: RunInput = {
  agentId: 'agent-1',
  conversationId: 'conv-1',
  sessionKey,
  wakeEvents: [],
};

function brain(): Brain {
  return {
    async buildContext(): Promise<BrainContext> {
      return { sessionKey, agentId: 'agent-1' };
    },
    async step(): Promise<AssistantTurn> {
      throw new Error('the recovery path never calls the model');
    },
    shouldCompact(): boolean {
      return false;
    },
    async compact(ctx: BrainContext): Promise<BrainContext> {
      return ctx;
    },
  };
}

function registry(): ToolRegistry {
  return {
    async forAgent() {
      return [];
    },
    get: () => undefined,
  };
}

/** The awakeable never resolves: only the saved decision can resume the run in these tests. */
function runContext(): RunContext {
  return {
    rand: { uuidv4: () => 'id-1' },
    run: <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
    awakeable: <T>(): { id: string; promise: RestatePromise<T> } => ({
      id: 'awake-1',
      promise: RestatePromise.resolve(new Promise<T>(() => {})),
    }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

function run(): Run {
  return {
    id: 'run-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    title: 'test',
    status: 'running',
    kind: 'chat',
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: at,
    lastActivityAt: at,
  };
}

function question(id: string, extra: Partial<DecidedRequest>): DecidedRequest {
  return {
    id,
    kind: 'question',
    status: 'pending',
    title: 'Question',
    summary: 'Origin?',
    agentId: 'agent-1',
    runId: 'run-1',
    conversationId: 'conv-1',
    createdAt: at,
    payload: { kind: 'question', ui: { version: 1, blocks: [{ type: 'fields', id: 'form', fields: [{ id: 'origin', label: 'Origin?', kind: 'text' }] }] } },
    ...extra,
  };
}

function approval(id: string): DecidedRequest {
  return {
    id,
    kind: 'approval',
    status: 'pending',
    title: 'Send the summary',
    summary: 'Send it to the team',
    agentId: 'agent-1',
    runId: 'run-1',
    conversationId: 'conv-1',
    createdAt: at,
    payload: { kind: 'approval', action: 'Send the summary', why: 'the user asked' },
  };
}

async function setup(request: DecidedRequest): Promise<{ store: ReturnType<typeof createMemoryStore>; services: RunServices }> {
  const store = createMemoryStore();
  await store.put('runs', run(), { conversationId: 'conv-1' });
  await store.put('requests', request);
  return { store, services: { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: brain(), toolRegistry: registry() } };
}

async function transcript(store: ReturnType<typeof createMemoryStore>): Promise<string> {
  const page = await store.list('transcripts', { limit: 50 });
  return JSON.stringify(page.items.map((entry) => entry.message.content));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('awaitUser race recovery', () => {
  it('closes the wire segment with a standard interrupt and opens the resumed segment', async () => {
    const { store, services } = await setup(approval('req_stp-1'));
    const baseContext = runContext();
    const context: RunContext = {
      ...baseContext,
      awakeable: <T>(): { id: string; promise: RestatePromise<T> } => ({
        id: 'awake-approval',
        promise: RestatePromise.resolve({ action: 'approve', scope: 'once' } as T),
      }),
    };
    await awaitUser(context, services, input, 'run-1', 3, { reason: 'user', awakeableId: 'req_stp-1' }, NEVER_CANCELLED, { appendAnswer: false });
    const events = (await store.eventBus.since(0, 200)).map((row) => row.event);
    const interruptIndex = events.findIndex((event) => event.type === 'RUN_FINISHED');
    const interrupt = events[interruptIndex];
    expect(interrupt?.type).toBe('RUN_FINISHED');
    if (interrupt?.type !== 'RUN_FINISHED') throw new Error('interrupt missing');
    expect(interrupt.outcome).toMatchObject({
      type: 'interrupt',
      interrupts: [{ id: 'req_stp-1', reason: 'approval', toolCallId: 'stp-1', metadata: { juno: { requestId: 'req_stp-1', conversationId: 'conv-1' } } }],
    });
    const resumedIndex = events.findIndex((event) => event.type === 'RUN_STARTED');
    expect(resumedIndex).toBeGreaterThan(interruptIndex);
    const resumed = events[resumedIndex];
    expect(resumed).toMatchObject({ type: 'RUN_STARTED', runId: 'run-1', threadId: 'conv-1' });
    await expect(store.get('runs', 'run-1')).resolves.toMatchObject({ status: 'running' });
  });

  it('resumes from the saved answer when the decision landed before the awakeable id', async () => {
    const { store, services } = await setup(
      question('req-1', { status: 'answered', resolution: { action: 'answer', answers: { origin: 'Singapore' } } }),
    );

    const outcome = await awaitUser(runContext(), services, input, 'run-1', 0, { awakeableId: 'req-1' }, NEVER_CANCELLED);

    expect(outcome).toBe('resolved');
    expect((await store.get('runs', 'run-1'))?.status).toBe('running');
    expect(await transcript(store)).toContain('Singapore');
  });

  it('resumes a declined question with the deny decision', async () => {
    const { store, services } = await setup(question('req-2', { status: 'denied' }));

    const outcome = await awaitUser(runContext(), services, input, 'run-1', 0, { awakeableId: 'req-2' }, NEVER_CANCELLED);

    expect(outcome).toBe('resolved');
    expect(await transcript(store)).toContain('deny');
  });

  it('keeps waiting on the awakeable while the request is still pending', async () => {
    const { store, services } = await setup(question('req-4', {}));

    const raced = await Promise.race([
      awaitUser(runContext(), services, input, 'run-1', 0, { awakeableId: 'req-4' }, NEVER_CANCELLED).then(() => 'returned'),
      sleep(30).then(() => 'waiting'),
    ]);

    expect(raced).toBe('waiting');
    expect((await store.get('runs', 'run-1'))?.status).toBe('waiting_for_input');
    expect(await transcript(store)).toBe('[]');
  });

  it('ends the wait as interrupted when a message resolves the awakeable, leaving the request pending', async () => {
    const { store, services } = await setup(question('req-5', { kind: 'approval' }));
    const ctx: RunContext = { ...runContext(), awakeable: <T>() => ({ id: 'awake-5', promise: RestatePromise.resolve(INTERRUPTED_BY_MESSAGE as T) }) };

    const outcome = await awaitUser(ctx, services, input, 'run-1', 0, { awakeableId: 'req-5' }, NEVER_CANCELLED);

    expect(outcome).toBe('interrupted_by_message');
    const request = await store.get('requests', 'req-5');
    expect(request?.status).toBe('pending');
    expect(Reflect.get(request ?? {}, 'interrupted')).toBe(true);
    expect((await store.get('runs', 'run-1'))?.status).toBe('running');
  });

  it('ends the wait at once when the message came before the awakeable existed (the awakeable is never resolved)', async () => {
    // The Session found the request without an awakeable, so it could only flag it (session.ts interruptWait).
    const { store, services } = await setup(question('req-6', { kind: 'approval', interruptRequested: true }));

    const outcome = await awaitUser(runContext(), services, input, 'run-1', 0, { awakeableId: 'req-6' }, NEVER_CANCELLED);

    expect(outcome).toBe('interrupted_by_message');
    const request = await store.get('requests', 'req-6');
    expect(request?.status).toBe('pending');
    expect(Reflect.get(request ?? {}, 'interrupted')).toBe(true);
    expect(Reflect.get(request ?? {}, 'interruptRequested')).toBe(false);
    expect((await store.get('runs', 'run-1'))?.status).toBe('running');
  });

  it('ends a reconciliation wait on stop without changing unknown into a decision', async () => {
    const pending = question('req-recovery-stop', {
      reconciliation: { stepId: 'step-old', tool: 'send_message', fingerprint: 'a'.repeat(64), reason: 'missing result', state: 'pending' },
    });
    const { store, services } = await setup(pending);
    const cancellation = createRunCancellation({
      peek: async () => false,
      get: () => RestatePromise.resolve(true),
    });

    const outcome = await awaitUser(runContext(), services, input, 'run-1', 0, { awakeableId: pending.id }, cancellation, { appendAnswer: false });

    expect(outcome).toBe('cancelled');
    expect((await store.get('requests', pending.id))).toMatchObject({
      status: 'pending', interrupted: true, awakeableId: '', reconciliation: { state: 'pending' },
    });
    expect(await transcript(store)).toBe('[]');
  });
});

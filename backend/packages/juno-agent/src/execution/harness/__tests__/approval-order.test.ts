/**
 * Approval resume must not insert a user turn between the persisted assistant tool call and
 * its finalized result: the provider rejects a toolResult that no longer directly follows
 * its assistant turn (live HTTP400 in .data/ph-approval-live.log). Approval is runtime
 * control, so the saved-resolution resume restores the run without journaling; question
 * answers still append a user turn.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { AssistantTurn, Brain, BrainContext, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import type { StoredRequest } from '../../../contracts/requests.js';
import type { Run } from '@agent-desktop/public-contracts';
import { appendToTranscript, assistantMessage, toolMessage } from '../../brain/index.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { awaitUser } from '../services/run-input.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

type DecidedRequest = StoredRequest;

const at = '2026-10-06T00:00:00.000Z';
const sessionKey = 'agent-1:conv-1';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

const input: RunInput = { agentId: 'agent-1', conversationId: 'conv-1', sessionKey, wakeEvents: [] };

const callTurn: AssistantTurn = {
  text: '',
  toolCalls: [{ id: 'c1', name: 'effect', arguments: {} }],
  usage,
  stopReason: 'tool_calls',
};

function brain(): Brain {
  return {
    async buildContext(): Promise<BrainContext> {
      return { sessionKey, agentId: 'agent-1' };
    },
    async step(): Promise<AssistantTurn> {
      throw new Error('the approval-order path never calls the model');
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

function approval(id: string, extra: Partial<DecidedRequest>): DecidedRequest {
  return {
    id,
    kind: 'approval',
    status: 'pending',
    title: 'Approval needed',
    summary: 'Run effect?',
    agentId: 'agent-1',
    runId: 'run-1',
    conversationId: 'conv-1',
    createdAt: at,
    payload: { kind: 'approval', action: 'effect', target: '{}', why: 'policy asks' },
    ...extra,
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

async function setup(request: DecidedRequest): Promise<{ store: ReturnType<typeof createMemoryStore>; services: RunServices }> {
  const store = createMemoryStore();
  await store.put('runs', run(), { conversationId: 'conv-1' });
  await store.put('requests', request);
  return { store, services: { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: brain(), toolRegistry: registry() } };
}

interface TranscriptRow {
  seq: number;
  role: string;
  content: unknown;
}

function toRow(value: { seq: number; message: Record<string, unknown> }): TranscriptRow | null {
  const role = value.message['role'];
  if (typeof role !== 'string') return null;
  if (!('content' in value.message)) return null;
  return { seq: value.seq, role, content: value.message['content'] };
}

async function orderedRows(store: ReturnType<typeof createMemoryStore>): Promise<TranscriptRow[]> {
  const page = await store.list('transcripts', { limit: 50 });
  const rows: TranscriptRow[] = [];
  for (const item of page.items) {
    const row = toRow(item);
    if (row !== null) rows.push(row);
  }
  return rows.sort((a, b) => a.seq - b.seq);
}

async function roles(store: ReturnType<typeof createMemoryStore>): Promise<string[]> {
  return (await orderedRows(store)).map((entry) => entry.role);
}

async function contents(store: ReturnType<typeof createMemoryStore>): Promise<string> {
  return JSON.stringify((await orderedRows(store)).map((entry) => entry.content));
}

describe('approval resume order', () => {
  it('keeps the assistant tool call and its result adjacent on a saved approval', async () => {
    const { store, services } = await setup(
      approval('req-1', { status: 'approved', resolution: { action: 'approve' } }),
    );
    await appendToTranscript(store, sessionKey, [assistantMessage(callTurn)]);
    const outcome = await awaitUser(runContext(), services, input, 'run-1', 0, { awakeableId: 'req-1' }, NEVER_CANCELLED, { appendAnswer: false });
    expect(outcome).toBe('resolved');
    expect((await store.get('runs', 'run-1'))?.status).toBe('running');
    await appendToTranscript(store, sessionKey, [toolMessage('effect', 'c1', { content: [{ type: 'text', text: 'done' }] })]);
    expect(await roles(store)).toEqual(['assistant', 'toolResult']);
  });
  it('resumes a denied approval without journaling a user turn', async () => {
    const { store, services } = await setup(
      approval('req-2', { status: 'denied', resolution: { action: 'deny' } }),
    );
    await appendToTranscript(store, sessionKey, [assistantMessage(callTurn)]);
    const outcome = await awaitUser(runContext(), services, input, 'run-1', 0, { awakeableId: 'req-2' }, NEVER_CANCELLED, { appendAnswer: false });
    expect(outcome).toBe('resolved');
    expect((await store.get('runs', 'run-1'))?.status).toBe('running');
    await appendToTranscript(store, sessionKey, [toolMessage('effect', 'c1', { content: [{ type: 'text', text: 'refused' }], isError: true })]);
    expect(await roles(store)).toEqual(['assistant', 'toolResult']);
  });
  it('still appends the saved answer for a question', async () => {
    const { store, services } = await setup(
      question('req-3', { status: 'answered', resolution: { action: 'answer', answers: { origin: 'Singapore' } } }),
    );
    const outcome = await awaitUser(runContext(), services, input, 'run-1', 0, { awakeableId: 'req-3' }, NEVER_CANCELLED);
    expect(outcome).toBe('resolved');
    expect((await store.get('runs', 'run-1'))?.status).toBe('running');
    expect(await roles(store)).toEqual(['user']);
    expect(await contents(store)).toContain('Singapore');
  });
});

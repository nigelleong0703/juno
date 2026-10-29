import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, it, expect } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type {
  AssistantTurn, Brain, BrainContext, Store, Tool, ToolRegistry, WakeEvent,
} from '../../../contracts/index.js';
import type { Agent, Run } from '@agent-desktop/public-contracts';
import { createSendMessageTool } from '../../../modules/tools/tools/sendMessage.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { runLoop } from '../services/run-loop.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

const at = '2026-10-06T00:00:00.000Z';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

class ScriptedTurns implements Brain {
  private index = 0;
  constructor(private readonly turns: AssistantTurn[]) {}
  async buildContext(): Promise<BrainContext> {
    return { sessionKey: 'agent-1:conv-1', agentId: 'agent-1' };
  }
  async step(): Promise<AssistantTurn> {
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)];
    this.index += 1;
    if (!turn) throw new Error('no scripted turn');
    return turn;
  }
  shouldCompact(): boolean {
    return false;
  }
  async compact(ctx: BrainContext): Promise<BrainContext> {
    return ctx;
  }
}

function sendText(id: string, text: string): AssistantTurn {
  return { text: '', toolCalls: [{ id, name: 'send_message', arguments: { kind: 'text', text } }], usage, stopReason: 'tool_calls' };
}

function sendToRoom(id: string, text: string, conversationId: string): AssistantTurn {
  return { text: '', toolCalls: [{ id, name: 'send_message', arguments: { kind: 'text', text, conversationId } }], usage, stopReason: 'tool_calls' };
}

function callStub(id: string): AssistantTurn {
  return { text: '', toolCalls: [{ id, name: 'peer_note', arguments: {} }], usage, stopReason: 'tool_calls' };
}

function final(text: string): AssistantTurn {
  return { text, toolCalls: [], usage, stopReason: 'stop' };
}

const wake: WakeEvent = {
  id: 'wake-1', ownerId: 'owner', agentId: 'agent-1', sessionKey: 'agent-1:conv-1', conversationId: 'conv-1',
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'hi' }, at,
  status: 'accepted',
};

const input: RunInput = { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: [wake] };

function runContext(): RunContext {
  let ids = 0;
  return {
    rand: { uuidv4: () => 'id' + String(ids++) },
    run: <T>(_name: string, action: () => Promise<T>): RestatePromise<T> => RestatePromise.resolve(action()),
    awakeable: <T>(): { id: string; promise: RestatePromise<T> } => ({
      id: 'awake',
      promise: RestatePromise.resolve(new Promise<T>(() => {})),
    }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

function peerNoteTool(): Tool {
  return {
    name: 'peer_note',
    description: 'stub recording a delivery to another conversation',
    parameters: { type: 'object', properties: {} },
    replay: 'never',
    sideEffect: true,
    async execute() {
      return {
        content: [{ type: 'text', text: 'noted' }],
        details: { deliveredText: 'Peer-only note', deliveredConversationId: 'peer-conv' },
      };
    },
  };
}

function registryWith(store: Store, extra: Tool[]): ToolRegistry {
  const tools = [createSendMessageTool({ store, enqueuer: new NoopEnqueuer() }), ...extra];
  return {
    async forAgent() {
      return tools;
    },
    get: (name) => tools.find((tool) => tool.name === name),
  };
}

/** Seed a second room that the run's agent belongs to, so an explicit room target validates. */
async function seedSecondRoom(store: Store): Promise<void> {
  const agentOne: Agent & { ownerId?: string } = {
    id: 'agent-1', name: 'Agent One', handle: 'agent-1',
    avatar: { shape: 'circle', color: 1, eyes: 'happy' },
    title: 'Role', status: 'idle', section: 'Agents', pinned: false,
    lastActivity: 'idle', unreadCount: 0,
    model: {
      planner: { provider: 'anthropic', model: 'claude-opus' },
      computer: { provider: 'anthropic', model: 'claude-opus' },
      fast: { provider: 'anthropic', model: 'claude-haiku' },
    },
    channels: [], macAccess: false, skillIds: [], pluginIds: [],
    sharing: { publishedToTeam: false }, createdBy: 'owner', ownerId: 'owner',
    createdAt: at, updatedAt: at,
  };
  await store.put('agents', agentOne);
  await store.put('conversations', {
    id: 'room-2', kind: 'room', title: 'Room',
    agentIds: ['agent-1'], memberIds: ['owner'], unreadCount: 0, lastItemAt: at, createdAt: at,
  });
}

async function runScripted(turns: AssistantTurn[], extra: Tool[], seed?: (store: Store) => Promise<void>): Promise<string[]> {
  const store = createMemoryStore();
  if (seed) await seed(store);
  const runDoc: Run = {
    id: 'run-1', agentId: 'agent-1', conversationId: 'conv-1', title: 'test', status: 'running', kind: 'chat',
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: at, lastActivityAt: at,
  };
  await store.put('runs', runDoc, { conversationId: runDoc.conversationId });
  const services: RunServices = {
    store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedTurns(turns), toolRegistry: registryWith(store, extra),
  };
  const outcome = await runLoop(
    runContext(), services, input, 'run-1',
    { sessionKey: input.sessionKey, agentId: input.agentId }, NEVER_CANCELLED,
  );
  expect(outcome).toBe('completed');
  const items = await store.list('items', { orderBy: 'at', order: 'asc', limit: 50 });
  return items.items.map((item) => (item.type === 'agent_message' ? item.markdown : ''));
}

describe('gc2 run delivery terminal', () => {
  it('completes after delivery and still posts the meaningful final', async () => {
    const messages = await runScripted([sendText('c1', 'Result is ready.'), final('Done, result delivered.')], []);
    expect(messages).toEqual(['Result is ready.', 'Done, result delivered.']);
  });

  it('keeps looping after delivery so later bubbles and the final still post', async () => {
    const messages = await runScripted(
      [sendText('c1', 'First finding.'), sendText('c2', 'Second finding.'), final('Summary report.')],
      [],
    );
    expect(messages).toEqual(['First finding.', 'Second finding.', 'Summary report.']);
  });

  it('a delivery to another conversation never suppresses this final', async () => {
    const messages = await runScripted([callStub('c1'), final('Current answer.')], [peerNoteTool()]);
    expect(messages).toEqual(['Current answer.']);
  });

  it('an explicit room delivery off the current conversation never hides the current final', async () => {
    const messages = await runScripted([sendToRoom('c1', 'Room note.', 'room-2'), final('Current answer.')], [], seedSecondRoom);
    expect(messages).toEqual(['Room note.', 'Current answer.']);
  });
});

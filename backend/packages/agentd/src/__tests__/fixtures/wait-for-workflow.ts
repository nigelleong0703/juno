import { createMemoryBlobStore } from '@agent-desktop/db';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore } from '@agent-desktop/db';
import type { WakeEvent } from '@agent-desktop/contracts';
import type { Agent, Conversation } from '@agent-desktop/public-contracts';
import type {
  AssistantTurn,
  Brain,
  BrainContext,
  Collection,
  Doc,
  IndexedFields,
  ListPage,
  ListQuery,
  Store,
  Tool,
  ToolRegistry,
} from 'juno-agent/contracts';
import type { AgentEvent } from '@agent-desktop/public-contracts';
import { requestScopedStore } from 'juno-agent/owner-context';
import { createTriggersService } from 'juno-agent/execution/harness/services/triggers';
import type { RunBodyContext } from 'juno-agent/execution/harness/services/run';
import type { RunInput, RunServices } from 'juno-agent/execution/harness/services/run-types';
import { createWaitForTool } from 'juno-agent/modules/tools/tools/waitFor';
import { getConfig } from '../../config.js';

export const OWNER = getConfig().OWNER_ID;
export const AGENT = 'agent-wait-workflow';
export const CONV = 'conv-wait-workflow';
export const AT = '2026-10-08T00:00:00.000Z';
export const FILTER = { source: 'github', type: 'pr.merged' };
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

export type RawStore = ReturnType<typeof createMemoryStore>;

/** Owner-scoped view; throws when the store has no owner boundary instead of touching foreign rows. */
export function scoped(raw: RawStore): Store {
  const owned = raw.forOwner;
  if (owned === undefined) throw new Error('Store.forOwner is required: refusing unscoped account access');
  return owned(OWNER);
}

/**
 * Trusted replay seam. Entries enter only through run()'s write path below with the same T the
 * reader requests (the same contract Restate's own ctx.run carries), so a present entry — including
 * a stored undefined from a void step such as persist-wake — always holds the requested type. The
 * single predicate keeps that conversion in one named, reviewable place instead of scattering
 * assertions.
 */
function isJournaled<T>(value: unknown): value is T {
  return true;
}

export function makeAgent(): Agent & { ownerId: string } {
  return {
    id: AGENT,
    name: 'Wait agent',
    handle: AGENT,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'T',
    status: 'idle',
    section: 'Inbox',
    pinned: false,
    lastActivity: 'now',
    unreadCount: 0,
    model: {
      planner: { provider: 'openai', model: 'gpt-4' },
      computer: { provider: 'openai', model: 'gpt-4-vision' },
      fast: { provider: 'openai', model: 'gpt-3.5-turbo' },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: AT,
    updatedAt: AT,
    ownerId: OWNER,
  };
}

export function makeConversation(): Conversation & { ownerId: string } {
  return {
    id: CONV,
    kind: 'direct',
    agentIds: [AGENT],
    memberIds: [OWNER],
    unreadCount: 0,
    lastItemAt: AT,
    createdAt: AT,
    ownerId: OWNER,
  };
}

export function makeWake(overrides: Partial<WakeEvent> = {}): WakeEvent {
  return {
    id: 'wake-1',
    ownerId: OWNER,
    agentId: AGENT,
    sessionKey: AGENT + ':' + CONV,
    conversationId: CONV,
    kind: 'user_message',
    origin: { type: 'user' },
    trusted: true,
    priority: 'user',
    payload: { text: 'watch the repo' },
    at: AT,
    status: 'accepted',
    ...overrides,
  };
}

export function waitTurn(timeout: string): AssistantTurn {
  return {
    text: '',
    toolCalls: [{ id: 'c1', name: 'wait_for', arguments: { filter: FILTER, timeout } }],
    usage,
    stopReason: 'tool_calls',
  };
}

export function finalTurn(text: string): AssistantTurn {
  return { text, toolCalls: [], usage, stopReason: 'stop' };
}

export function scriptedBrain(turns: AssistantTurn[]): Brain & { calls(): number } {
  let index = 0;
  return {
    calls: () => index,
    async buildContext(): Promise<BrainContext> {
      return { sessionKey: AGENT + ':' + CONV, agentId: AGENT };
    },
    async step(): Promise<AssistantTurn> {
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if (turn === undefined) throw new Error('no scripted turn');
      return turn;
    },
    shouldCompact: () => false,
    async compact(ctx: BrainContext): Promise<BrainContext> {
      return ctx;
    },
  };
}

export const forbiddenBrain: Brain = {
  async buildContext(): Promise<BrainContext> {
    return { sessionKey: AGENT + ':' + CONV, agentId: AGENT };
  },
  async step(): Promise<AssistantTurn> {
    throw new Error('the provider must not be called on replay');
  },
  shouldCompact: () => false,
  async compact(ctx: BrainContext): Promise<BrainContext> {
    return ctx;
  },
};

function hookable(base: Store, onSubscriptionPut: (() => Promise<void>) | undefined): Store {
  const wrap = (inner: Store): Store => ({
    forOwner: (next: string) => wrap(inner.forOwner === undefined ? inner : inner.forOwner(next)),
    tx: <T>(fn: (store: Store) => Promise<T>): Promise<T> => inner.tx((s) => fn(wrap(s))),
    get: <C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> => inner.get(collection, id),
    getForUpdate: <C extends Collection>(collection: C, id: string): Promise<Doc<C> | null> => {
      if (typeof inner.getForUpdate !== 'function') {
        throw new Error('Store.getForUpdate is required: refusing unlocked row access');
      }
      return inner.getForUpdate(collection, id);
    },
    list: <C extends Collection>(collection: C, query?: ListQuery): Promise<ListPage<Doc<C>>> => inner.list(collection, query),
    put: async <C extends Collection>(collection: C, doc: Doc<C>, index?: IndexedFields): Promise<Doc<C>> => {
      const stored = await inner.put(collection, doc, index);
      if (collection === 'subscriptions' && onSubscriptionPut !== undefined) await onSubscriptionPut();
      return stored;
    },
    patch: <C extends Collection>(collection: C, id: string, patch: Partial<Doc<C>>): Promise<Doc<C>> =>
      inner.patch(collection, id, patch),
    delete: (collection: Collection, id: string): Promise<void> => inner.delete(collection, id),
    emit: (event: AgentEvent): Promise<void> => inner.emit(event),
  });
  return wrap(base);
}

export interface WorkflowHarness {
  raw: RawStore;
  store: Store;
  input: RunInput;
  enqueues: WakeEvent[];
  sleeps: number[];
  runFinished: string[];
  journal: Map<string, unknown>;
  onSleep: (fn: () => Promise<void>) => void;
  pushInbox: (wake: WakeEvent) => void;
  abort: () => void;
  armSubscriptionPut: (fn: () => Promise<void>) => void;
  services: (brain: Brain, onToolExecute?: () => void) => RunServices;
  bodyCtx: (runId: string) => RunBodyContext;
  deliver: (event: Record<string, unknown>) => Promise<{ matched: number; attempted: number }>;
  replies: () => Promise<string[]>;
  transcriptJson: () => Promise<string>;
  subscriptionCount: () => Promise<number>;
  requestCount: () => Promise<number>;
}

export function createWorkflowHarness(): WorkflowHarness {
  const raw = createMemoryStore();
  const facade = requestScopedStore(raw);
  const enqueues: WakeEvent[] = [];
  const sleeps: number[] = [];
  const runFinished: string[] = [];
  const journal = new Map<string, unknown>();
  const inbox: WakeEvent[] = [];
  let nowMs = Date.now();
  let sleepHook: () => Promise<void> = async () => {};
  let putHook: (() => Promise<void>) | undefined;
  let cancelled = false;
  let resolveCancel: (value: boolean) => void = () => {};
  const cancelFired = new Promise<boolean>((resolve) => {
    resolveCancel = resolve;
  });
  const store = hookable(facade, async () => {
    if (putHook !== undefined) await putHook();
  });
  const enqueuer = {
    enqueue: async (wake: WakeEvent) => {
      enqueues.push(wake);
      return { accepted: true };
    },
    stopRun: async () => {},
    resolveAwakeable: async () => {},
    scheduleRoutine: async () => {},
  };
  const deliver = (event: Record<string, unknown>) => {
    const external = {
      id: typeof event['id'] === 'string' ? event['id'] : 'event-1',
      source: typeof event['source'] === 'string' ? event['source'] : 'github',
      type: typeof event['type'] === 'string' ? event['type'] : 'pr.merged',
      ...event,
    };
    return createTriggersService({ store, enqueuer }).deliverExternal(external);
  };
  return {
    raw,
    store,
    input: { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [makeWake()] },
    enqueues,
    sleeps,
    runFinished,
    journal,
    onSleep: (fn: () => Promise<void>) => {
      sleepHook = fn;
    },
    pushInbox: (wake: WakeEvent) => {
      inbox.push(wake);
    },
    abort: () => {
      cancelled = true;
      resolveCancel(true);
    },
    armSubscriptionPut: (fn: () => Promise<void>) => {
      putHook = fn;
    },
    services: (brain: Brain, onToolExecute?: () => void) => {
      const waitFor = createWaitForTool({ store, enqueuer });
      const tools: Tool[] = onToolExecute === undefined ? [waitFor] : [{
        ...waitFor,
        execute: async (args: unknown, ctx) => {
          onToolExecute();
          return waitFor.execute(args, ctx);
        },
      }];
      const toolRegistry: ToolRegistry = {
        forAgent: async () => tools,
        get: (name: string) => tools.find((tool) => tool.name === name),
      };
      return { store, blobs: createMemoryBlobStore(), enqueuer, brain, toolRegistry };
    },
    bodyCtx: (runId: string) => {
      const used = new Set<string>();
      let counter = 0;
      return {
        key: runId,
        rand: { uuidv4: () => runId + '-' + String((counter += 1)) },
        run: <T>(name: string, action: () => Promise<T>): RestatePromise<T> => {
          if (used.has(name)) throw new Error('duplicate durable step: ' + name);
          used.add(name);
          if (journal.has(name)) {
            const cached: unknown = journal.get(name);
            if (!isJournaled<T>(cached)) throw new Error('journal lost entry: ' + name);
            return RestatePromise.resolve(structuredClone(cached));
          }
          return RestatePromise.resolve(action().then((value) => {
            journal.set(name, structuredClone(value));
            return value;
          }));
        },
        awakeable: <T>(): { id: string; promise: RestatePromise<T> } => {
          throw new Error('Event wait must not create a human request');
        },
        drainInbox: () => RestatePromise.resolve<WakeEvent[]>(inbox.splice(0, inbox.length)),
        date: { now: () => RestatePromise.resolve(nowMs) },
        sleep: (ms: number) => {
          sleeps.push(ms);
          nowMs += ms;
          return RestatePromise.resolve(sleepHook());
        },
        cancel: {
          peek: async () => cancelled,
          get: () => RestatePromise.resolve(cancelFired),
        },
        runFinished: async (sessionKey: string, runIdFinished: string) => {
          runFinished.push(sessionKey + ':' + runIdFinished);
        },
      };
    },
    deliver,
    replies: async () => {
      const items = (await scoped(raw).list('items', { limit: 200 })).items;
      const out: string[] = [];
      for (const item of items) if (item.type === 'agent_message') out.push(item.markdown);
      return out;
    },
    transcriptJson: async () => {
      const items = (await scoped(raw).list('transcripts', { limit: 300 })).items;
      return JSON.stringify(items.map((entry) => entry.message));
    },
    subscriptionCount: async () => (await scoped(raw).list('subscriptions', { limit: 50 })).items.length,
    requestCount: async () => (await scoped(raw).list('requests', { limit: 50 })).items.length,
  };
}

export async function seedWorld(raw: RawStore): Promise<void> {
  const owned = scoped(raw);
  await owned.put('agents', makeAgent());
  await owned.put('conversations', makeConversation());
}

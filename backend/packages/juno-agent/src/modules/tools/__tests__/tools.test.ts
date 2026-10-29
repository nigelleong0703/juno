import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { createToolRegistry } from '../index.js';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store, Enqueuer, WakeEvent, ToolContext } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import type { Agent } from '@agent-desktop/public-contracts';

class RecordingEnqueuer implements Enqueuer {
  calls: Array<{ method: string; event?: WakeEvent }> = [];

  async enqueue(event: WakeEvent) {
    this.calls.push({ method: 'enqueue', event });
    return { accepted: true };
  }

  async stopRun() {
    this.calls.push({ method: 'stopRun' });
  }

  async resolveAwakeable() {
    this.calls.push({ method: 'resolveAwakeable' });
  }

  async scheduleRoutine() {
    this.calls.push({ method: 'scheduleRoutine' });
  }
}


const LEGACY_NOW = '2026-10-06T00:00:00.000Z';

function legacyAgent(id: string): Agent & { ownerId?: string } {
  return {
    id,
    name: 'Legacy ' + id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'happy' },
    title: 'Legacy role',
    status: 'idle',
    section: 'Agents',
    pinned: false,
    lastActivity: 'idle',
    unreadCount: 0,
    model: {
      planner: { provider: 'anthropic', model: 'claude-opus' },
      computer: { provider: 'anthropic', model: 'claude-opus' },
      fast: { provider: 'anthropic', model: 'claude-haiku' },
    },
    channels: [{ kind: 'chat', status: 'connected' }],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdBy: 'user-1',
    ownerId: 'user-1',
    createdAt: LEGACY_NOW,
    updatedAt: LEGACY_NOW,
  };
}

async function seedLegacyGraph(store: Store) {
  await store.put('agents', legacyAgent('agent-1'));
  await store.put('agents', legacyAgent('agent-2'));
  await store.put('conversations', {
    id: 'room-1',
    kind: 'room',
    title: 'Legacy room',
    agentIds: ['agent-1', 'agent-2'],
    memberIds: ['user-1'],
      unreadCount: 0,
      lastItemAt: LEGACY_NOW,
      createdAt: LEGACY_NOW,
    });
  // The context's own conversation must exist so message_agent can tell a direct thread
  // (refused) from a room (allowed).
  await store.put('conversations', {
    id: 'conv-1',
    kind: 'direct',
    title: 'Legacy chat',
    agentIds: ['agent-1'],
    memberIds: ['user-1'],
    unreadCount: 0,
    lastItemAt: LEGACY_NOW,
    createdAt: LEGACY_NOW,
  });
}

function createMockToolContext(store: Store, enqueuer: Enqueuer, overrides?: Partial<ToolContext>): ToolContext {
  return {
    ownerId: 'user-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    runId: 'run-1',
    store,
    blobs: createMemoryBlobStore(),
    enqueuer,
    wake: {
      id: 'wke_1',
      ownerId: 'user-1',
      agentId: 'agent-1',
      sessionKey: 'agent-1:conv-1',
      conversationId: 'conv-1',
      kind: 'user_message',
      origin: { type: 'user' },
      trusted: true,
      priority: 'user',
      payload: {},
      at: new Date().toISOString(),
      status: 'accepted',
    } as WakeEvent,
    step: async (name, fn) => fn(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('Tool Registry', () => {
  let store: Store;
  let enqueuer: RecordingEnqueuer;

  beforeEach(() => {
    store = createMemoryStore();
    enqueuer = new RecordingEnqueuer();
  });

  describe('send_message question', () => {
    const ui = {
      version: 1,
      title: 'Proceed with this configuration?',
      blocks: [
        { type: 'facts', rows: [{ label: 'Model', value: 'Mac mini M4' }, { label: 'Memory', value: '16GB' }] },
        { type: 'choices', id: 'go', options: [{ id: 'yes', label: 'Continue', style: 'primary' }, { id: 'no', label: 'Cancel' }] },
      ],
    };

    it('raises a request whose payload is the ui doc without suspending the run', async () => {
      const registry = await createToolRegistry({ store, enqueuer, config: {} });
      const tool = registry.get('send_message');
      if (!tool) throw new Error('send_message missing');
      const result = await tool.execute({ kind: 'question', ui }, createMockToolContext(store, enqueuer));

      expect(result.suspend).toBeUndefined();
      expect(JSON.stringify(result.content)).toContain('end your turn');
      const [request] = (await store.list('requests')).items;
      expect(request).toMatchObject({ kind: 'question', status: 'pending', summary: 'Proceed with this configuration?', payload: { kind: 'question', ui: { ...ui, text: 'Proceed with this configuration?\n\nModel: Mac mini M4\nMemory: 16GB\nOptions: Continue / Cancel' } } });
    });

    it.each([
      ['no ui', undefined, /exactly one interactive/],
      ['no interactive block', { version: 1, blocks: [{ type: 'text', text: 'Proceed?' }] }, /exactly one interactive/],
      ['two interactive blocks', { version: 1, blocks: [ui.blocks[1], { type: 'fields', id: 'f', fields: [{ id: 'a', label: 'A', kind: 'text' }] }] }, /one interactive/],
    ])('refuses %s without raising a request', async (_name, bad, message) => {
      const registry = await createToolRegistry({ store, enqueuer, config: {} });
      const result = await registry.get('send_message')!.execute({ kind: 'question', ui: bad }, createMockToolContext(store, enqueuer));
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(message);
      expect((await store.list('requests')).items).toHaveLength(0);
    });
  });

  describe('send_message ui', () => {
    it('stores the card on the message and falls back to its text when no lead-in is given', async () => {
      const registry = await createToolRegistry({ store, enqueuer, config: {} });
      const tool = registry.get('send_message')!;
      const card = { version: 1, title: 'Result', blocks: [{ type: 'facts', rows: [{ label: 'Total', value: 'S$5' }] }] };
      await tool.execute({ kind: 'text', ui: card }, createMockToolContext(store, enqueuer));
      await tool.execute({ kind: 'text', text: 'Here you go.', ui: card }, createMockToolContext(store, enqueuer));
      const items = (await store.list('items')).items as Array<{ markdown: string; ui?: unknown }>;
      expect(items.map((item) => item.markdown).sort()).toEqual(['Here you go.', 'Result\n\nTotal: S$5']);
      expect(items.every((item) => item.ui !== undefined)).toBe(true);
    });

    it('posts quick replies alone without their text form as a bubble', async () => {
      const registry = await createToolRegistry({ store, enqueuer, config: {} });
      const replies = { version: 1, blocks: [{ type: 'replies', options: ['Search more shops', 'Not now'] }] };
      const result = await registry.get('send_message')!.execute({ kind: 'text', ui: replies }, createMockToolContext(store, enqueuer));
      expect(result.isError).toBeUndefined();
      const [item] = (await store.list('items')).items as Array<{ markdown: string; ui?: unknown }>;
      expect(item).toMatchObject({ markdown: '', ui: { blocks: replies.blocks } });
    });

    it('refuses an answerable block in a plain message', async () => {
      const registry = await createToolRegistry({ store, enqueuer, config: {} });
      const bad = { version: 1, blocks: [{ type: 'choices', id: 'c', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] };
      const result = await registry.get('send_message')!.execute({ kind: 'text', text: 'Pick', ui: bad }, createMockToolContext(store, enqueuer));
      expect(result.isError).toBe(true);
      expect((await store.list('items')).items).toHaveLength(0);
    });
  });

  describe('wait_for', () => {
    it('should create subscriptions doc and suspend with event reason', async () => {
      const registry = await createToolRegistry({ store, enqueuer, config: {} });
      const tool = registry.get('wait_for');
      expect(tool).toBeDefined();

      if (!tool) return;

      const ctx = createMockToolContext(store, enqueuer);
      const result = await tool.execute(
        {
          filter: { source: 'github', type: 'pr.merged' },
          timeout: '+1h',
        },
        ctx
      );

      expect(result.suspend?.reason).toBe('event');
      expect(result.suspend?.awakeableId).toBeDefined();

      const subscriptions = await store.list('subscriptions');
      expect(subscriptions.items.length).toBe(1);
      const subscription = subscriptions.items[0];
      if (subscription) {
        expect((subscription as any).filter).toEqual({ source: 'github', type: 'pr.merged' });
      }
    });
  });

  describe('message_agent', () => {
    it('should enqueue a validated WakeEvent when sent from a room the user is in', async () => {
      await seedLegacyGraph(store);
      const registry = await createToolRegistry({ store, enqueuer, config: {} });
      const tool = registry.get('message_agent');
      expect(tool).toBeDefined();

      if (!tool) return;

      const result = await tool.execute({ target: 'agent-2', message: 'Hello agent 2' }, createMockToolContext(store, enqueuer, { conversationId: 'room-1' }));

      expect(result.isError).not.toBe(true);

      const enqueueCalls = enqueuer.calls.filter((c) => c.method === 'enqueue');
      expect(enqueueCalls.length).toBe(1);
      const call = enqueueCalls[0];
      if (call && call.event) {
        const event = call.event;
        expect(event.kind).toBe('room_mention');
        expect(event.conversationId).toBe('room-1');
        expect(event.trusted).toBe(false);
        expect(event.priority).toBe('peer');
        expect(event.hop?.depth).toBe(1);

        const validation = wakeEventSchema.safeParse(event);
        expect(validation.success).toBe(true);
      }
    });
  });

  describe('state_update routine', () => {
    it('should create routine doc and schedule it', async () => {
      await seedLegacyGraph(store);
      await store.put('conversations', {
        id: 'conv-1',
        kind: 'direct',
        title: 'Legacy direct',
        agentIds: ['agent-1'],
        memberIds: ['user-1'],
        unreadCount: 0,
        lastItemAt: LEGACY_NOW,
        createdAt: LEGACY_NOW,
      });
      const registry = await createToolRegistry({ store, enqueuer, config: {} });
      const tool = registry.get('state_update');
      expect(tool).toBeDefined();

      if (!tool) return;

      const ctx = createMockToolContext(store, enqueuer);
      const result = await tool.execute(
        {
          target: 'routine',
          action: 'create',
          name: 'Daily check',
          prompt: 'Check daily tasks',
          schedule: '0 9 * * *',
        },
        ctx
      );

      expect(result.isError).not.toBe(true);

      const scheduleRoutineCalls = enqueuer.calls.filter((c) => c.method === 'scheduleRoutine');
      expect(scheduleRoutineCalls.length).toBe(1);

      const routines = await store.list('routines', { limit: 10 });
      expect(routines.items.length).toBe(1);
      const routine = routines.items[0];
      if (routine) {
        expect(routine.agentId).toBe(ctx.agentId);
        expect(routine.delivery.channel).toBe('chat');
        expect(routine.delivery.target).toBe(ctx.conversationId);
        expect(routine.name).toBe('Daily check');
        expect(routine.trigger).toMatchObject({ kind: 'schedule', cron: '0 9 * * *' });
      }
    });

    it('refuses a target it does not implement instead of reporting success', async () => {
      const registry = await createToolRegistry({ store, enqueuer, config: {} });
      const tool = registry.get('state_update');
      if (!tool) throw new Error('state_update missing');
      await expect(tool.execute({ target: 'skill', action: 'create' }, createMockToolContext(store, enqueuer))).rejects.toThrow();
      await expect(tool.execute({ target: 'memory', action: 'write' }, createMockToolContext(store, enqueuer))).rejects.toThrow();
      expect((await store.list('routines', { limit: 10 })).items).toEqual([]);
    });
  });
});

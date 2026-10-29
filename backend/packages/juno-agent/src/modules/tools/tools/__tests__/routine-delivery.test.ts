 import { settingsIdFor } from '../../../../execution/brain/model-selection.js';
import { createMemoryBlobStore } from '../../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
 import { createMemoryStore } from '../../../../testing/store.js';
 import type { Enqueuer, Store, ToolContext, WakeEvent } from '../../../../contracts/index.js';
 import type { Agent, Conversation } from '@agent-desktop/public-contracts';
 import { createStateUpdateTool } from '../stateUpdate.js';
 
 const OWNER = 'owner-gh6';
 const OTHER_OWNER = 'owner-foreign';
 const NOW = '2026-10-07T00:00:00.000Z';
 
 class RecordingEnqueuer implements Enqueuer {
   scheduled: string[] = [];
 
   async enqueue(): Promise<{ accepted: boolean }> {
     return { accepted: true };
   }
 
   async stopRun(): Promise<void> {}
 
   async resolveAwakeable(): Promise<void> {}
 
   async scheduleRoutine(routineId: string): Promise<void> {
     this.scheduled.push(routineId);
   }
 }
 
 function agentDoc(id: string, owner: string): Agent & { ownerId: string } {
   return {
     id,
     ownerId: owner,
     createdBy: owner,
     name: 'Agent ' + id,
     handle: id,
     avatar: { shape: 'circle', color: 1, eyes: 'happy' },
     title: 'QA',
     status: 'idle',
     section: 'Agents',
     pinned: false,
     lastActivity: 'idle',
     unreadCount: 0,
     model: {
       planner: { provider: 'fixture', model: 'fixture' },
       computer: { provider: 'fixture', model: 'fixture' },
       fast: { provider: 'fixture', model: 'fixture' },
     },
     channels: [],
     macAccess: false,
     skillIds: [],
     pluginIds: [],
     sharing: { publishedToTeam: false },
     createdAt: NOW,
     updatedAt: NOW,
   };
 }
 
 function conversationDoc(id: string, kind: Conversation['kind'], agents: string[], members: string[]): Conversation {
   return {
     id,
     kind,
     agentIds: agents,
     memberIds: members,
     unreadCount: 0,
     lastItemAt: NOW,
     createdAt: NOW,
   };
 }
 
 async function seed(store: Store): Promise<void> {
   await store.put('agents', agentDoc('agent-1', OWNER));
   await store.put('agents', agentDoc('agent-2', OWNER));
   await store.put('conversations', conversationDoc('conv-direct', 'direct', ['agent-1'], [OWNER]));
   await store.put('conversations', conversationDoc('conv-room', 'room', ['agent-1', 'agent-2'], [OWNER]));
   await store.put('agents', agentDoc('agent-x', OTHER_OWNER));
   await store.put('conversations', conversationDoc('conv-foreign', 'direct', ['agent-x'], [OTHER_OWNER]));
 }
 
 function ctxFor(store: Store, enqueuer: Enqueuer, conversationId: string): ToolContext {
   const wake: WakeEvent = {
     id: 'wke-gh6',
     ownerId: OWNER,
     agentId: 'agent-1',
     sessionKey: 'agent-1:' + conversationId,
     conversationId,
     kind: 'user_message',
     origin: { type: 'user', id: OWNER },
     trusted: true,
     priority: 'user',
     payload: {},
     at: NOW,
     status: 'accepted',
   };
   return {
     ownerId: OWNER,
     agentId: 'agent-1',
     conversationId,
     runId: 'run-gh6',
     store, blobs: createMemoryBlobStore(),
     enqueuer,
     wake,
     step: async (_name, fn) => fn(),
     signal: new AbortController().signal,
   };
 }
 
 function deliveryTarget(routine: unknown): unknown {
   if (typeof routine !== 'object' || routine === null) return undefined;
   const delivery: unknown = Reflect.get(routine, 'delivery');
   if (typeof delivery !== 'object' || delivery === null) return undefined;
   return Reflect.get(delivery, 'target');
 }
 
 async function routinesIn(store: Store): Promise<unknown[]> {
   const page = await store.list('routines', { limit: 100 });
   return page.items;
 }
 
 describe('routine delivery scoping (GH6)', () => {
  it('schedules an agent-written cron in the owner timezone, UTC when none is known', async () => {
    const store = createMemoryStore();
    const enqueuer = new RecordingEnqueuer();
    await seed(store);
    const tool = createStateUpdateTool({ store, enqueuer });
    const create = (name: string) => tool.execute(
      { target: 'routine', action: 'create', name, prompt: 'Check tasks', schedule: '0 9 * * *' },
      ctxFor(store, enqueuer, 'conv-direct'),
    );
    await create('Before');
    await store.put('settings', { id: settingsIdFor(OWNER), general: { timezone: 'Asia/Singapore' } } as never);
    await create('After');
    const tzOf = (name: string) => (routines as Array<{ name?: string; trigger?: { tz?: string } }>).find((r) => r.name === name)?.trigger?.tz;
    const routines = await routinesIn(store);
    expect(tzOf('Before')).toBe('UTC');
    expect(tzOf('After')).toBe('Asia/Singapore');
  });

   it('persists the private direct chat as the delivery target', async () => {
     const store = createMemoryStore();
     const enqueuer = new RecordingEnqueuer();
     await seed(store);
     const tool = createStateUpdateTool({ store, enqueuer });
 
     const result = await tool.execute(
       { target: 'routine', action: 'create', name: 'Daily check', prompt: 'Check tasks', schedule: '0 9 * * *' },
       ctxFor(store, enqueuer, 'conv-direct'),
     );
 
     expect(result.isError).not.toBe(true);
     expect(enqueuer.scheduled).toHaveLength(1);
     const routines = await routinesIn(store);
     expect(routines).toHaveLength(1);
     expect(deliveryTarget(routines[0])).toBe('conv-direct');
    expect(routines[0]).toMatchObject({ agentId: 'agent-1' });
   });
 
   it('persists the group room chat as the delivery target', async () => {
     const store = createMemoryStore();
     const enqueuer = new RecordingEnqueuer();
     await seed(store);
     const tool = createStateUpdateTool({ store, enqueuer });
 
     const result = await tool.execute(
       { target: 'routine', action: 'create', name: 'Room digest', prompt: 'Summarize', schedule: '0 9 * * *' },
       ctxFor(store, enqueuer, 'conv-room'),
     );
 
     expect(result.isError).not.toBe(true);
     expect(enqueuer.scheduled).toHaveLength(1);
     const routines = await routinesIn(store);
     expect(routines).toHaveLength(1);
     expect(deliveryTarget(routines[0])).toBe('conv-room');
   });
 
   it('rejects a missing conversation target with no side effects', async () => {
     const store = createMemoryStore();
     const enqueuer = new RecordingEnqueuer();
     await seed(store);
     const tool = createStateUpdateTool({ store, enqueuer });
 
     const result = await tool.execute(
       { target: 'routine', action: 'create', name: 'No chat', prompt: 'Nothing', schedule: '0 9 * * *' },
       ctxFor(store, enqueuer, ''),
     );
 
     expect(result.isError).toBe(true);
     expect(await routinesIn(store)).toHaveLength(0);
     expect(enqueuer.scheduled).toHaveLength(0);
   });
 
   it('rejects a foreign conversation with no side effects', async () => {
     const store = createMemoryStore();
     const enqueuer = new RecordingEnqueuer();
     await seed(store);
     const tool = createStateUpdateTool({ store, enqueuer });
 
     const result = await tool.execute(
       { target: 'routine', action: 'create', name: 'Foreign', prompt: 'Nope', schedule: '0 9 * * *' },
       ctxFor(store, enqueuer, 'conv-foreign'),
     );
 
     expect(result.isError).toBe(true);
     expect(await routinesIn(store)).toHaveLength(0);
     expect(enqueuer.scheduled).toHaveLength(0);
   });
 });
 

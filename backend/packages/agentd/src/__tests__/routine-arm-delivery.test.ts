import { createMemoryBlobStore } from '@agent-desktop/db';
 /**
  * GH6 integration: the public state_update path persists delivery.target and
  * the scheduleRoutine ingress body carries the full persisted routine so
  * RoutineTimer.arm can trigger it and resolve the same delivery target.
  */
 import { describe, expect, it } from 'vitest';
 import { createMemoryStore } from '@agent-desktop/db';
 import type { Enqueuer, Store, ToolContext, WakeEvent } from '@agent-desktop/contracts';
 import type { Agent, Conversation } from '@agent-desktop/public-contracts';
 import { RunnerEnqueuer } from '../enqueuer.js';
import { RunnerStub } from './runner-stub.js';
 import { createStateUpdateTool } from 'juno-agent/modules/tools/tools/stateUpdate';
 import { resolveDeliveryConversation } from 'juno-agent/execution/harness/services/routineTimer';
 
 const OWNER = 'owner-gh6';
 const NOW = '2026-10-07T00:00:00.000Z';
 
 function agentDoc(): Agent & { ownerId: string } {
   return {
     id: 'agent-1',
     ownerId: OWNER,
     createdBy: OWNER,
     name: 'Agent agent-1',
     handle: 'agent-1',
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
 
 function conversationDoc(): Conversation {
   return {
     id: 'conv-direct',
     kind: 'direct',
     agentIds: ['agent-1'],
     memberIds: [OWNER],
     unreadCount: 0,
     lastItemAt: NOW,
     createdAt: NOW,
   };
 }
 
 function ctxFor(store: Store, enqueuer: Enqueuer): ToolContext {
   const wake: WakeEvent = {
     id: 'wke-gh6',
     ownerId: OWNER,
     agentId: 'agent-1',
     sessionKey: 'agent-1:conv-direct',
     conversationId: 'conv-direct',
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
     conversationId: 'conv-direct',
     runId: 'run-gh6',
     store, blobs: createMemoryBlobStore(),
     enqueuer,
     wake,
     step: async (_name, fn) => fn(),
     signal: new AbortController().signal,
   };
 }
 
 function field(doc: unknown, key: string): unknown {
   if (typeof doc !== 'object' || doc === null) return undefined;
   return Reflect.get(doc, key);
 }
 
 describe('routine arm delivery (GH6)', () => {
   it('arms the timer with the persisted routine carrying the chat target', async () => {
     const stub = new RunnerStub();
     {
       const store = createMemoryStore();
       await store.put('agents', agentDoc());
       await store.put('conversations', conversationDoc());
       const enqueuer = new RunnerEnqueuer(stub.asRunner(), store);
       const tool = createStateUpdateTool({ store, enqueuer });
 
       const result = await tool.execute(
         { target: 'routine', action: 'create', name: 'Daily check', prompt: 'Check tasks', schedule: '0 9 * * *' },
         ctxFor(store, enqueuer),
       );
       expect(result.isError).not.toBe(true);
       expect(stub.calls).toHaveLength(1);
 
       const sent: unknown = stub.calls[0]?.target?.input;
       expect(field(sent, 'agentId')).toBe('agent-1');
       expect(field(sent, 'enabled')).toBe(true);
      expect(typeof field(sent, 'trigger')).toBe('object');
      const delivery: unknown = field(sent, 'delivery');
       expect(field(delivery, 'channel')).toBe('chat');
       expect(field(delivery, 'target')).toBe('conv-direct');
 
       const routineId: unknown = field(sent, 'id');
       if (typeof routineId !== 'string') throw new Error('arm body carries no routine id');
       expect(stub.calls[0]?.target).toMatchObject({ service: 'RoutineTimer', key: routineId, handler: 'arm' });
 
       const persisted: unknown = await store.get('routines', routineId);
       expect(field(field(persisted, 'delivery'), 'target')).toBe('conv-direct');
       if (persisted === null) throw new Error('persisted routine missing');
       const resolved = await resolveDeliveryConversation(
         {
           id: String(field(persisted, 'id')),
           agentId: 'agent-1',
           name: 'Daily check',
           instructions: '',
           trigger: { kind: 'schedule', human: 'Daily', tz: 'UTC' },
           delivery: { channel: 'chat', target: 'conv-direct' },
           notify: { mode: 'always' },
           enabled: true,
           status: 'active',
           runs: [],
           createdAt: NOW,
         },
         store,
       );
       expect(resolved).toBe('conv-direct');
     }
   });
 
   it('skips the arm send when the routine was never persisted', async () => {
     const stub = new RunnerStub();
     await new RunnerEnqueuer(stub.asRunner(), createMemoryStore()).scheduleRoutine('rtn-gone');
     expect(stub.calls).toHaveLength(0);
   });
 });

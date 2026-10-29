 import { describe, expect, it } from 'vitest';
 import { createMemoryStore } from '../../../../testing/store.js';
 import type { Store } from '../../../../contracts/index.js';
 import type { Routine } from '@agent-desktop/public-contracts';
 import { resolveDeliveryConversation } from '../routineTimer.js';
 
 const NOW = '2026-10-07T00:00:00.000Z';
 
 function routine(id: string, agentId: string, target: string | undefined): Routine {
   return {
     id,
     agentId,
     name: 'Routine ' + id,
     instructions: '',
     trigger: { kind: 'schedule', human: 'Daily', tz: 'UTC' },
     delivery: target === undefined ? { channel: 'chat' } : { channel: 'chat', target },
     notify: { mode: 'always' },
     enabled: true,
     status: 'active',
     runs: [],
     createdAt: NOW,
   };
 }
 
 async function seed(store: Store): Promise<void> {
   await store.put('conversations', {
     id: 'conv-direct',
     kind: 'direct',
     agentIds: ['agent-1'],
     memberIds: ['owner-a'],
     unreadCount: 0,
     lastItemAt: NOW,
     createdAt: NOW,
   });
   await store.put('conversations', {
     id: 'conv-room',
     kind: 'room',
     agentIds: ['agent-1', 'agent-2'],
     memberIds: ['owner-a'],
     unreadCount: 0,
     lastItemAt: NOW,
     createdAt: NOW,
   });
   await store.put('conversations', {
     id: 'conv-foreign',
     kind: 'direct',
     agentIds: ['agent-x'],
     memberIds: ['owner-b'],
     unreadCount: 0,
     lastItemAt: NOW,
     createdAt: NOW,
   });
 }
 
 describe('routineTimer delivery target (GH6)', () => {
   it('honors a validated direct chat target', async () => {
     const store = createMemoryStore();
     await seed(store);
     await expect(resolveDeliveryConversation(routine('rtn-1', 'agent-1', 'conv-direct'), store)).resolves.toBe('conv-direct');
   });
 
   it('honors a validated group room target', async () => {
     const store = createMemoryStore();
     await seed(store);
     await expect(resolveDeliveryConversation(routine('rtn-2', 'agent-1', 'conv-room'), store)).resolves.toBe('conv-room');
   });
 
   it('refuses a foreign target the agent is not a member of', async () => {
     const store = createMemoryStore();
     await seed(store);
     await expect(resolveDeliveryConversation(routine('rtn-3', 'agent-1', 'conv-foreign'), store)).resolves.toBeUndefined();
   });
 
   it('refuses a missing target conversation instead of inventing one', async () => {
     const store = createMemoryStore();
     await seed(store);
     await expect(resolveDeliveryConversation(routine('rtn-4', 'agent-1', 'conv-gone'), store)).resolves.toBeUndefined();
   });
 
   it('resolves a legacy target-less routine to its actual direct chat', async () => {
     const store = createMemoryStore();
     await seed(store);
     await expect(resolveDeliveryConversation(routine('rtn-5', 'agent-1', undefined), store)).resolves.toBe('conv-direct');
   });
 
   it.each(['email', 'slack'] as const)('refuses %s delivery even with an available direct chat', async channel => {
     const store = createMemoryStore();
     await seed(store);
     const scheduled = routine('rtn-external', 'agent-1', undefined);
     scheduled.delivery = { channel };
     await expect(resolveDeliveryConversation(scheduled, store)).resolves.toBeUndefined();
     scheduled.delivery.target = 'conv-direct';
     await expect(resolveDeliveryConversation(scheduled, store)).resolves.toBeUndefined();
   });

   it('never invents an id when no direct chat exists', async () => {
     const store = createMemoryStore();
     await expect(resolveDeliveryConversation(routine('rtn-6', 'agent-ghost', undefined), store)).resolves.toBeUndefined();
   });
 });
 

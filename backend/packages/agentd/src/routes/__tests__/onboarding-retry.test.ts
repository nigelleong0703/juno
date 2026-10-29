/** First-run onboarding retry (BACKEND 8.7): choosing a model re-queues the greeting for a still-new, unanswered account. */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer, WakeEvent } from '@agent-desktop/contracts';
import { isNewOwnerChat } from 'juno-agent/modules/onboarding';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';

describe('onboarding retry', () => {
  it('queues the greeting again once per provider while the chat has no agent message, and never after the agent has spoken', async () => {
    const mem = createMemoryStore();
    const wakes: WakeEvent[] = [];
    const enqueuer: Enqueuer = { enqueue: async (wake) => { wakes.push(wake); return { accepted: true }; }, stopRun: async () => undefined, scheduleRoutine: async () => undefined, resolveAwakeable: async () => undefined };
    const store = withDefaultOwner(mem, 'owner-a');
    const app = createTestApp({ store, bus: mem.eventBus, enqueuer });
    const post = (path: string, body?: unknown) => requestAs(app, 'owner-a', path, { method: 'POST', body: body ?? {} });
    const started = await (await post('/v1/onboarding/start')).json() as { agentId: string; conversationId: string };
    const first = 'wake_onboarding_' + started.agentId;
    expect(wakes.map((wake) => wake.id)).toEqual([first]);

    expect((await post('/v1/onboarding/model-chosen', {})).status).toBe(400);
    await post('/v1/onboarding/model-chosen', { providerId: 'mprov-1' });
    await post('/v1/onboarding/model-chosen', { providerId: 'mprov-1' });
    expect(wakes.map((wake) => wake.id)).toEqual([first, first + '_mprov-1', first + '_mprov-1']);
    // The retry greets an account's first agent the same way the sign-up did: with the once-per-account skill too.
    expect(String(wakes[1]?.payload['text'])).toContain('# Account onboarding');

    await store.put('items', { id: 'item-1', conversationId: started.conversationId, type: 'agent_message', at: new Date().toISOString(), markdown: 'Hi' } as never);
    await post('/v1/onboarding/model-chosen', { providerId: 'mprov-2' });
    expect(wakes).toHaveLength(3);
  });

  it('never treats a chat that came through a messaging platform as the sign-up chat', async () => {
    const mem = createMemoryStore();
    const enqueuer: Enqueuer = { enqueue: async () => ({ accepted: true }), stopRun: async () => undefined, scheduleRoutine: async () => undefined, resolveAwakeable: async () => undefined };
    const store = withDefaultOwner(mem, 'owner-a');
    const app = createTestApp({ store, bus: mem.eventBus, enqueuer });
    const started = await (await requestAs(app, 'owner-a', '/v1/onboarding/start', { method: 'POST', body: {} })).json() as { conversationId: string };
    const chat = await store.get('conversations', started.conversationId);
    if (chat === null) throw new Error('expected the sign-up chat');
    const agentId = chat.agentIds[0] ?? '';
    expect(await isNewOwnerChat(store, 'owner-a', agentId, chat.id)).toBe(true);
    const viaSlack = { ...chat, id: 'cvn-slack', channel: { kind: 'slack', channelId: 'T1-U1', threadId: 'D1', chatId: 'D1' } };
    await store.put('conversations', viaSlack);
    expect(await isNewOwnerChat(store, 'owner-a', agentId, 'cvn-slack')).toBe(false);
  });
});

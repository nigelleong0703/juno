/**
 * A new agent speaks first (BACKEND §8.7): every agent created through POST /v1/agents is woken once in its direct chat with the owner,
 * with the agent-setup skill attached to the wake; only the account's first agent (POST /v1/onboarding/start) also gets the account skill.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Enqueuer, WakeEvent } from '@agent-desktop/contracts';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';

function setup() {
  const mem = createMemoryStore();
  const wakes: WakeEvent[] = [];
  const enqueuer: Enqueuer = { enqueue: async (wake) => { wakes.push(wake); return { accepted: true }; }, stopRun: async () => undefined, scheduleRoutine: async () => undefined, resolveAwakeable: async () => undefined };
  const store = withDefaultOwner(mem, 'owner-a');
  const app = createTestApp({ store, bus: mem.eventBus, enqueuer });
  return { store, wakes, post: (path: string, body?: unknown) => requestAs(app, 'owner-a', path, { method: 'POST', body: body ?? {} }) };
}

describe('creating an agent wakes it to speak first', () => {
  it('enqueues exactly one onboarding wake per created agent, in its own direct chat with the owner, with only the agent-setup skill', async () => {
    const { post, wakes, store } = setup();
    const ada = await (await post('/v1/agents', { name: 'Ada' })).json() as { id: string };
    const bo = await (await post('/v1/agents', { name: 'Bo' })).json() as { id: string };
    expect(wakes.map((wake) => wake.id)).toEqual(['wake_onboarding_' + ada.id, 'wake_onboarding_' + bo.id]);
    const chats = (await store.list('conversations', { limit: 10 })).items;
    expect(chats).toHaveLength(2);
    for (const wake of wakes) {
      const chat = chats.find((candidate) => candidate.id === wake.conversationId);
      expect(chat).toMatchObject({ kind: 'direct', agentIds: [wake.agentId], memberIds: ['owner-a'] });
      expect(wake).toMatchObject({ kind: 'onboarding', origin: { type: 'system' }, trusted: true, sessionKey: wake.agentId + ':' + wake.conversationId });
      const text = String(wake.payload['text']);
      expect(text).toContain("You were just created and your owner hasn't talked to you yet");
      expect(text).toContain('# Setting up a new agent');
      expect(text).not.toContain('# Account onboarding');
    }
  });

  it('gives only the account\'s first agent (sign-up) the once-per-account skill as well, account skill first', async () => {
    const { post, wakes } = setup();
    const started = await (await post('/v1/onboarding/start')).json() as { agentId: string };
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.id).toBe('wake_onboarding_' + started.agentId);
    const text = String(wakes[0]?.payload['text']);
    expect(text.indexOf('# Account onboarding')).toBeGreaterThan(0);
    expect(text.indexOf('# Account onboarding')).toBeLessThan(text.indexOf('# Setting up a new agent'));
    // A second agent the owner makes later is not "first": it gets agent-setup alone.
    await post('/v1/agents', { name: 'Ada' });
    expect(wakes).toHaveLength(2);
    expect(String(wakes[1]?.payload['text'])).not.toContain('# Account onboarding');
  });
});

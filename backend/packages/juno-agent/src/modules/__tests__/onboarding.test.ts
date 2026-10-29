/**
 * Onboarding (BACKEND §8.7): every new agent is woken once to speak first, with the guidance attached inline to the wake (two
 * skills for an account's first agent, one for every other). There is no context section and no gate any more.
 */
import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../testing/store.js';
import type { Enqueuer, WakeEvent } from '../../contracts/index.js';
import { wakeMessage } from '../../execution/brain/messages.js';
import { SECTION_ORDER, metaOf } from '../../execution/brain/context-notes.js';
import { onboardNewAgent, onboardingWakeText } from '../onboarding.js';

const OWNER = 'owner-1';
const AT = '2026-10-22T00:00:00.000Z';

function fixture(): { store: ReturnType<typeof createMemoryStore>; wakes: WakeEvent[]; deps: { store: ReturnType<typeof createMemoryStore>; enqueuer: Enqueuer } } {
  const store = createMemoryStore();
  const wakes: WakeEvent[] = [];
  const enqueuer = { enqueue: async (wake: WakeEvent) => { wakes.push(wake); return { accepted: true }; } } as unknown as Enqueuer;
  return { store, wakes, deps: { store, enqueuer } };
}

const agentNamed = (id: string, name: string): Agent => ({ id, name, ownerId: OWNER, createdAt: AT, updatedAt: AT } as unknown as Agent);

describe('the onboarding wake', () => {
  it('carries the skills inline: both for the account\'s first agent (account skill first), only agent-setup for any other', () => {
    const first = onboardingWakeText(true);
    const other = onboardingWakeText(false);
    expect(first.startsWith('[You were just created and your owner hasn\'t talked to you yet. Your final reply is your first message to them in this chat.]')).toBe(true);
    expect(other.startsWith(first.slice(0, 40))).toBe(true);
    expect(first.indexOf('# Account onboarding')).toBeGreaterThan(0);
    expect(first.indexOf('# Account onboarding')).toBeLessThan(first.indexOf('# Setting up a new agent'));
    expect(other).toContain('# Setting up a new agent');
    expect(other).not.toContain('# Account onboarding');
  });

  it('reaches the model as written (no automatic-wake note, no wrapper) and no context section is left for it', async () => {
    const { deps, wakes, store } = fixture();
    await store.put('agents', agentNamed('agt-1', 'Ada'));
    await onboardNewAgent(deps, OWNER, agentNamed('agt-1', 'Ada'), { account: false });
    const [wake] = wakes;
    expect(wake?.kind).toBe('onboarding');
    expect(wake === undefined ? '' : String(wakeMessage(wake).content)).toBe(onboardingWakeText(false));
    expect(SECTION_ORDER as readonly string[]).not.toContain('onboarding');
  });
});

describe('onboardNewAgent', () => {
  it('opens the agent\'s direct chat with the owner and enqueues one wake with a fixed id per agent; a repeat finds the same chat and the same id', async () => {
    const { deps, wakes, store } = fixture();
    const ada = agentNamed('agt-1', 'Ada');
    await store.put('agents', ada);
    const chat = await onboardNewAgent(deps, OWNER, ada, { account: false });
    const again = await onboardNewAgent(deps, OWNER, ada, { account: false });
    expect(again).toBe(chat);
    expect((await store.list('conversations', { limit: 10 })).items).toHaveLength(1);
    expect(wakes.map((wake) => wake.id)).toEqual(['wake_onboarding_agt-1', 'wake_onboarding_agt-1']);
    expect(wakes[0]).toMatchObject({ agentId: 'agt-1', conversationId: chat, sessionKey: 'agt-1:' + chat, ownerId: OWNER, trusted: true, origin: { type: 'system' } });
  });

  it('gives each agent its own wake id', async () => {
    const { deps, wakes, store } = fixture();
    for (const id of ['agt-1', 'agt-2']) {
      await store.put('agents', agentNamed(id, id));
      await onboardNewAgent(deps, OWNER, agentNamed(id, id), { account: false });
    }
    expect(wakes.map((wake) => wake.id)).toEqual(['wake_onboarding_agt-1', 'wake_onboarding_agt-2']);
  });
});

describe('stored context meta', () => {
  it('still reads a row that delivered the removed onboarding section: the stale key is dropped, the rest is kept', () => {
    const meta = metaOf({ contextMeta: { sections: { profile: 'p1', onboarding: 'o1', date: 'd1' }, toolOrder: ['send_message'], promptHash: 'h' } });
    expect(meta).toEqual({ sections: { profile: 'p1', date: 'd1' }, toolOrder: ['send_message'], promptHash: 'h' });
  });
});

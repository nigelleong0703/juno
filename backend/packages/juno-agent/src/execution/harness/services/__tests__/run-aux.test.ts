/**
 * BACKEND §10.11: the run's title is the agent's own name for its work, and the once-per-agent role suggestion is written in the
 * background, and a failed or empty model reply leaves the stored rows exactly as they were.
 */
import { createMemoryBlobStore } from '../../../../testing/blobs.js';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '../../../../testing/store.js';
import type { Brain, Store } from '../../../../contracts/index.js';
import type { Agent, Conversation, Run } from '@agent-desktop/public-contracts';
import type { RunServices } from '../run-types.js';
import { applyStepSummaries, nameRunByAgent, startRunAuxiliaries } from '../run-aux.js';
import { runTitleFor } from '../../logic/busy.js';

const AT = '2026-10-09T00:00:00.000Z';
const RAW = 'Two things, using your tools: (1) post one short item to the feed';

function fixtures(store: ReturnType<typeof createMemoryStore>, quickText: Brain['quickText']): RunServices {
  const brain = { buildContext: async () => ({ sessionKey: 's', agentId: 'agent-1' }), quickText } as unknown as Brain;
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: { forAgent: async () => [], get: () => undefined } };
}

function run(title: string): Run {
  return {
    id: 'run-1', agentId: 'agent-1', conversationId: 'conv-1', title, status: 'running', kind: 'chat',
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: AT, lastActivityAt: AT,
  };
}

function agent(title: string): Agent {
  return {
    id: 'agent-1', name: 'Coach', handle: 'coach', avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title, status: 'idle', section: 'Inbox', pinned: false, lastActivity: 'Just created', unreadCount: 0,
    channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdAt: AT, updatedAt: AT,
  } as Agent;
}

const wake = [{ id: 'wake-1', kind: 'user_message', payload: { text: RAW }, origin: { label: 'You' } }] as never;
const input = { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: 'agent-1:conv-1', wakeEvents: wake } as never;
const RAW_TITLE = runTitleFor(wake);
const ROLE_REPLY = '{"title":"Running coach","description":"Tracks runs and recovery."}';

/** A direct chat with the agent (no role yet) and three user messages, so the role is eligible. */
async function seedDirectChat(store: ReturnType<typeof createMemoryStore>): Promise<void> {
  await store.put('agents', agent('New agent'));
  await store.put('conversations', { id: 'conv-1', kind: 'direct', agentIds: ['agent-1'], title: 'Chat' } as unknown as Conversation);
  for (const [index, text] of ['log my run', 'and my sleep', 'remind me to stretch'].entries()) {
    await store.put('items', { id: 'item-' + index, type: 'user_message', conversationId: 'conv-1', authorId: 'u', text, attachments: [], mentions: [], at: '2026-10-09T00:00:0' + index + '.000Z' } as never, { conversationId: 'conv-1' });
  }
}

async function roleSuggestionItems(store: Store): Promise<Array<Record<string, unknown>>> {
  const page = await store.list('items', { where: { conversationId: 'conv-1' }, limit: 200 });
  return page.items.filter((item) => item.type === 'role_suggestion') as Array<Record<string, unknown>>;
}

describe('run auxiliaries', () => {
  it('names the run from the first task or helper title the agent gives; later ones and child runs do not rename it', async () => {
    const store = createMemoryStore();
    await store.put('runs', run(RAW_TITLE));
    await store.put('runs', { ...run('child'), id: 'run-2', parentRunId: 'run-1' });
    await nameRunByAgent(store, 'run-1', 'Plan KL food and sights');
    await nameRunByAgent(store, 'run-1', 'Build the itinerary page');
    await nameRunByAgent(store, 'run-2', 'Something else');
    expect((await store.get('runs', 'run-1'))?.title).toBe('Plan KL food and sights');
    expect((await store.get('runs', 'run-2'))?.title).toBe('child');
  });

  it('asks no model for a title: the run keeps the raw wake text until the agent names its work', async () => {
    const store = createMemoryStore();
    await store.put('runs', run(RAW_TITLE));
    const quickText = vi.fn(async () => null);
    startRunAuxiliaries(fixtures(store, quickText), input, 'run-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await store.get('runs', 'run-1'))?.title).toBe(RAW_TITLE);
    expect(quickText.mock.calls.some((call) => String((call as unknown[])[0]).includes('short title'))).toBe(false);
  });

  it('suggests a role once a direct chat has three user messages and the agent has no role', async () => {
    const store = createMemoryStore();
    await store.put('agents', agent('New agent'));
    await store.put('conversations', { id: 'conv-1', kind: 'direct', agentIds: ['agent-1'], title: 'Chat' } as unknown as Conversation);
    for (const [index, text] of ['log my run', 'and my sleep', 'remind me to stretch'].entries()) {
      await store.put('items', { id: 'item-' + index, type: 'user_message', conversationId: 'conv-1', authorId: 'u', text, attachments: [], mentions: [], at: '2026-10-09T00:00:0' + index + '.000Z' } as never, { conversationId: 'conv-1' });
    }
    const quickText = vi.fn(async (prompt: string) => (prompt.includes('Suggest the role') ? '{"title":"Running coach","description":"Tracks runs and recovery."}' : '“Track my runs”'));
    startRunAuxiliaries(fixtures(store, quickText), input, 'run-1');
    await vi.waitFor(async () => expect((await store.get('agents', 'agent-1'))?.roleSuggestion).toBeDefined());
    const suggestion = (await store.get('agents', 'agent-1'))?.roleSuggestion;
    expect(suggestion).toMatchObject({ title: 'Running coach', description: 'Tracks runs and recovery.' });
    // A suggestion that is already stored (or a dismissed one) is never asked for again.
    await store.put('agents', { ...agent('New agent'), roleSuggestionDismissedAt: AT } as Agent);
    startRunAuxiliaries(fixtures(store, quickText), input, 'run-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(quickText.mock.calls.filter(([prompt]) => prompt.includes('Suggest the role'))).toHaveLength(1);
  });

  it('writes exactly one role_suggestion item, mirroring the stored suggestion, in the direct chat', async () => {
    const store = createMemoryStore();
    await seedDirectChat(store);
    const quickText = vi.fn(async (prompt: string) => (prompt.includes('Suggest the role') ? ROLE_REPLY : '“Track my runs”'));
    startRunAuxiliaries(fixtures(store, quickText), input, 'run-1');
    await vi.waitFor(async () => expect((await store.get('agents', 'agent-1'))?.roleSuggestion).toBeDefined());
    const stored = (await store.get('agents', 'agent-1'))?.roleSuggestion;
    const cards = await roleSuggestionItems(store);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      conversationId: 'conv-1',
      type: 'role_suggestion',
      agentId: 'agent-1',
      title: 'Running coach',
      description: 'Tracks runs and recovery.',
      suggestionAt: stored?.createdAt,
    });
  });

  it('two runs that race past eligibility still leave one suggestion and one card', async () => {
    const store = createMemoryStore();
    await seedDirectChat(store);
    const quickText = vi.fn(async (prompt: string) => (prompt.includes('Suggest the role') ? ROLE_REPLY : '“Track my runs”'));
    startRunAuxiliaries(fixtures(store, quickText), input, 'run-1');
    startRunAuxiliaries(fixtures(store, quickText), input, 'run-2');
    await vi.waitFor(async () => expect((await store.get('agents', 'agent-1'))?.roleSuggestion).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await roleSuggestionItems(store)).toHaveLength(1);
  });

  it('writes no role_suggestion item when the model reply is not a usable suggestion', async () => {
    const store = createMemoryStore();
    await seedDirectChat(store);
    const quickText = vi.fn(async (prompt: string) => (prompt.includes('Suggest the role') ? 'no json here' : '“Track my runs”'));
    startRunAuxiliaries(fixtures(store, quickText), input, 'run-1');
    await vi.waitFor(() => expect(quickText).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await store.get('agents', 'agent-1'))?.roleSuggestion).toBeUndefined();
    expect(await roleSuggestionItems(store)).toHaveLength(0);
  });
});

describe('applyStepSummaries', () => {
  const step = (index: number) => ({ id: 's' + index, runId: 'run-1', index, kind: 'tool', verb: 'Ran', target: 't', status: 'done', startedAt: AT, durationMs: 1 }) as never;
  const base = { ...run('t'), steps: [step(0), step(1)] };

  it('maps by index, ignores unknown indexes, clips lengths', () => {
    const reply = 'ok ```json {"summary":"' + 'x'.repeat(400) + '","steps":[{"index":1,"title":"Searched","detail":"3 results"},{"index":9,"title":"ghost"}]} ```';
    const out = applyStepSummaries(base, reply);
    expect(out?.summary).toHaveLength(300);
    expect(out?.steps[0]).toEqual(base.steps[0]);
    expect(out?.steps[1]).toMatchObject({ title: 'Searched', detail: '3 results' });
    expect(out?.steps).toHaveLength(2);
  });

  it('is undefined for unusable replies', () => {
    expect(applyStepSummaries(base, null)).toBeUndefined();
    expect(applyStepSummaries(base, 'no json')).toBeUndefined();
    expect(applyStepSummaries(base, '{"steps":[{"index":7,"title":"x"}]}')).toBeUndefined();
  });
});

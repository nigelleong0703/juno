/**
 * agent_create: an agent another agent creates is met by the owner too, so it is woken once to speak first in its own direct chat
 * (the same onboarding helper as POST /v1/agents), with the agent-setup skill alone.
 */
import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-desktop/public-contracts';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore } from '../../../testing/store.js';
import type { Enqueuer, ToolContext, WakeEvent } from '../../../contracts/index.js';
import { createAgentCreateTool } from '../tools/agentCreate.js';

const OWNER = 'owner-ac';
const CREATOR = 'agent-ac';
const AT = '2026-10-22T00:00:00.000Z';

describe('agent_create', () => {
  it('wakes the new agent once in its own direct chat with the owner, with the agent-setup skill only', async () => {
    const store = createMemoryStore();
    await store.put('agents', { id: CREATOR, name: 'Juno', ownerId: OWNER, createdBy: OWNER, macAccess: false, createdAt: AT, updatedAt: AT } as unknown as Agent);
    const wakes: WakeEvent[] = [];
    const enqueuer = { enqueue: async (wake: WakeEvent) => { wakes.push(wake); return { accepted: true }; } } as unknown as Enqueuer;
    const ctx = {
      ownerId: OWNER, agentId: CREATOR, conversationId: 'conv-ac', runId: 'run-ac', store, blobs: createMemoryBlobStore(), enqueuer,
      step: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
      signal: new AbortController().signal,
    } as unknown as ToolContext;

    const result = await createAgentCreateTool({ store }).execute({ name: 'Scout', description: 'Finds flights' }, ctx);
    expect(result.isError).not.toBe(true);

    const created = (await store.list('agents', { limit: 10 })).items.find((agent) => agent.name === 'Scout');
    expect(created).toBeDefined();
    expect(wakes.map((wake) => wake.id)).toEqual(['wake_onboarding_' + created?.id]);
    const chats = (await store.list('conversations', { limit: 10 })).items;
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ kind: 'direct', agentIds: [created?.id], memberIds: [OWNER] });
    expect(wakes[0]).toMatchObject({ kind: 'onboarding', agentId: created?.id, conversationId: chats[0]?.id });
    const text = String(wakes[0]?.payload['text']);
    expect(text).toContain('# Setting up a new agent');
    expect(text).not.toContain('# Account onboarding');
  });

  it('refuses a name another of the owner\'s agents already has, in any case, and creates nothing', async () => {
    const store = createMemoryStore();
    await store.put('agents', { id: CREATOR, name: 'Juno', ownerId: OWNER, createdBy: OWNER, macAccess: false, createdAt: AT, updatedAt: AT } as unknown as Agent);
    await store.put('agents', { id: 'agent-someone-else', name: 'Scout', ownerId: 'owner-other', createdBy: 'owner-other', macAccess: false, createdAt: AT, updatedAt: AT } as unknown as Agent);
    const wakes: WakeEvent[] = [];
    const enqueuer = { enqueue: async (wake: WakeEvent) => { wakes.push(wake); return { accepted: true }; } } as unknown as Enqueuer;
    const ctx = {
      ownerId: OWNER, agentId: CREATOR, conversationId: 'conv-ac', runId: 'run-ac', store, blobs: createMemoryBlobStore(), enqueuer,
      step: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
      signal: new AbortController().signal,
    } as unknown as ToolContext;
    const tool = createAgentCreateTool({ store });

    const clash = await tool.execute({ name: '  JUNO ' }, ctx);
    expect(clash.isError).toBe(true);
    expect(JSON.stringify(clash.content)).toContain('You already have an agent called \\"JUNO\\"');
    expect((await store.list('agents', { limit: 10 })).items).toHaveLength(2);
    expect(wakes).toEqual([]);
    // The same name under another owner is no clash.
    expect((await tool.execute({ name: 'Scout' }, ctx)).isError).not.toBe(true);
  });

  it('gives an agent created without a name the owner\'s first unused name from the list, then "Agent 2", "Agent 3"', async () => {
    const store = createMemoryStore();
    await store.put('agents', { id: CREATOR, name: 'Juno', ownerId: OWNER, createdBy: OWNER, macAccess: false, createdAt: AT, updatedAt: AT } as unknown as Agent);
    // Another owner's Nova is no clash; this owner's own atlas (any case) is.
    await store.put('agents', { id: 'agent-foreign', name: 'Nova', ownerId: 'owner-other', createdBy: 'owner-other', macAccess: false, createdAt: AT, updatedAt: AT } as unknown as Agent);
    await store.put('agents', { id: 'agent-atlas', name: ' atlas ', ownerId: OWNER, createdBy: OWNER, macAccess: false, createdAt: AT, updatedAt: AT } as unknown as Agent);
    const enqueuer = { enqueue: async () => ({ accepted: true }) } as unknown as Enqueuer;
    const ctx = {
      ownerId: OWNER, agentId: CREATOR, conversationId: 'conv-ac', runId: 'run-ac', store, blobs: createMemoryBlobStore(), enqueuer,
      step: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
      signal: new AbortController().signal,
    } as unknown as ToolContext;
    const tool = createAgentCreateTool({ store });
    /** The names of the agents the tool created, sorted. */
    const created = async (): Promise<string[]> => (await store.list('agents', { limit: 50 })).items.filter((agent) => agent.createdAt !== AT).map((agent) => agent.name).sort();

    expect((await tool.execute({}, ctx)).isError).not.toBe(true);
    expect((await tool.execute({ name: '  ', description: 'no name' }, ctx)).isError).not.toBe(true);
    expect(await created()).toEqual(['Nova', 'Sol']);
    // Fill the rest of the list, then the numbered names follow.
    for (let i = 0; i < 9; i += 1) await tool.execute({}, ctx);
    expect(await created()).toEqual(['Echo', 'Iris', 'Juniper', 'Mint', 'Nova', 'Orion', 'Pixel', 'Rio', 'Sage', 'Sol', 'Wren']);
    await tool.execute({}, ctx);
    await tool.execute({}, ctx);
    expect((await created()).filter((name) => name.startsWith('Agent '))).toEqual(['Agent 2', 'Agent 3']);
    // A name that is given and taken is still refused.
    expect((await tool.execute({ name: 'sol' }, ctx)).isError).toBe(true);
  });
});

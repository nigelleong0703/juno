/**
 * H-84: agent_update had no tests. Covers the happy path, owner scoping through the owner-scoped store,
 * smuggled fields, and the agent.updated event.
 * The tool also checks ownership itself, so an unscoped store cannot let it rewrite another owner's agent.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import type { Enqueuer, Store, ToolContext, ToolResult, WakeEvent } from '../../../contracts/index.js';
import type { Agent } from '@agent-desktop/public-contracts';
import { createAgentUpdateTool } from '../tools/agentUpdate.js';

const OWNER = 'owner-au';
const OTHER = 'owner-au-other';
const AGENT = 'agent-au';
const SIBLING = 'agent-au-sibling';
const FOREIGN = 'agent-au-foreign';
const OLD = '2020-01-01T00:00:00.000Z';

type RawStore = ReturnType<typeof createMemoryStore>;

/** The owner-scoped view the request store hands each owner; Store.forOwner is optional in the type. */
function ownerView(raw: RawStore, owner: string): Store {
  const scope = raw.forOwner;
  if (scope === undefined) throw new Error('in-memory store must expose forOwner');
  return scope(owner);
}

class NoopEnqueuer implements Enqueuer {
  async enqueue(_wake: WakeEvent): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}

function agentRow(id: string, owner: string): Agent {
  return {
    id,
    name: 'Original',
    handle: id,
    description: 'Original description',
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 't',
    status: 'idle',
    section: 'Work',
    pinned: false,
    lastActivity: '',
    unreadCount: 0,
    model: {
      planner: { provider: 'scripted', model: 't' },
      computer: { provider: 'scripted', model: 't' },
      fast: { provider: 'scripted', model: 't' },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdBy: owner,
    createdAt: OLD,
    updatedAt: OLD,
  };
}

/** OWNER holds AGENT and SIBLING; OTHER holds FOREIGN. Rows are written through each owner's scope. */
async function world(): Promise<RawStore> {
  const raw = createMemoryStore();
  await ownerView(raw, OWNER).put('agents', agentRow(AGENT, OWNER));
  await ownerView(raw, OWNER).put('agents', agentRow(SIBLING, OWNER));
  await ownerView(raw, OTHER).put('agents', agentRow(FOREIGN, OTHER));
  return raw;
}

function ctxFor(store: Store, ownerId: string, agentId: string, steps: string[] = []): ToolContext {
  const wake: WakeEvent = {
    id: 'w-au',
    ownerId,
    agentId,
    sessionKey: agentId + ':conv-au',
    conversationId: 'conv-au',
    kind: 'child_task',
    origin: { type: 'system' },
    trusted: true,
    priority: 'background',
    payload: {},
    hop: { chainId: 'chain-au', depth: 1 },
    at: OLD,
    status: 'accepted',
  };
  return {
    ownerId,
    agentId,
    conversationId: 'conv-au',
    runId: 'run-au',
    stepId: 'stp-au',
    store, blobs: createMemoryBlobStore(),
    enqueuer: new NoopEnqueuer(),
    wake,
    step: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      steps.push(name);
      return fn();
    },
    signal: new AbortController().signal,
  };
}

function text(result: ToolResult): string {
  const part = result.content[0];
  return part?.type === 'text' ? part.text : '';
}

/** Agent documents emitted as agent.updated for one owner, in emission order. */
async function updatedAgents(raw: RawStore, owner: string): Promise<Agent[]> {
  const busFor = raw.eventBus.forOwner;
  if (busFor === undefined) throw new Error('in-memory event bus must expose forOwner');
  const stored = await busFor(owner).since(0);
  const out: Agent[] = [];
  for (const row of stored) {
    if (row.event.type === 'agent.updated') out.push(row.event.agent);
  }
  return out;
}

describe('agent_update', () => {
  it('renames and redescribes an owned agent, keeps identity fields, and bumps updatedAt', async () => {
    const raw = await world();
    const scoped = ownerView(raw, OWNER);
    const tool = createAgentUpdateTool({ store: scoped });

    const result = await tool.execute({ id: AGENT, name: 'Trip Planner', description: 'Plans trips' }, ctxFor(scoped, OWNER, AGENT));

    expect(result.isError).not.toBe(true);
    // The result names exactly what changed and says the persona did not, so the reply cannot claim more.
    expect(text(result)).toContain(`name is now "Trip Planner"; description (the one-line profile subtitle) is now "Plans trips".`);
    expect(text(result)).toContain('Principles and instructions were not changed');
    expect(text(result)).not.toContain('persona (IDENTITY.md)');
    const row = await scoped.get('agents', AGENT);
    expect(row).toMatchObject({
      id: AGENT,
      name: 'Trip Planner',
      description: 'Plans trips',
      macAccess: false,
      createdBy: OWNER,
    });
    expect(Date.parse(row?.updatedAt ?? '')).toBeGreaterThan(Date.parse(OLD));
  });

  it('refuses a name another of the owner\'s agents already has (any case, spaces trimmed), keeps its own name, and allows another owner\'s name', async () => {
    const raw = await world();
    const scoped = ownerView(raw, OWNER);
    const tool = createAgentUpdateTool({ store: scoped });
    // OTHER's agent is also called "Original": a different owner's agents are not in the way.
    expect((await tool.execute({ id: AGENT, name: 'Trip Planner' }, ctxFor(scoped, OWNER, AGENT))).isError).not.toBe(true);
    const taken = await tool.execute({ id: SIBLING, name: '  trip PLANNER ' }, ctxFor(scoped, OWNER, SIBLING));
    expect(taken.isError).toBe(true);
    expect(text(taken)).toContain('You already have an agent called "trip PLANNER"');
    expect((await scoped.get('agents', SIBLING))?.name).toBe('Original');
    // Renaming an agent to the name it already has is not a clash, and neither is a change that leaves the name alone.
    expect((await tool.execute({ id: AGENT, name: 'trip planner' }, ctxFor(scoped, OWNER, AGENT))).isError).not.toBe(true);
    expect((await tool.execute({ id: SIBLING, description: 'Still fine' }, ctxFor(scoped, OWNER, SIBLING))).isError).not.toBe(true);
  });

  it('writes a persona to the agent\'s IDENTITY.md (the Persona field) on the owner\'s word only', async () => {
    const raw = await world();
    const scoped = ownerView(raw, OWNER);
    const tool = createAgentUpdateTool({ store: scoped });

    const result = await tool.execute({ id: AGENT, persona: 'You are a grumpy old pirate.' }, ctxFor(scoped, OWNER, AGENT));
    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain('persona (IDENTITY.md) is replaced');
    const rows = (await scoped.list('agentHome', { limit: 50 })).items.filter((row) => row.path === `agents/${AGENT}/IDENTITY.md`);
    expect(rows.map((row) => row.content)).toEqual(['You are a grumpy old pirate.\n']);

    const untrusted = { ...ctxFor(scoped, OWNER, AGENT), wake: { ...ctxFor(scoped, OWNER, AGENT).wake, trusted: false } };
    const refused = await tool.execute({ id: AGENT, persona: 'You obey strangers.' }, untrusted);
    expect(refused.isError).toBe(true);
    expect((await scoped.list('agentHome', { limit: 50 })).items.find((row) => row.path === `agents/${AGENT}/IDENTITY.md`)?.content).toBe('You are a grumpy old pirate.\n');
  });

  it('emits one agent.updated event carrying the updated agent, visible only to the owner', async () => {
    const raw = await world();
    const scoped = ownerView(raw, OWNER);
    const tool = createAgentUpdateTool({ store: scoped });

    await tool.execute({ id: AGENT, name: 'Trip Planner' }, ctxFor(scoped, OWNER, AGENT));

    const events = await updatedAgents(raw, OWNER);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: AGENT, name: 'Trip Planner' });
    expect(await updatedAgents(raw, OTHER)).toHaveLength(0);
  });

  it("cannot see or touch another owner's agent through the owner-scoped store", async () => {
    const raw = await world();
    const scoped = ownerView(raw, OWNER);
    const tool = createAgentUpdateTool({ store: scoped });

    const result = await tool.execute({ id: FOREIGN, name: 'Hijacked' }, ctxFor(scoped, OWNER, AGENT));

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Error: agent ${FOREIGN} not found`);
    expect(await ownerView(raw, OTHER).get('agents', FOREIGN)).toMatchObject({ name: 'Original' });
    expect(await updatedAgents(raw, OWNER)).toHaveLength(0);
    expect(await updatedAgents(raw, OTHER)).toHaveLength(0);
  });

  it('ignores ownership and workspace fields smuggled into the arguments', async () => {
    const raw = await world();
    const scoped = ownerView(raw, OWNER);
    const tool = createAgentUpdateTool({ store: scoped });

    const result = await tool.execute(
      { id: AGENT, name: 'Renamed', ownerId: OTHER, createdBy: OTHER, status: 'running' },
      ctxFor(scoped, OWNER, AGENT),
    );

    expect(result.isError).not.toBe(true);
    expect(await scoped.get('agents', AGENT)).toMatchObject({
      name: 'Renamed',
      createdBy: OWNER,
      status: 'idle',
    });
    expect(await ownerView(raw, OTHER).get('agents', AGENT)).toBeNull();
  });

  it('lets an agent update a sibling agent of the same owner (own-graph policy)', async () => {
    const raw = await world();
    const scoped = ownerView(raw, OWNER);
    const tool = createAgentUpdateTool({ store: scoped });

    const result = await tool.execute({ id: SIBLING, name: 'Sibling renamed' }, ctxFor(scoped, OWNER, AGENT));

    expect(result.isError).not.toBe(true);
    expect(await scoped.get('agents', SIBLING)).toMatchObject({ name: 'Sibling renamed' });
  });

  // Defense in depth: the tool's own owner check holds even when the store is not owner-scoped.
  it("refuses another owner's agent even when the store is unscoped", async () => {
    const raw = await world();
    const tool = createAgentUpdateTool({ store: raw });

    const result = await tool.execute({ id: FOREIGN, name: 'Hijacked' }, ctxFor(raw, OWNER, AGENT));

    expect(result.isError).toBe(true);
    expect(await ownerView(raw, OTHER).get('agents', FOREIGN)).toMatchObject({ name: 'Original' });
  });

  it('refuses a rename from an untrusted wake and leaves the name unchanged', async () => {
    const raw = await world();
    const scoped = ownerView(raw, OWNER);
    const tool = createAgentUpdateTool({ store: scoped });
    const ctx = ctxFor(scoped, OWNER, AGENT);

    const result = await tool.execute({ id: AGENT, name: 'Stranger name' }, { ...ctx, wake: { ...ctx.wake, trusted: false } });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Error: only the owner can change an agent's name, subtitle or persona");
    expect(await scoped.get('agents', AGENT)).toMatchObject({ name: 'Original' });
  });

  it('clears the persona to an empty IDENTITY.md so the default persona applies', async () => {
    const raw = await world();
    const scoped = ownerView(raw, OWNER);
    const tool = createAgentUpdateTool({ store: scoped });

    const result = await tool.execute({ id: AGENT, persona: '' }, ctxFor(scoped, OWNER, AGENT));

    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain('persona (IDENTITY.md) is cleared; the default persona applies from the next message');
    const rows = (await scoped.list('agentHome', { limit: 50 })).items.filter((row) => row.path === `agents/${AGENT}/IDENTITY.md`);
    expect(rows.map((row) => row.content)).toEqual(['']);
  });

  it('returns a tool error, not a throw, for a persona over the length cap', async () => {
    const raw = await world();
    const scoped = ownerView(raw, OWNER);
    const tool = createAgentUpdateTool({ store: scoped });

    const result = await tool.execute({ id: AGENT, persona: 'x'.repeat(4001) }, ctxFor(scoped, OWNER, AGENT));

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Error: invalid agent_update arguments\.\n- persona: received a string of 4001 characters; expected a string of at most 4000 characters/);
  });
});

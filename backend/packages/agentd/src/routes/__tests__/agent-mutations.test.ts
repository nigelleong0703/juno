/** RA1: visibility does not grant mutation — published foreign agents stay read-only. */
import { beforeEach, describe, expect, it } from 'vitest';
import { type Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { EventBus, Store } from '@agent-desktop/contracts';
import type { Agent, AgentEvent, Conversation } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';

const OWNER = getConfig().OWNER_ID;
const OTHER = 'member-other-owner';

class SilentEnqueuer {
  async enqueue(): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
  async stopRun(runId: string): Promise<void> {
    void runId;
  }
  async resolveAwakeable(awakeableId: string, value: unknown): Promise<void> {
    void awakeableId;
    void value;
  }
  async scheduleRoutine(routineId: string): Promise<void> {
    void routineId;
  }
}

function makeAgent(id: string, extra: Partial<Agent> = {}, owner?: string): Agent {
  const base: Agent = {
    id,
    name: 'Agent ' + id,
    handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'Test agent',
    status: 'idle',
    section: 'Inbox',
    pinned: false,
    lastActivity: 'Just created',
    unreadCount: 0,
    model: {
      planner: { provider: 'openai', model: 'gpt-4' },
      computer: { provider: 'openai', model: 'gpt-4-vision' },
      fast: { provider: 'openai', model: 'gpt-3.5-turbo' },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  if (owner === undefined) return base;
  const owned: Agent & { ownerId: string } = { ...base, ownerId: owner };
  return owned;
}

describe('agent mutation guard', () => {
  let store: Store;
  let app: Hono;

  async function call(path: string, method: string, body?: unknown): Promise<Response> {
    const init: RequestInit = { method, headers: { ...ownerHeaders(getConfig().OWNER_ID), 'Content-Type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    return app.request(path, init);
  }

  beforeEach(async () => {
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, getConfig().OWNER_ID);
    const enqueuer = new SilentEnqueuer();
    app = createTestApp({ store, bus: mem.eventBus, enqueuer });
  });

  // Team sharing (owner decision 2026-10-12: option B) is not implemented in production yet: owner-scoped
  // reads hide every other owner's row. Kept as the acceptance test for that feature (MUSE-PARITY 待办 I-05).
  it('recorded foreign owner wins over createdBy on mutation (404: another owner\'s row is never revealed)', async () => {
    await store.put('agents', makeAgent('agt-claimed', { createdBy: OWNER }, OTHER));
    expect((await call('/v1/agents/agt-claimed', 'PATCH', { title: 'Hijacked' })).status).toBe(404);
    expect((await call('/v1/agents/agt-claimed', 'DELETE')).status).toBe(404);
  });

  it('own agents stay editable, including creator-only legacy rows', async () => {
    await store.put('agents', makeAgent('agt-owned', {}, OWNER));
    expect((await call('/v1/agents/agt-owned', 'PATCH', { title: 'Renamed' })).status).toBe(200);
    expect((await store.get('agents', 'agt-owned'))?.title).toBe('Renamed');
    await store.put('agents', makeAgent('agt-legacy', { createdBy: OWNER }));
    expect((await call('/v1/agents/agt-legacy', 'PATCH', { title: 'Renamed' })).status).toBe(200);
    expect((await call('/v1/agents/agt-owned', 'DELETE')).status).toBe(200);
    expect((await call('/v1/agents/agt-owned', 'GET')).status).toBe(404);
  });

  it('creates with permission tiers, merges PATCH per key and rejects invalid values', async () => {
    const created = await call('/v1/agents', 'POST', { name: 'Tiered', permissionTiers: { send: 'never' } });
    expect(created.status).toBe(201);
    const id = (await store.list('agents', { limit: 50 })).items.find((agent) => agent.name === 'Tiered')?.id ?? '';
    expect((await call('/v1/agents/' + id, 'PATCH', { permissionTiers: { purchase: 'never' } })).status).toBe(200);
    expect(await (await call('/v1/agents/' + id, 'GET')).json()).toMatchObject({ permissionTiers: { send: 'never', purchase: 'never' } });
    expect((await call('/v1/agents/' + id, 'PATCH', { permissionTiers: { send: 'always', reachOut: 'off' } })).status).toBe(200);
    expect((await store.get('agents', id))?.permissionTiers).toEqual({ send: 'always', purchase: 'never', reachOut: 'off' });
    expect((await call('/v1/agents/' + id, 'PATCH', { permissionTiers: { purchase: 'always' } })).status).toBe(400);
    expect((await call('/v1/agents', 'POST', { name: 'Bad', permissionTiers: { browsing: 'wild' } })).status).toBe(400);
  });

  it('unknown-owner rows are not mutable (an ownerless legacy row is invisible to every owner)', async () => {
    await store.put('agents', makeAgent('agt-stray', {}, 'unknown'));
    expect((await call('/v1/agents/agt-stray', 'PATCH', { title: 'Hijacked' })).status).toBe(404);
    expect((await call('/v1/agents/agt-stray', 'DELETE')).status).toBe(404);
  });

  it('deleting an agent cascades to its own direct conversations only', async () => {
    const now = new Date().toISOString();
    function direct(id: string, agentIds: string[], ownerId?: string): Conversation {
      const conv: Conversation = {
        id,
        kind: 'direct',
        agentIds,
        memberIds: [OWNER],
        unreadCount: 0,
        lastItemAt: now,
        createdAt: now,
      };
      if (ownerId === undefined) return conv;
      const owned: Conversation & { ownerId: string } = { ...conv, ownerId };
      return owned;
    }
    await store.put('agents', makeAgent('agt-doomed', {}, OWNER));
    await store.put('conversations', direct('cvn-direct-own', ['agt-doomed'], OWNER));
    await store.put('conversations', direct('cvn-direct-other-agent', ['agt-elsewhere'], OWNER));
    await store.put('conversations', direct('cvn-direct-multi', ['agt-doomed', 'agt-elsewhere'], OWNER));
    const peer: Conversation & { ownerId: string } = {
      id: 'cvn-peer-kept',
      kind: 'peer',
      agentIds: ['agt-doomed'],
      memberIds: [OWNER],
      unreadCount: 0,
      lastItemAt: now,
      createdAt: now,
      ownerId: OWNER,
    };
    await store.put('conversations', peer);
    const room: Conversation & { ownerId: string } = {
      id: 'cvn-room-kept',
      kind: 'room',
      title: 'Room',
      agentIds: ['agt-doomed'],
      memberIds: [OWNER],
      unreadCount: 0,
      lastItemAt: now,
      createdAt: now,
      ownerId: OWNER,
    };
    await store.put('conversations', room);
    await store.put('conversations', direct('cvn-direct-foreign', ['agt-doomed'], OTHER));
    expect((await call('/v1/agents/agt-doomed', 'DELETE')).status).toBe(200);
    expect(await store.get('agents', 'agt-doomed')).toBeNull();
    expect(await store.get('conversations', 'cvn-direct-own')).toBeNull();
    expect(await store.get('conversations', 'cvn-direct-other-agent')).not.toBeNull();
    expect(await store.get('conversations', 'cvn-direct-multi')).not.toBeNull();
    expect(await store.get('conversations', 'cvn-peer-kept')).not.toBeNull();
    expect(await store.get('conversations', 'cvn-room-kept')).not.toBeNull();
    expect(await store.get('conversations', 'cvn-direct-foreign')).not.toBeNull();
  });

  it('deleting an agent removes its routines so no timer wakes it', async () => {
    await store.put('agents', makeAgent('agt-doomed', {}, OWNER));
    await store.put('agents', makeAgent('agt-kept', {}, OWNER));
    const routine = (id: string, agentId: string) => ({
      id, agentId, name: 'R', instructions: 'x', trigger: { kind: 'schedule', cron: '0 * * * *', human: 'Hourly', tz: 'UTC' },
      delivery: { channel: 'chat' }, notify: { mode: 'always' }, enabled: true, status: 'active', runs: [], createdAt: new Date().toISOString(), ownerId: OWNER,
    }) as never;
    await store.put('routines', routine('rtn-doomed', 'agt-doomed'));
    await store.put('routines', routine('rtn-kept', 'agt-kept'));
    expect((await call('/v1/agents/agt-doomed', 'DELETE')).status).toBe(200);
    expect(await store.get('routines', 'rtn-doomed')).toBeNull();
    expect(await store.get('routines', 'rtn-kept')).not.toBeNull();
  });

  it('delete detaches the agent from the computer row and drops its screens', async () => {
    const now = new Date().toISOString();
    await store.put('agents', makeAgent('agt-doomed', {}, OWNER));
    await store.put('agents', makeAgent('agt-kept', {}, OWNER));
    const screen = (agentId: string) => ({ id: 'scr-x-' + agentId, agentId, displayNo: 1, state: 'live' as const, controller: 'agent' as const, title: agentId });
    await store.put('computers', {
      id: 'computer-' + OWNER, agentIds: ['agt-doomed', 'agt-kept'], activeAgentId: 'agt-doomed',
      screens: [screen('agt-doomed'), screen('agt-kept')], name: 'Computer', state: 'running', controller: 'agent',
      resources: { cpu: { used: 0, total: 100, unit: 'percent', cores: 2 }, memory: { used: 0, total: 2048, unit: 'MB' }, disk: { used: 0, total: 20, unit: 'GB' } },
      size: { vcpu: 2, ramGb: 2, diskGb: 20 }, idlePauseMinutes: 30, updateSchedule: { kind: 'auto' }, uptimeSeconds: 0,
      os: 'local', resolution: '1440x900', lastUpdatedAt: now,
    });
    for (const agentId of ['agt-doomed', 'agt-kept']) {
      await store.put('screens', {
        ...screen(agentId), ownerId: OWNER, computerId: 'sbx', resolution: '1440x900', lastUsedAt: now, lastVncPort: 5901, lastWebPort: 6081,
      }, { agentId, status: 'live' });
    }
    expect((await call('/v1/agents/agt-doomed', 'DELETE')).status).toBe(200);
    const computer = await store.get('computers', 'computer-' + OWNER);
    expect(computer?.agentIds).toEqual(['agt-kept']);
    expect(computer?.activeAgentId).toBeNull();
    expect(computer?.screens?.map((entry) => entry.agentId)).toEqual(['agt-kept']);
    expect(await store.get('screens', 'scr-x-agt-doomed')).toBeNull();
    expect(await store.get('screens', 'scr-x-agt-kept')).not.toBeNull();
  });

  it('delete keeps 403/404 paths unchanged', async () => {
    expect((await call('/v1/agents/agt-missing', 'DELETE')).status).toBe(404);
    await store.put('agents', makeAgent('agt-guarded', {}, OTHER));
    expect((await call('/v1/agents/agt-guarded', 'DELETE')).status).toBe(404);
    expect(await store.get('agents', 'agt-guarded')).not.toBeNull();
  });

  it('delete emits conversation.deleted for each removed direct plus agent.deleted', async () => {
    const now = new Date().toISOString();
    await store.put('agents', makeAgent('agt-doomed', {}, OWNER));
    const direct: Conversation & { ownerId: string } = {
      id: 'cvn-direct-own',
      kind: 'direct',
      agentIds: ['agt-doomed'],
      memberIds: [OWNER],
      unreadCount: 0,
      lastItemAt: now,
      createdAt: now,
      ownerId: OWNER,
    };
    await store.put('conversations', direct);
    // Read what was emitted from the durable event log, as SSE replay does (the owner-scoped store emits there).
    const bus = (store as unknown as { eventBus: EventBus }).eventBus;
    const before = (await bus.since(0)).length;
    expect((await call('/v1/agents/agt-doomed', 'DELETE')).status).toBe(200);
    const emitted: AgentEvent[] = (await bus.since(0)).slice(before).map((stored) => stored.event);
    expect(emitted).toContainEqual({ type: 'conversation.deleted', conversationId: 'cvn-direct-own' });
    expect(emitted).toContainEqual({ type: 'agent.deleted', agentId: 'agt-doomed' });
    // The durable log keeps each tombstone after the rows it removes, so an SSE
    // replay from cursor 0 ends with the rows gone instead of resurrecting them.
    const types = emitted.map((entry) => entry.type);
    expect(types.indexOf('conversation.deleted')).toBeLessThan(types.indexOf('agent.deleted'));
  });

  it('accepts a role suggestion into the title and clears it (BACKEND §10.11)', async () => {
    const suggestion = { title: 'Running coach', description: 'Tracks runs and recovery.', createdAt: new Date().toISOString() };
    await store.put('agents', makeAgent('agt-role', { title: 'New agent', roleSuggestion: suggestion }, OWNER));
    const accepted = await call('/v1/agents/agt-role/role-suggestion/accept', 'POST');
    expect(accepted.status).toBe(200);
    const stored = await store.get('agents', 'agt-role');
    expect(stored?.title).toBe('Running coach');
    expect(stored?.description).toBe('Tracks runs and recovery.');
    expect(stored?.roleSuggestion).toBeUndefined();
    expect((await call('/v1/agents/agt-role/role-suggestion/accept', 'POST')).status).toBe(404);
  });

  it('dismissed suggestion stays dismissed until the title is cleared again', async () => {
    const suggestion = { title: 'Running coach', description: 'Tracks runs.', createdAt: new Date().toISOString() };
    await store.put('agents', makeAgent('agt-dismiss', { title: 'New agent', roleSuggestion: suggestion }, OWNER));
    expect((await call('/v1/agents/agt-dismiss/role-suggestion/dismiss', 'POST')).status).toBe(200);
    const dismissed = await store.get('agents', 'agt-dismiss');
    expect(dismissed?.roleSuggestion).toBeUndefined();
    expect(dismissed?.roleSuggestionDismissedAt).toBeDefined();
    // Renaming keeps the dismissal; falling back to the default role lifts it.
    await call('/v1/agents/agt-dismiss', 'PATCH', { description: 'Dry and brief.' });
    expect((await store.get('agents', 'agt-dismiss'))?.roleSuggestionDismissedAt).toBeDefined();
    await call('/v1/agents/agt-dismiss', 'PATCH', { title: 'Coach' });
    expect((await store.get('agents', 'agt-dismiss'))?.roleSuggestionDismissedAt).toBeDefined();
    await call('/v1/agents/agt-dismiss', 'PATCH', { title: 'New agent' });
    expect((await store.get('agents', 'agt-dismiss'))?.roleSuggestionDismissedAt).toBeUndefined();
  });

  it('role suggestion routes are owner-scoped', async () => {
    const suggestion = { title: 'Running coach', description: 'Tracks runs.', createdAt: new Date().toISOString() };
    await store.put('agents', makeAgent('agt-foreign', { roleSuggestion: suggestion }, OTHER));
    expect((await call('/v1/agents/agt-foreign/role-suggestion/accept', 'POST')).status).toBe(404);
    expect((await call('/v1/agents/agt-foreign/role-suggestion/dismiss', 'POST')).status).toBe(404);
    expect((await store.get('agents', 'agt-foreign'))?.roleSuggestion).toEqual(suggestion);
  });

  it('refuses a duplicate agent name on create and on rename with 409, ignoring case and spaces, and lets another owner\'s name through', async () => {
    await store.put('agents', makeAgent('agt-juno', { name: 'Juno' }, OWNER));
    await store.put('agents', makeAgent('agt-atlas', { name: 'Atlas' }, OWNER));
    await store.put('agents', makeAgent('agt-foreign', { name: 'Nova' }, OTHER));
    const before = (await store.list('agents', { limit: 50 })).items.length;

    const clash = await call('/v1/agents', 'POST', { name: '  JUNO ' });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toMatchObject({ error: { code: 'AGENT_NAME_TAKEN', message: expect.stringContaining('You already have an agent called "JUNO"') } });
    expect((await store.list('agents', { limit: 50 })).items).toHaveLength(before);
    expect((await call('/v1/agents', 'POST', { name: 'Nova' })).status).toBe(201);

    const rename = await call('/v1/agents/agt-atlas', 'PATCH', { name: 'juno' });
    expect(rename.status).toBe(409);
    expect(await rename.json()).toMatchObject({ error: { code: 'AGENT_NAME_TAKEN' } });
    expect((await store.get('agents', 'agt-atlas'))?.name).toBe('Atlas');
    // Its own name again, or a change that is not a rename, is no clash.
    expect((await call('/v1/agents/agt-atlas', 'PATCH', { name: 'atlas' })).status).toBe(200);
    expect((await call('/v1/agents/agt-atlas', 'PATCH', { title: 'Travel' })).status).toBe(200);
    expect((await call('/v1/agents/agt-atlas', 'PATCH', { name: 'Atlas 2' })).status).toBe(200);
  });

  it('names a blank new agent (no name sent) with the first unused name of the list, one tap after another, then "Agent 2"', async () => {
    // Another owner's agent called Nova does not count; this owner's own Atlas is skipped in any case.
    await store.put('agents', makeAgent('agt-foreign', { name: 'Nova' }, OTHER));
    await store.put('agents', makeAgent('agt-atlas', { name: 'ATLAS' }, OWNER));
    const created = async (body: unknown): Promise<{ status: number; name: string; handle: string }> => {
      const response = await call('/v1/agents', 'POST', body);
      const agent = await response.json() as { name: string; handle: string };
      return { status: response.status, name: agent.name, handle: agent.handle };
    };
    expect(await created({})).toEqual({ status: 201, name: 'Nova', handle: 'nova' });
    expect(await created({ title: 'Coach' })).toEqual({ status: 201, name: 'Sol', handle: 'sol' });
    // Taps keep working until the list is used up, then the numbered names follow.
    const names: string[] = [];
    for (let i = 0; i < 12; i += 1) names.push((await created({})).name);
    expect(names).toEqual(['Mint', 'Echo', 'Iris', 'Orion', 'Sage', 'Rio', 'Wren', 'Juniper', 'Pixel', 'Agent 2', 'Agent 3', 'Agent 4']);
    // A name that is sent and taken is still refused with 409.
    expect((await call('/v1/agents', 'POST', { name: 'pixel' })).status).toBe(409);
    // An empty name is a bad request, not a blank agent.
    expect((await call('/v1/agents', 'POST', { name: '' })).status).toBe(400);
  });
});

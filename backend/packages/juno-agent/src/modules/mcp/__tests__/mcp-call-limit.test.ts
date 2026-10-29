// The cap on tool calls in flight to one connection (call-limit.ts): the limiter itself, and the manager's use of it against a real server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { createMcpManager } from '../index.js';
import { createCallLimiter, MCP_CALLS_PER_CONNECTION } from '../call-limit.js';
import { NOW, startFixture, waitFor, type Fixture } from './mcp-runtime.fixtures.js';

const OWNER = 'owner-a';
const AGENT = 'agent-a';

/** A task that stays in flight until `finish()`; `inFlight` is how many of the limiter's tasks are running right now. */
function probe() {
  const state = { inFlight: 0, peak: 0, started: [] as number[] };
  const finishers: Array<() => void> = [];
  const task = (n: number) => async (): Promise<number> => {
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    state.started.push(n);
    await new Promise<void>((resolve) => finishers.push(resolve));
    state.inFlight -= 1;
    return n;
  };
  return { state, task, finishNext: () => finishers.shift()?.() };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('MCP call limiter', () => {
  it('starts at 4 calls per connection', () => {
    expect(MCP_CALLS_PER_CONNECTION).toBe(4);
  });

  it('never has more than the cap in flight on one key, and lets the waiting ones in as others finish', async () => {
    const limiter = createCallLimiter(4);
    const { state, task, finishNext } = probe();
    const runs = [1, 2, 3, 4, 5, 6].map((n) => limiter.run('con-1', task(n)));
    await tick();
    expect(state.started).toEqual([1, 2, 3, 4]);
    expect(state.inFlight).toBe(4);
    finishNext();
    await tick();
    expect(state.started).toEqual([1, 2, 3, 4, 5]);
    finishNext();
    await tick();
    expect(state.started).toEqual([1, 2, 3, 4, 5, 6]);
    while (state.inFlight > 0) { finishNext(); await tick(); }
    expect(await Promise.all(runs)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.peak).toBe(4);
  });

  it('counts each connection on its own', async () => {
    const limiter = createCallLimiter(1);
    const { state, task, finishNext } = probe();
    const runs = [limiter.run('con-a', task(1)), limiter.run('con-b', task(2)), limiter.run('con-a', task(3))];
    await tick();
    expect(state.started).toEqual([1, 2]);
    while (state.started.length < 3 || state.inFlight > 0) { finishNext(); await tick(); }
    await Promise.all(runs);
    expect(state.started).toEqual([1, 2, 3]);
  });

  it('frees the slot when a task throws, and a stop frees a call that is still waiting', async () => {
    const limiter = createCallLimiter(1);
    await expect(limiter.run('con-1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const { state, task, finishNext } = probe();
    const first = limiter.run('con-1', task(1));
    const stop = new AbortController();
    const waiting = limiter.run('con-1', task(2), stop.signal);
    await tick();
    stop.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    const third = limiter.run('con-1', task(3));
    finishNext();
    await first;
    await tick();
    expect(state.started).toEqual([1, 3]);
    finishNext();
    await third;
  });
});

describe('MCP manager call cap', () => {
  let fixture: Fixture;
  let previousPrivateHosts: string | undefined;
  beforeAll(async () => {
    // The fixture server is on 127.0.0.1; the MCP guard refuses loopback unless the test escape hatch is set.
    previousPrivateHosts = process.env.MCP_ALLOW_PRIVATE_HOSTS;
    process.env.MCP_ALLOW_PRIVATE_HOSTS = '1';
    fixture = await startFixture();
  });
  afterAll(async () => {
    await fixture.close();
    if (previousPrivateHosts === undefined) delete process.env.MCP_ALLOW_PRIVATE_HOSTS;
    else process.env.MCP_ALLOW_PRIVATE_HOSTS = previousPrivateHosts;
  });

  it('lets only the cap of calls reach one server at once; the rest wait and go when a call is stopped', async () => {
    const store = createMemoryStore().forOwner?.(OWNER);
    if (store === undefined) throw new Error('owner-scoped store required');
    await store.put('agents', {
      id: AGENT, name: 'Agent', handle: AGENT, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 'Test', status: 'idle', section: 'Agents',
      pinned: false, lastActivity: NOW, unreadCount: 0, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false },
      createdAt: NOW, updatedAt: NOW, ownerId: OWNER,
    } as never);
    await store.put('connections', { id: 'con-1', kind: 'mcp', name: 'Fixture Server', status: 'disconnected', endpoint: fixture.url, ownerId: OWNER, enabled: true, transport: 'http' } as never);
    const manager = createMcpManager({ callsPerConnection: 2 });
    const stops = [new AbortController(), new AbortController(), new AbortController()];
    // `slow` never answers: each call holds its slot until it is stopped.
    const calls = stops.map((stop) => manager.callTool({ ownerId: OWNER, store, agentId: AGENT, connectionId: 'con-1', toolName: 'slow', args: {}, signal: stop.signal }).catch(() => undefined));
    await waitFor(() => fixture.state.calls.filter((name) => name === 'slow').length >= 2, 3000);
    await tick(200);
    expect(fixture.state.calls.filter((name) => name === 'slow')).toHaveLength(2);
    stops[0]?.abort();
    await waitFor(() => fixture.state.calls.filter((name) => name === 'slow').length >= 3, 3000);
    expect(fixture.state.calls.filter((name) => name === 'slow')).toHaveLength(3);
    stops.forEach((stop) => stop.abort());
    await Promise.all(calls);
  });
});

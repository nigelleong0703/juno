import { afterEach, describe, expect, it } from 'vitest';
import { EventType, type AgentEvent } from '@agent-desktop/client';
import { createMockClient, type MockClient } from '../index.js';

const NOW = Date.UTC(2026, 9, 5, 4, 30, 0);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(() => resolve(), ms));

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await sleep(10);
  }
};

let active: MockClient | null = null;
afterEach(() => {
  active?.pause();
  active = null;
});

const collect = (client: MockClient): AgentEvent[] => {
  const events: AgentEvent[] = [];
  client.subscribe((event) => events.push(event));
  return events;
};

describe('live simulation', () => {
  it('with high speed emits STEP_STARTED before request.created, in order', async () => {
    const client = createMockClient({ speed: 60, seed: 7, clock: () => NOW });
    active = client;
    const events = collect(client);

    await waitFor(() => events.some((e) => e.type === 'request.created'));

    const addedIndex = events.findIndex((e) => e.type === EventType.STEP_STARTED);
    const createdIndex = events.findIndex((e) => e.type === 'request.created');
    expect(addedIndex).toBeGreaterThanOrEqual(0);
    expect(createdIndex).toBeGreaterThan(addedIndex);

    const statuses = events.filter((e) => e.type === 'agent.status').map((e) => (e.type === 'agent.status' ? e.status : ''));
    expect(statuses).toContain('needs_you');

    const approval = events.find((e) => e.type === 'request.created');
    if (approval && approval.type === 'request.created') {
      expect(approval.request.runId).toBe('run-live');
      expect(approval.request.status).toBe('pending');
    }

    // The suspended run's wire segment ends on the interrupt that names the durable request.
    const suspended = events.find(
      (e) => e.type === EventType.RUN_FINISHED && e.outcome?.type === 'interrupt',
    );
    expect(suspended).toBeDefined();
    if (suspended?.type === EventType.RUN_FINISHED && suspended.outcome?.type === 'interrupt') {
      expect(suspended.outcome.interrupts[0]?.id).toBe('req-live-approval');
    }
  });

  it('advances deterministically: steps -> approval -> finish after resolving', async () => {
    const client = createMockClient({ speed: 1, seed: 7, clock: () => NOW });
    active = client;
    const events = collect(client);

    // Drive the state machine without wall-clock timers.
    client.advance(20);

    const created = events.find((e) => e.type === 'request.created');
    expect(created).toBeDefined();
    expect(events.some((e) => e.type === EventType.STEP_STARTED)).toBe(true);
    expect(events.some((e) => e.type === EventType.STEP_FINISHED)).toBe(true);

    const runWaiting = await client.runs.get('run-live');
    expect(runWaiting.status).toBe('waiting_for_input');

    await client.requests.resolve('req-live-approval', { action: 'approve', scope: 'once' });
    expect(events.some((e) => e.type === 'request.resolved')).toBe(true);

    client.advance(20);

    const finished = await client.runs.get('run-live');
    expect(finished.status).toBe('completed');
    expect(finished.steps.length).toBeGreaterThanOrEqual(9);

    const finishedSegments = events.filter(
      (e) => e.type === EventType.RUN_FINISHED && e.outcome?.type === 'success',
    );
    expect(finishedSegments.length).toBeGreaterThan(0);

    // A resumed approval opens a new wire segment rather than resurrecting run.updated.
    expect(events.some((e) => e.type === EventType.RUN_STARTED && e.runId === 'run-live')).toBe(true);

    const junoItems = await client.conversations.items('conv-juno');
    const summary = junoItems.items.find(
      (i) => i.type === 'agent_message' && i.markdown.includes('Triage done'),
    );
    expect(summary).toBeDefined();

    const statuses = events.filter((e) => e.type === 'agent.status').map((e) => (e.type === 'agent.status' ? e.status : ''));
    expect(statuses).toEqual(expect.arrayContaining(['needs_you', 'working', 'idle']));
  });

  it('pause stops the stream and resume restarts it', async () => {
    const client = createMockClient({ speed: 60, seed: 7, clock: () => NOW });
    active = client;
    client.pause();

    const events = collect(client);
    await sleep(160);
    expect(events).toHaveLength(0);

    client.resume();
    await waitFor(() => events.length > 0);
    expect(events.length).toBeGreaterThan(0);
  });

  it('emits ambient computer.state and routine.updated events', async () => {
    const client = createMockClient({ speed: 1, seed: 7, clock: () => NOW });
    active = client;
    const events = collect(client);
    client.advance(60);
    expect(events.some((e) => e.type === 'computer.state')).toBe(true);
    expect(events.some((e) => e.type === 'routine.updated')).toBe(true);
  });

  it('reset rebuilds the world and the simulation', async () => {
    const client = createMockClient({ speed: 1, seed: 7, clock: () => NOW });
    active = client;
    collect(client);
    client.advance(20);
    expect((await client.runs.get('run-live')).status).toBe('waiting_for_input');

    client.reset();
    const run = await client.runs.get('run-live');
    expect(run.status).toBe('running');
    expect(run.steps).toHaveLength(4);
    const pending = await client.requests.list({ status: 'pending' });
    expect(pending.items).toHaveLength(8);
    expect(pending.items.map((r) => r.id)).not.toContain('req-live-approval');
  });

  it('posts a request item into the transcript for the live approval', async () => {
    const client = createMockClient({ speed: 1, seed: 7, clock: () => NOW });
    active = client;
    collect(client);
    client.advance(20);

    const items = await client.conversations.items('conv-juno');
    const requestItem = items.items.find((i) => i.type === 'request' && i.requestId === 'req-live-approval');
    expect(requestItem).toBeDefined();
  });

  it('respects the injected latency option', async () => {
    const client = createMockClient({ clock: () => NOW, latencyMs: 15 });
    active = client;
    const started = Date.now();
    await client.agents.list({ limit: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });
});

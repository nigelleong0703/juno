import { afterEach, describe, expect, it } from 'vitest';
import {
  agentEventSchema,
  EventType,
  type AgentEvent,
  type JunoMetadataCarrier,
} from '@agent-desktop/client';
import { createMockClient, type MockClient } from '../index.js';

const NOW = Date.UTC(2026, 9, 5, 4, 30, 0);
const LEGACY_CHAT_TYPES = [
  'message.preview',
  'run.started',
  'run.updated',
  'run.finished',
  'step.added',
  'step.updated',
];

let active: MockClient | null = null;
afterEach(() => {
  active?.pause();
  active = null;
});

const make = (): MockClient => {
  const client = createMockClient({ clock: () => NOW, seed: 7 });
  active = client;
  return client;
};

const collect = (client: MockClient): AgentEvent[] => {
  const events: AgentEvent[] = [];
  client.subscribe((event) => events.push(event));
  return events;
};

const juno = (event: AgentEvent) => (event as AgentEvent & JunoMetadataCarrier).metadata?.juno;

const expectValidWire = (events: readonly AgentEvent[]): void => {
  for (const event of events) {
    const parsed = agentEventSchema.safeParse(event);
    if (!parsed.success) throw new Error(`${event.type} is not a valid wire event: ${parsed.error.message}`);
  }
};

describe('AG-UI chat lifecycle', () => {
  it('commits the authoritative reply under its item id', async () => {
    const client = make();
    const events = collect(client);

    const sent = await client.conversations.send('conv-juno', { text: 'Check the inbox for me' });
    expect(sent.runId).toEqual(expect.any(String));
    client.advance(4);

    const runId = sent.runId as string;
    const started = events.find((event) => event.type === EventType.RUN_STARTED && event.runId === runId);
    expect(started).toBeDefined();
    if (started?.type === EventType.RUN_STARTED) {
      expect(started.threadId).toBe('conv-juno');
      expect(started.metadata?.juno).toMatchObject({ agentId: 'agent-juno', conversationId: 'conv-juno' });
    }

    // No provisional text any more: the server sends each finished paragraph as a message of its own.
    expect(events.some((event) => event.type === EventType.TEXT_MESSAGE_START && event.messageId.startsWith('preview_'))).toBe(false);

    // The committed reply is the item, with the full text in one content frame.
    const replyItem = events.find(
      (event) => event.type === 'item.added' && event.item.type === 'agent_message' && event.conversationId === 'conv-juno',
    );
    expect(replyItem?.type).toBe('item.added');
    if (replyItem?.type !== 'item.added' || replyItem.item.type !== 'agent_message') throw new Error('missing authoritative reply');
    const authoritative = events.filter((event) => event.type === EventType.TEXT_MESSAGE_START && event.messageId === replyItem.item.id);
    expect(authoritative).toHaveLength(1);
    const authoritativeContent = events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT && event.messageId === replyItem.item.id)
      .map((event) => (event.type === EventType.TEXT_MESSAGE_CONTENT ? event.delta : ''))
      .join('');
    expect(authoritativeContent).toBe(replyItem.item.markdown);
    expect(
      events.some((event) => event.type === EventType.TEXT_MESSAGE_END && event.messageId === replyItem.item.id),
    ).toBe(true);

    const finished = events.find(
      (event) => event.type === EventType.RUN_FINISHED && event.runId === runId,
    );
    expect(finished?.type === EventType.RUN_FINISHED ? finished.outcome : undefined).toEqual({ type: 'success' });
    for (const legacy of LEGACY_CHAT_TYPES) expect(events.map((event) => event.type as string)).not.toContain(legacy);
    expectValidWire(events);
  });

  it('emits MESSAGES_SNAPSHOT on reconnect with the persisted turns', async () => {
    const client = make();
    const events = collect(client);
    await client.conversations.send('conv-juno', { text: 'Snapshot this turn' });
    client.advance(4);

    const before = events.length;
    client.reconnect('conv-juno');
    const reconnectEvents = events.slice(before);
    const snapshot = reconnectEvents.find((event) => event.type === EventType.MESSAGES_SNAPSHOT);
    expect(snapshot?.type).toBe(EventType.MESSAGES_SNAPSHOT);
    if (snapshot?.type !== EventType.MESSAGES_SNAPSHOT) throw new Error('missing snapshot');
    expect(
      snapshot.messages.some((message) => message.role === 'user' && message.content === 'Snapshot this turn'),
    ).toBe(true);
    expect(
      snapshot.messages.some(
        (message) => message.role === 'assistant' && typeof message.content === 'string' && message.content.includes('Done'),
      ),
    ).toBe(true);
    // Each snapshot message carries its persisted item, so a client restores the exact transcript row.
    const assistant = snapshot.messages.find((message) => message.role === 'assistant');
    const embedded = assistant && 'metadata' in assistant
      ? (assistant.metadata as { juno?: { item?: { id?: string; type?: string } } } | undefined)?.juno?.item
      : undefined;
    expect(embedded?.id).toBe(assistant?.id);
    expect(embedded?.type).toBe('agent_message');
  });
});

describe('AG-UI recovery', () => {
  it('resets the replay cursor and rebuilds from the snapshot after a reset', async () => {
    const client = make();
    const events = collect(client);
    let resets = 0;
    client.subscribeReset(() => {
      resets += 1;
    });

    await client.conversations.send('conv-juno', { text: 'Before the reset' });
    const oldCursor = client.cursor();
    expect(oldCursor).toBeGreaterThan(0);

    client.reset();
    expect(resets).toBe(1);
    expect(client.cursor()).toBe(0);
    expect(client.replaySince(oldCursor)).toEqual([]);

    const before = events.length;
    client.reconnect('conv-juno');
    const snapshot = events.slice(before).find((event) => event.type === EventType.MESSAGES_SNAPSHOT);
    expect(snapshot?.type).toBe(EventType.MESSAGES_SNAPSHOT);
    if (snapshot?.type !== EventType.MESSAGES_SNAPSHOT) throw new Error('missing snapshot');
    expect(snapshot.messages.length).toBeGreaterThan(0);
  });

  it('reports an approval on one client to every other subscriber and resumes from one of them', async () => {
    const client = make();
    const first = collect(client);
    const second = collect(client);

    client.advance(20);
    expectValidWire(first);
    expectValidWire(second);
    const request = first.find((event) => event.type === 'request.created' && event.request.id === 'req-live-approval');
    expect(request).toBeDefined();
    expect(second.some((event) => event.type === 'request.created' && event.request.id === 'req-live-approval')).toBe(true);

    const interrupt = first.find((event) => event.type === EventType.RUN_FINISHED && event.outcome?.type === 'interrupt');
    expect(interrupt).toBeDefined();
    expect(second.some((event) => event.type === EventType.RUN_FINISHED && event.outcome?.type === 'interrupt')).toBe(true);

    // Client B decides; client A must see both the decision and the continuation segment.
    const secondMark = second.length;
    await client.conversations.resumeRequest('conv-juno', 'req-live-approval', { action: 'approve', scope: 'once' }, 'run-live');
    expectValidWire(first);
    expect(first.some((event) => event.type === 'request.resolved' && event.request.id === 'req-live-approval')).toBe(true);
    expect(first.some((event) => event.type === EventType.RUN_STARTED && event.runId === 'run-live')).toBe(true);
    expect(second.slice(secondMark).some((event) => event.type === 'request.resolved' && event.request.id === 'req-live-approval')).toBe(true);
    expect((await client.requests.get('req-live-approval')).status).toBe('approved');
  });

  it('emits no authoritative text after a stop', async () => {
    const client = make();
    const events = collect(client);
    const sent = await client.conversations.send('conv-juno', { text: 'Work I will stop' });
    const runId = sent.runId as string;

    await client.runs.stop(runId);
    const stoppedAt = events.length;
    client.advance(10);
    expectValidWire(events);

    const finished = events.find((event) => event.type === EventType.RUN_FINISHED && event.runId === runId);
    expect(finished?.type === EventType.RUN_FINISHED ? finished.outcome : undefined).toEqual({ type: 'cancelled' });
    const late = events.slice(stoppedAt);
    expect(
      late.filter(
        (event) =>
          (event.type === EventType.TEXT_MESSAGE_START ||
            event.type === EventType.TEXT_MESSAGE_CONTENT ||
            event.type === EventType.TEXT_MESSAGE_END) &&
          juno(event)?.runId === runId,
      ),
    ).toEqual([]);
    expect(
      late.filter((event) => event.type === 'item.added' && event.conversationId === 'conv-juno' && event.item.type === 'agent_message'),
    ).toEqual([]);
  });
});

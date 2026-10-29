import { describe, expect, it } from 'vitest';
import { createJuno } from '../juno.js';
import type { ChatEvent } from '../types.js';
import { fakeBackend, json, type FakeBackend } from './fake-backend.js';
import * as f from './fixtures.js';

const BASE = 'http://juno.test';
const CONV = 'conv-1';

function clientFor(backend: FakeBackend) {
  return createJuno({ baseUrl: BASE, token: 'tok-test', fetch: backend.fetch });
}

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('chat turns', () => {
  it('yields text deltas in order, drops stale frames, then the reply, the tool steps and done', async () => {
    const backend: FakeBackend = fakeBackend({
      [`GET /v1/conversations/${CONV}`]: () => json(f.conversation(CONV)),
      'GET /v1/runs': () => json({ items: [], nextCursor: null }),
      [`POST /v1/conversations/${CONV}/runs`]: async () => {
        await backend.streamOpen;
        const delta = (seq: number, text: string, runId = 'run-1') =>
          backend.emit(f.preview({ generationId: 1, seq, phase: 'delta', runId, conversationId: CONV, messageId: 'm1', text }));
        backend.emit(f.runStarted(f.run('run-1', CONV, 'running')));
        backend.emit(f.preview({ generationId: 1, seq: 0, phase: 'start', runId: 'run-1', conversationId: CONV, messageId: 'm1' }));
        delta(1, 'Hel');
        delta(1, 'replayed');
        delta(2, 'lo');
        delta(3, 'other run', 'run-2');
        backend.emit({ type: 'item.added', conversationId: 'conv-other', item: f.agentMessage('x', 'conv-other', 'elsewhere') });
        backend.emit(f.stepStarted(f.step('s1', 'run-1', 'running')));
        backend.emit(f.stepFinished(f.step('s1', 'run-1', 'completed')));
        backend.emit({ type: 'item.added', conversationId: CONV, item: f.userMessage('u1', CONV, 'hi') });
        backend.emit({ type: 'item.added', conversationId: CONV, item: f.agentMessage('a1', CONV, 'Hello there', 'run-1') });
        backend.emit(f.runUpdated(f.run('run-1', CONV, 'completed')));
        backend.emit(f.runFinished(f.run('run-1', CONV, 'completed')));
        return json({ item: f.userMessage('u1', CONV, 'hi'), runId: 'run-1' }, 202);
      },
    });

    const chat = await clientFor(backend).chat({ conversationId: CONV });
    const events = await collect(chat.send('hi'));

    expect(events).toEqual([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'tool', name: 'shell', status: 'running' },
      { type: 'tool', name: 'shell', status: 'completed' },
      { type: 'message', item: expect.objectContaining({ id: 'a1', markdown: 'Hello there' }) },
      { type: 'done', run: expect.objectContaining({ id: 'run-1', status: 'completed' }) },
    ]);
    expect(backend.calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      threadId: CONV,
      forwardedProps: { juno: { composer: { text: 'hi' } } },
    });
  });

  it('answers approvals through onApproval and does not yield them', async () => {
    const seen: string[] = [];
    const backend: FakeBackend = fakeBackend({
      [`GET /v1/conversations/${CONV}`]: () => json(f.conversation(CONV)),
      'GET /v1/runs': () => json({ items: [], nextCursor: null }),
      [`POST /v1/conversations/${CONV}/runs`]: async () => {
        await backend.streamOpen;
        backend.emit(f.runStarted(f.run('run-1', CONV, 'running')));
        backend.emit({ type: 'request.created', request: f.request('req-1', CONV, 'run-1', 'pending') });
        return json({ item: f.userMessage('u1', CONV, 'send it'), runId: 'run-1' }, 202);
      },
      'POST /v1/requests/req-1/resolve': async () => {
        await backend.streamOpen;
        backend.emit(f.runUpdated(f.run('run-1', CONV, 'completed')));
        backend.emit(f.runFinished(f.run('run-1', CONV, 'completed')));
        return json(f.request('req-1', CONV, 'run-1', 'approved'));
      },
    });

    const chat = await clientFor(backend).chat({ conversationId: CONV });
    const events = await collect(
      chat.send('send it', {
        onApproval: async (request) => {
          seen.push(request.id);
          return { action: 'approve' };
        },
      }),
    );

    expect(seen).toEqual(['req-1']);
    expect(events).toEqual([{ type: 'done', run: expect.objectContaining({ id: 'run-1' }) }]);
    expect(backend.calls.find((call) => call.path === '/v1/requests/req-1/resolve')?.body).toEqual({ action: 'approve' });
  });

  it('yields a request when no onApproval is given, and resolves it from the loop', async () => {
    const backend: FakeBackend = fakeBackend({
      [`GET /v1/conversations/${CONV}`]: () => json(f.conversation(CONV)),
      'GET /v1/runs': () => json({ items: [], nextCursor: null }),
      [`POST /v1/conversations/${CONV}/runs`]: async () => {
        await backend.streamOpen;
        backend.emit(f.runStarted(f.run('run-1', CONV, 'waiting_for_input')));
        backend.emit({ type: 'request.created', request: f.request('req-1', CONV, 'run-1', 'pending') });
        return json({ item: f.userMessage('u1', CONV, 'send it'), runId: 'run-1' }, 202);
      },
      'POST /v1/requests/req-1/resolve': async () => {
        await backend.streamOpen;
        backend.emit(f.runUpdated(f.run('run-1', CONV, 'completed')));
        backend.emit(f.runFinished(f.run('run-1', CONV, 'completed')));
        return json(f.request('req-1', CONV, 'run-1', 'denied'));
      },
    });

    const chat = await clientFor(backend).chat({ conversationId: CONV });
    const events: ChatEvent[] = [];
    for await (const event of chat.send('send it')) {
      events.push(event);
      if (event.type === 'request') await chat.resolve(event.request.id, { action: 'deny' });
    }

    expect(events).toEqual([
      { type: 'request', request: expect.objectContaining({ id: 'req-1', kind: 'approval' }) },
      { type: 'done', run: expect.objectContaining({ id: 'run-1' }) },
    ]);
    expect(backend.calls.find((call) => call.path === '/v1/requests/req-1/resolve')?.body).toEqual({ action: 'deny' });
  });

  it('resumes an existing conversation and ends on the busy run the message steered into', async () => {
    const CONV9 = 'conv-9';
    const backend: FakeBackend = fakeBackend({
      [`GET /v1/conversations/${CONV9}`]: () => json(f.conversation(CONV9)),
      'GET /v1/runs': () => json({ items: [f.run('run-busy', CONV9, 'running')], nextCursor: null }),
      [`POST /v1/conversations/${CONV9}/runs`]: async () => {
        await backend.streamOpen;
        backend.emit({ type: 'item.added', conversationId: CONV9, item: f.agentMessage('a9', CONV9, 'Noted', 'run-busy') });
        backend.emit(f.runUpdated(f.run('run-busy', CONV9, 'completed')));
        backend.emit(f.runFinished(f.run('run-busy', CONV9, 'completed')));
        return json({ item: f.userMessage('u9', CONV9, 'also this'), runId: 'run-busy' }, 202);
      },
    });

    const chat = await clientFor(backend).chat({ conversationId: CONV9 });
    expect(chat.id).toBe(CONV9);
    const events = await collect(chat.send('also this'));

    expect(events).toEqual([
      { type: 'message', item: expect.objectContaining({ id: 'a9' }) },
      { type: 'done', run: expect.objectContaining({ id: 'run-busy' }) },
    ]);
    expect(backend.calls.find((call) => call.method === 'GET' && call.path.startsWith('/v1/runs'))?.path).toContain(
      `conversationId=${CONV9}`,
    );
  });

  it('opens the existing direct chat with an agent instead of creating another', async () => {
    const backend: FakeBackend = fakeBackend({
      'GET /v1/conversations': () => json({ items: [f.conversation('conv-existing')], nextCursor: null }),
    });

    const chat = await clientFor(backend).chat({ agentId: f.AGENT_ID });

    expect(chat.id).toBe('conv-existing');
    expect(backend.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('creates the direct chat with an agent when there is none', async () => {
    const backend: FakeBackend = fakeBackend({
      'GET /v1/conversations': () => json({ items: [], nextCursor: null }),
      'POST /v1/conversations': () => json(f.conversation('conv-new')),
    });

    const chat = await clientFor(backend).chat({ agentId: f.AGENT_ID });

    expect(chat.id).toBe('conv-new');
    expect(backend.calls.find((call) => call.method === 'POST')?.body).toEqual({
      kind: 'direct',
      memberAgentIds: [f.AGENT_ID],
      requestId: `juno-sdk:direct:${f.AGENT_ID}`,
    });
  });
});

describe('turn correlation', () => {
  it('follows the run the send names, not a busy run it saw before the send', async () => {
    const backend: FakeBackend = fakeBackend({
      [`GET /v1/conversations/${CONV}`]: () => json(f.conversation(CONV)),
      'GET /v1/runs': () => json({ items: [f.run('run-busy', CONV, 'running')], nextCursor: null }),
      [`POST /v1/conversations/${CONV}/runs`]: async () => {
        await backend.streamOpen;
        backend.emit(f.runUpdated(f.run('run-busy', CONV, 'completed')));
        backend.emit(f.runFinished(f.run('run-busy', CONV, 'completed')));
        backend.emit(f.runStarted(f.run('run-2', CONV, 'running')));
        backend.emit(f.runUpdated(f.run('run-2', CONV, 'completed')));
        backend.emit(f.runFinished(f.run('run-2', CONV, 'completed')));
        return json({ item: f.userMessage('u1', CONV, 'hi'), runId: 'run-2' }, 202);
      },
    });

    const chat = await clientFor(backend).chat({ conversationId: CONV });
    const events = await collect(chat.send('hi'));

    expect(events).toEqual([{ type: 'done', run: expect.objectContaining({ id: 'run-2' }) }]);
  });

  it('follows the wire run id returned by the standard run entry', async () => {
    const backend: FakeBackend = fakeBackend({
      [`GET /v1/conversations/${CONV}`]: () => json(f.conversation(CONV)),
      'GET /v1/runs': () => json({ items: [], nextCursor: null }),
      [`POST /v1/conversations/${CONV}/runs`]: async () => {
        await backend.streamOpen;
        backend.emit(f.runStarted(f.run('run-9', CONV, 'running')));
        backend.emit(f.runUpdated(f.run('run-9', CONV, 'completed')));
        backend.emit(f.runFinished(f.run('run-9', CONV, 'completed')));
        return json({ item: f.userMessage('u1', CONV, 'hi'), runId: 'run-9' }, 202);
      },
    });

    const chat = await clientFor(backend).chat({ conversationId: CONV });
    const events = await collect(chat.send('hi'));

    expect(events).toEqual([{ type: 'done', run: expect.objectContaining({ id: 'run-9' }) }]);
  });
});

describe('stop', () => {
  it('stops the run of the turn being iterated, and the turn ends stopped', async () => {
    const backend: FakeBackend = fakeBackend({
      [`GET /v1/conversations/${CONV}`]: () => json(f.conversation(CONV)),
      'GET /v1/runs': () => json({ items: [], nextCursor: null }),
      [`POST /v1/conversations/${CONV}/runs`]: async () => {
        await backend.streamOpen;
        backend.emit(f.runStarted(f.run('run-1', CONV, 'running')));
        backend.emit(f.stepStarted(f.step('s1', 'run-1', 'running')));
        return json({ item: f.userMessage('u1', CONV, 'hi'), runId: 'run-1' }, 202);
      },
      'POST /v1/runs/run-1/stop': () => {
        backend.emit(f.runUpdated(f.run('run-1', CONV, 'stopped')));
        backend.emit(f.runFinished(f.run('run-1', CONV, 'stopped')));
        return json(f.run('run-1', CONV, 'stopped'));
      },
    });

    const chat = await clientFor(backend).chat({ conversationId: CONV });
    const events: ChatEvent[] = [];
    for await (const event of chat.send('hi')) {
      events.push(event);
      if (event.type === 'tool') {
        const run = await chat.stop();
        expect(run.status).toBe('stopped');
      }
    }

    expect(events).toEqual([
      { type: 'tool', name: 'shell', status: 'running' },
      { type: 'done', run: expect.objectContaining({ id: 'run-1', status: 'stopped' }) },
    ]);
    expect(backend.calls.filter((call) => call.path === '/v1/runs/run-1/stop')).toHaveLength(1);
  });

  it('breaking out of the loop only stops listening: the run is not stopped', async () => {
    const backend: FakeBackend = fakeBackend({
      [`GET /v1/conversations/${CONV}`]: () => json(f.conversation(CONV)),
      'GET /v1/runs': () => json({ items: [], nextCursor: null }),
      [`POST /v1/conversations/${CONV}/runs`]: async () => {
        await backend.streamOpen;
        backend.emit(f.stepStarted(f.step('s1', 'run-1', 'running')));
        return json({ item: f.userMessage('u1', CONV, 'hi'), runId: 'run-1' }, 202);
      },
    });

    const chat = await clientFor(backend).chat({ conversationId: CONV });
    for await (const _event of chat.send('hi')) break;

    expect(backend.calls.some((call) => call.path.endsWith('/stop'))).toBe(false);
    await expect(chat.stop()).rejects.toMatchObject({ code: 'NO_ACTIVE_RUN' });
  });

  it('rejects with NO_ACTIVE_RUN when no turn is being iterated', async () => {
    const backend: FakeBackend = fakeBackend({
      [`GET /v1/conversations/${CONV}`]: () => json(f.conversation(CONV)),
    });

    const chat = await clientFor(backend).chat({ conversationId: CONV });

    await expect(chat.stop()).rejects.toMatchObject({ code: 'NO_ACTIVE_RUN' });
    expect(backend.calls.some((call) => call.method === 'POST')).toBe(false);
  });
});

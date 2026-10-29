import { describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '../types.js';
import { AsyncQueue } from '../queue.js';
import { serve } from '../serve.js';
import { fakeBackend, json, apiError, type FakeBackend } from './fake-backend.js';
import * as f from './fixtures.js';

const BASE = 'http://juno.test';
const CONV = 'conv-1';

interface Message {
  id?: string | number | null;
  result?: unknown;
  error?: { code: string; message: string; status?: number };
  method?: string;
  params?: unknown;
}

interface EventParams {
  turn: string;
  event: ChatEvent;
}

async function* lines(queue: AsyncQueue<string | null>): AsyncGenerator<string> {
  for (;;) {
    const line = await queue.next();
    if (line === null) return;
    yield line;
  }
}

/** A session on fake stdio: `send` writes a request line, `out` collects every protocol line. */
function session(backend: FakeBackend) {
  const input = new AsyncQueue<string | null>();
  const out: Message[] = [];
  const done = serve(
    {
      input: lines(input),
      write: (line) => {
        out.push(JSON.parse(line) as Message);
      },
    },
    { baseUrl: BASE, token: 'tok-test', fetch: backend.fetch },
  );
  return {
    send: (message: unknown) => input.push(typeof message === 'string' ? message : JSON.stringify(message)),
    end: () => input.push(null),
    out,
    done,
  };
}

/** Waits until `read` returns something, then returns it. */
async function until<T>(read: () => T | undefined): Promise<T> {
  return vi.waitFor(() => {
    const value = read();
    if (value === undefined) throw new Error('not yet');
    return value;
  });
}

const responseTo = (out: Message[], id: number | string) =>
  out.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined));

const turnEvents = (out: Message[], turn: string): ChatEvent[] =>
  out
    .filter((m) => m.method === 'event' && (m.params as EventParams).turn === turn)
    .map((m) => (m.params as EventParams).event);

const doneOf = (out: Message[], turn: string) =>
  out.find((m) => m.method === 'event' && (m.params as EventParams).turn === turn && (m.params as EventParams).event.type === 'done');

describe('juno serve protocol', () => {
  it('answers initialize, and refuses other methods until it has been called', async () => {
    const s = session(fakeBackend({}));

    s.send({ id: 1, method: 'chat.open', params: { agentId: f.AGENT_ID } });
    expect((await until(() => responseTo(s.out, 1))).error).toMatchObject({ code: 'NOT_INITIALIZED' });

    s.send({ id: 2, method: 'initialize', params: { protocolVersion: 1 } });
    expect((await until(() => responseTo(s.out, 2))).result).toEqual({ protocolVersion: 1, server: { baseUrl: BASE } });

    s.send({ id: 3, method: 'initialize', params: { protocolVersion: 2 } });
    expect((await until(() => responseTo(s.out, 3))).error).toMatchObject({ code: 'UNSUPPORTED_VERSION' });

    s.end();
    await s.done;
  });

  it('opens a chat by agent or by conversation, and rejects a target that is not exactly one', async () => {
    const backend = fakeBackend({
      'GET /v1/conversations': () => json({ items: [f.conversation('conv-existing')], nextCursor: null }),
      [`GET /v1/conversations/${CONV}`]: () => json(f.conversation(CONV)),
    });
    const s = session(backend);
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    s.send({ id: 2, method: 'chat.open', params: { agentId: f.AGENT_ID } });
    s.send({ id: 3, method: 'chat.open', params: { conversationId: CONV } });
    s.send({ id: 4, method: 'chat.open', params: { agentId: f.AGENT_ID, conversationId: CONV } });
    s.send({ id: 5, method: 'chat.send', params: { chatId: 'nope', text: 'hi' } });

    expect((await until(() => responseTo(s.out, 2))).result).toEqual({ chatId: 'conv-existing' });
    expect((await until(() => responseTo(s.out, 3))).result).toEqual({ chatId: CONV });
    expect((await until(() => responseTo(s.out, 4))).error).toMatchObject({ code: 'INVALID_PARAMS' });
    expect((await until(() => responseTo(s.out, 5))).error).toMatchObject({ code: 'UNKNOWN_CHAT' });

    s.end();
    await s.done;
  });

  it('answers a send with its turn id, then streams the turn as events until done', async () => {
    const backend: FakeBackend = fakeBackend({
      [`GET /v1/conversations/${CONV}`]: () => json(f.conversation(CONV)),
      'GET /v1/runs': () => json({ items: [], nextCursor: null }),
      [`POST /v1/conversations/${CONV}/runs`]: async () => {
        await backend.streamOpen;
        backend.emit(f.runStarted(f.run('run-1', CONV, 'running')));
        backend.emit(f.stepStarted(f.step('s1', 'run-1', 'running')));
        backend.emit(f.stepFinished(f.step('s1', 'run-1', 'completed')));
        backend.emit({ type: 'item.added', conversationId: CONV, item: f.agentMessage('a1', CONV, 'Hello there', 'run-1') });
        backend.emit(f.runUpdated(f.run('run-1', CONV, 'completed')));
        backend.emit(f.runFinished(f.run('run-1', CONV, 'completed')));
        return json({ item: f.userMessage('u1', CONV, 'hi'), runId: 'run-1' }, 202);
      },
    });
    const s = session(backend);
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    s.send({ id: 2, method: 'chat.open', params: { conversationId: CONV } });
    s.send({ id: 3, method: 'chat.send', params: { chatId: CONV, text: 'hi' } });

    expect((await until(() => responseTo(s.out, 3))).result).toEqual({ turnId: 'turn-1' });
    await until(() => doneOf(s.out, 'turn-1'));

    expect(turnEvents(s.out, 'turn-1')).toEqual([
      { type: 'tool', name: 'shell', status: 'running' },
      { type: 'tool', name: 'shell', status: 'completed' },
      { type: 'message', item: expect.objectContaining({ id: 'a1', markdown: 'Hello there' }) },
      { type: 'done', run: expect.objectContaining({ id: 'run-1', status: 'completed' }) },
    ]);
    const responseIndex = s.out.indexOf(responseTo(s.out, 3) as Message);
    expect(responseIndex).toBeLessThan(s.out.findIndex((m) => m.method === 'event'));

    s.end();
    await s.done;
  });

  it('streams a request as an event and answers it through chat.resolve', async () => {
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
    const s = session(backend);
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    s.send({ id: 2, method: 'chat.open', params: { conversationId: CONV } });
    s.send({ id: 3, method: 'chat.send', params: { chatId: CONV, text: 'send it' } });

    await until(() => turnEvents(s.out, 'turn-1').find((e) => e.type === 'request'));
    s.send({ id: 4, method: 'chat.resolve', params: { requestId: 'nope', decision: { action: 'deny' } } });
    s.send({ id: 5, method: 'chat.resolve', params: { requestId: 'req-1', decision: { action: 'deny' } } });

    expect((await until(() => responseTo(s.out, 4))).error).toMatchObject({ code: 'UNKNOWN_REQUEST' });
    expect((await until(() => responseTo(s.out, 5))).result).toMatchObject({ id: 'req-1', status: 'denied' });
    await until(() => doneOf(s.out, 'turn-1'));
    expect(backend.calls.find((call) => call.path === '/v1/requests/req-1/resolve')?.body).toEqual({ action: 'deny' });

    s.end();
    await s.done;
  });

  it('stops the run of the current turn through chat.stop, and the turn ends stopped', async () => {
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
    const s = session(backend);
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    s.send({ id: 2, method: 'chat.open', params: { conversationId: CONV } });
    s.send({ id: 3, method: 'chat.stop', params: { chatId: CONV } });
    expect((await until(() => responseTo(s.out, 3))).error).toMatchObject({ code: 'NO_ACTIVE_RUN' });

    s.send({ id: 4, method: 'chat.send', params: { chatId: CONV, text: 'hi' } });
    await until(() => turnEvents(s.out, 'turn-1').find((e) => e.type === 'tool'));
    s.send({ id: 5, method: 'chat.stop', params: { chatId: CONV } });

    expect((await until(() => responseTo(s.out, 5))).result).toMatchObject({ run: { id: 'run-1', status: 'stopped' } });
    await until(() => doneOf(s.out, 'turn-1'));
    expect(backend.calls.filter((call) => call.path === '/v1/runs/run-1/stop')).toHaveLength(1);

    s.end();
    await s.done;
  });

  it('reports a turn the server rejects as turn.failed with the server error', async () => {
    const backend: FakeBackend = fakeBackend({
      [`GET /v1/conversations/${CONV}`]: () => json(f.conversation(CONV)),
      'GET /v1/runs': () => json({ items: [], nextCursor: null }),
      [`POST /v1/conversations/${CONV}/runs`]: () => apiError(403, 'CONVERSATION_FORBIDDEN', 'Conversation not shared with you'),
    });
    const s = session(backend);
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    s.send({ id: 2, method: 'chat.open', params: { conversationId: CONV } });
    s.send({ id: 3, method: 'chat.send', params: { chatId: CONV, text: 'hi' } });

    const failed = await until(() => s.out.find((m) => m.method === 'turn.failed'));
    expect(failed.params).toEqual({
      turn: 'turn-1',
      error: { code: 'CONVERSATION_FORBIDDEN', message: 'Conversation not shared with you', status: 403 },
    });

    s.end();
    await s.done;
  });

  it('answers a malformed line with an error response and keeps serving', async () => {
    const s = session(fakeBackend({}));

    s.send('{not json');
    s.send({ method: 'initialize' });
    s.send({ id: 7, method: 'initialize', params: { protocolVersion: 1 } });
    s.send({ id: 8, method: 'chat.nothing', params: {} });
    s.send({ id: 9, method: 'chat.nothing', params: {} });

    expect((await until(() => s.out.find((m) => m.id === null)))).toMatchObject({ error: { code: 'PARSE_ERROR' } });
    expect((await until(() => responseTo(s.out, 7)))).toMatchObject({ result: { protocolVersion: 1 } });
    expect((await until(() => responseTo(s.out, 8)))).toMatchObject({ error: { code: 'METHOD_NOT_FOUND' } });
    expect(s.out.filter((m) => m.id === null)).toHaveLength(2);

    s.end();
    await s.done;
  });

  it('ends the session at shutdown after answering it: later lines are not read', async () => {
    const s = session(fakeBackend({}));
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    s.send({ id: 2, method: 'shutdown' });
    s.send({ id: 3, method: 'initialize', params: { protocolVersion: 1 } });

    await s.done;

    expect(responseTo(s.out, 2)?.result).toEqual({});
    expect(responseTo(s.out, 3)).toBeUndefined();
  });
});

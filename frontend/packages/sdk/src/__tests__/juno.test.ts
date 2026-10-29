import { describe, expect, it, vi } from 'vitest';
import { JunoApiError, JunoError } from '../errors.js';
import { createJuno } from '../juno.js';
import { fakeBackend, json, apiError, type FakeBackend } from './fake-backend.js';
import * as f from './fixtures.js';

const BASE = 'http://juno.test';

describe('background task events', () => {
  it('fires task.finished once per task when it reaches a finished status', async () => {
    const backend: FakeBackend = fakeBackend({});
    const juno = createJuno({ baseUrl: BASE, token: 'tok-test', fetch: backend.fetch });
    const finished: string[] = [];
    const stop = juno.on('task.finished', (task) => finished.push(`${task.id}:${task.outcome}`));

    await backend.streamOpen;
    backend.emit({ type: 'task.updated', task: f.task('t1', 'running') });
    backend.emit({ type: 'task.updated', task: f.task('t1', 'ended', 'done') });
    backend.emit({ type: 'task.updated', task: f.task('t1', 'ended', 'done') });
    backend.emit({ type: 'task.updated', task: f.task('t2', 'ended', 'failed') });
    await vi.waitFor(() => expect(finished).toEqual(['t1:done', 't2:failed']));

    stop();
    await juno.close();
  });

  it('stops delivering after unsubscribe and closes the live stream', async () => {
    const backend: FakeBackend = fakeBackend({});
    const juno = createJuno({ baseUrl: BASE, token: 'tok-test', fetch: backend.fetch });
    const seen: string[] = [];
    const stop = juno.on('task.finished', (task) => seen.push(task.id));

    await backend.streamOpen;
    backend.emit({ type: 'task.updated', task: f.task('t1', 'ended', 'done') });
    await vi.waitFor(() => expect(seen).toEqual(['t1']));

    stop();
    backend.emit({ type: 'task.updated', task: f.task('t2', 'ended', 'done') });
    await juno.close();
    expect(seen).toEqual(['t1']);
  });
});

describe('errors', () => {
  it('rejects with a JunoApiError that carries the server code and status', async () => {
    const backend: FakeBackend = fakeBackend({
      'GET /v1/conversations/missing': () => apiError(404, 'CONVERSATION_NOT_FOUND', 'Conversation missing not found'),
    });
    const juno = createJuno({ baseUrl: BASE, token: 'tok-test', fetch: backend.fetch });

    const failure = await juno.chat({ conversationId: 'missing' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JunoApiError);
    expect(failure).toBeInstanceOf(JunoError);
    expect(failure).toMatchObject({ status: 404, code: 'CONVERSATION_NOT_FOUND', message: 'Conversation missing not found' });
  });

  it('types a send rejected by the server, so the turn fails before any event', async () => {
    const backend: FakeBackend = fakeBackend({
      'GET /v1/conversations/conv-1': () => json(f.conversation('conv-1')),
      'GET /v1/runs': () => json({ items: [], nextCursor: null }),
      'POST /v1/conversations/conv-1/runs': () => apiError(403, 'CONVERSATION_FORBIDDEN', 'Conversation not shared with you'),
    });
    const juno = createJuno({ baseUrl: BASE, token: 'tok-test', fetch: backend.fetch });
    const chat = await juno.chat({ conversationId: 'conv-1' });

    const failure = await (async () => {
      for await (const _event of chat.send('hi')) {
        // The send is rejected, so no event arrives.
      }
    })().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JunoApiError);
    expect(failure).toMatchObject({ status: 403, code: 'CONVERSATION_FORBIDDEN' });
    await juno.close();
  });

  it('maps a transport failure to NETWORK_ERROR', async () => {
    const juno = createJuno({
      baseUrl: BASE,
      token: 'tok-test',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });

    const failure = await juno.chat({ conversationId: 'conv-1' }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JunoError);
    expect(failure).not.toBeInstanceOf(JunoApiError);
    expect(failure).toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('rejects a missing token before any request is made', () => {
    expect(() => createJuno({ baseUrl: BASE, token: '' })).toThrow(JunoError);
  });
});

describe('close', () => {
  it('ends an open turn with a CLOSED error', async () => {
    const backend: FakeBackend = fakeBackend({
      'GET /v1/conversations/conv-1': () => json(f.conversation('conv-1')),
      'GET /v1/runs': () => json({ items: [], nextCursor: null }),
      'POST /v1/conversations/conv-1/runs': async () => {
        await backend.streamOpen;
        backend.emit(f.runStarted(f.run('run-1', 'conv-1', 'running')));
        return json({ item: f.userMessage('u1', 'conv-1', 'hi'), runId: 'run-1' }, 202);
      },
    });
    const juno = createJuno({ baseUrl: BASE, token: 'tok-test', fetch: backend.fetch });
    const chat = await juno.chat({ conversationId: 'conv-1' });

    const turn = (async () => {
      for await (const _event of chat.send('hi')) {
        // The run never finishes, so the turn waits until close.
      }
    })();
    await vi.waitFor(() => expect(backend.calls.some((call) => call.method === 'POST')).toBe(true));
    await juno.close();

    await expect(turn).rejects.toMatchObject({ code: 'CLOSED' });
    await expect(juno.chat({ conversationId: 'conv-1' })).rejects.toMatchObject({ code: 'CLOSED' });
  });
});

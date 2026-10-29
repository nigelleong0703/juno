/**
 * QR1: request resolution must persist the validated decision (status, server owner, field answers),
 * refuse invalid answers and actions, never wake twice on a retry, never report success when delivery
 * fails, and never let a second submission overwrite the answer already recorded.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import { APPROVAL_WINDOW_MS, NotFoundError } from '@agent-desktop/contracts';
import type { Enqueuer, EventBus, Store, StoredRequest, WakeEvent } from '@agent-desktop/contracts';
import { requestSchema } from '@agent-desktop/public-contracts';
import { registerRequests } from '../requests.js';
import { testChannels } from '../../__tests__/test-app.js';

type MemoryStore = ReturnType<typeof createMemoryStore>;

const OWNER = 'owner-1';
const at = '2026-10-06T00:00:00.000Z';

class RecordingEnqueuer implements Enqueuer {
  readonly wakes: WakeEvent[] = [];
  readonly awakeables: Array<{ id: string; value: unknown }> = [];
  failAwakeable = false;

  async enqueue(event: WakeEvent): Promise<{ accepted: boolean; reason?: string }> {
    this.wakes.push(event);
    return { accepted: true };
  }

  async stopRun(): Promise<void> {}

  async scheduleRoutine(): Promise<void> {}

  async resolveAwakeable(id: string, value: unknown): Promise<void> {
    if (this.failAwakeable) throw new Error('restate ingress unavailable');
    this.awakeables.push({ id, value });
  }
}

function question(id: string, extra: Partial<StoredRequest> = {}): StoredRequest {
  return {
    id,
    kind: 'question',
    status: 'pending',
    title: 'Question',
    summary: 'Origin?',
    agentId: 'agent-1',
    createdAt: at,
    payload: { kind: 'question', ui: { version: 1, blocks: [{ type: 'fields', id: 'form', fields: [{ id: 'origin', label: 'Origin?', kind: 'text' }] }] } },
    ...extra,
  };
}

function choiceQuestion(id: string): StoredRequest {
  return {
    ...question(id),
    payload: {
      kind: 'question',
      ui: { version: 1, blocks: [{ type: 'fields', id: 'form', fields: [{ id: 'city', label: 'City?', kind: 'select', options: ['Singapore', 'London'] }] }] },
    },
  };
}

function pickQuestion(id: string): StoredRequest {
  return {
    ...question(id),
    payload: { kind: 'question', ui: { version: 1, blocks: [{ type: 'choices', id: 'go', options: [{ id: 'yes', label: 'Continue' }, { id: 'no', label: 'Cancel' }] }] } },
  };
}

function approval(id: string, raisedAt: string = new Date().toISOString()): StoredRequest {
  return {
    id,
    kind: 'approval',
    status: 'pending',
    title: 'Send email',
    summary: 'Send the summary',
    agentId: 'agent-1',
    createdAt: raisedAt,
    payload: { kind: 'approval', action: 'Send email', why: 'user asked' },
  };
}

function ownerStore(mem: MemoryStore, owner: string): Store {
  const scoped = mem.forOwner?.(owner);
  if (!scoped) throw new Error('memory store is missing forOwner');
  return scoped;
}

function scopedApp(store: Store, bus: EventBus, enqueuer: Enqueuer, owner: string): Hono {
  const app = new Hono();
  app.use('*', async (c: Context, next) => {
    c.set('ownerId', owner);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof NotFoundError) return c.json({ error: { code: 'NOT_FOUND', message: error.message } }, 404);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'error' } }, 500);
  });
  registerRequests(app, { store, bus, enqueuer, channels: testChannels });
  return app;
}

function makeApp(mem: MemoryStore, enqueuer: Enqueuer, owner = OWNER): Hono {
  return scopedApp(mem, mem.eventBus, enqueuer, owner);
}

function resolve(app: Hono, id: string, decision: unknown): Promise<Response> {
  return Promise.resolve(
    app.request('/v1/requests/' + id + '/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(decision),
    }),
  );
}

async function answerOf(res: Response): Promise<string | undefined> {
  const request = requestSchema.parse(await res.json());
  if (request.payload.kind !== 'question') return undefined;
  return Object.values(request.payload.answers ?? {})[0];
}

async function stored(mem: MemoryStore, id: string): Promise<StoredRequest> {
  const request = await mem.get('requests', id);
  if (!request) throw new Error('request ' + id + ' missing from the store');
  return request;
}

describe('an approval is good for one decision inside its window', () => {
  const stale = (): string => new Date(Date.now() - APPROVAL_WINDOW_MS - 60_000).toISOString();

  it('a yes after the window is refused (409 REQUEST_EXPIRED): the card closes as timed out, the waiting run is woken with a no once, and asking again is refused again', async () => {
    const mem = createMemoryStore();
    await mem.put('requests', { ...approval('req-late', stale()), awakeableId: 'awk-late' });
    const enqueuer = new RecordingEnqueuer();
    const app = makeApp(mem, enqueuer);
    const first = await resolve(app, 'req-late', { action: 'approve' });
    expect(first.status).toBe(409);
    expect(await first.json()).toMatchObject({ error: { code: 'REQUEST_EXPIRED' } });
    expect(await stored(mem, 'req-late')).toMatchObject({ status: 'expired', decision: { by: OWNER, reason: 'timeout' }, resolution: { action: 'deny' } });
    expect(enqueuer.awakeables).toEqual([{ id: 'awk-late', value: { action: 'deny' } }]);
    // A second yes is still no, and the run is not woken twice. The public row says it timed out.
    expect((await resolve(app, 'req-late', { action: 'approve' })).status).toBe(409);
    expect(enqueuer.awakeables).toHaveLength(1);
    expect(requestSchema.parse(await (await app.request('/v1/requests/req-late')).json())).toMatchObject({ status: 'expired', outcome: 'timed_out' });
  });

  it('a no on an old card is an ordinary no, a yes inside the window is an ordinary yes, and a yes that loses a race stays the winner\'s', async () => {
    const mem = createMemoryStore();
    await mem.put('requests', approval('req-old-no', stale()));
    await mem.put('requests', approval('req-fresh'));
    const app = makeApp(mem, new RecordingEnqueuer());
    expect((await resolve(app, 'req-old-no', { action: 'deny' })).status).toBe(200);
    expect((await stored(mem, 'req-old-no')).status).toBe('denied');
    expect((await resolve(app, 'req-fresh', { action: 'approve' })).status).toBe(200);
    expect((await stored(mem, 'req-fresh')).status).toBe('approved');
    // Decided already: a later yes on it is the idempotent replay, not an expiry.
    expect((await resolve(app, 'req-fresh', { action: 'approve' })).status).toBe(200);
  });
});

describe('request resolution', () => {
  it('maps a choices answer by block id to the option id and refuses an unknown option', async () => {
    const mem = createMemoryStore();
    await mem.put('requests', pickQuestion('req-pick'));
    const app = makeApp(mem, new RecordingEnqueuer());
    expect((await resolve(app, 'req-pick', { action: 'answer', answers: { go: 'maybe' } })).status).toBe(400);
    expect((await stored(mem, 'req-pick')).status).toBe('pending');
    expect((await resolve(app, 'req-pick', { action: 'answer', answers: { go: 'yes' } })).status).toBe(200);
    const request = await stored(mem, 'req-pick');
    expect(request.resolution).toEqual({ action: 'answer', answers: { go: 'yes' } });
    if (request.payload.kind !== 'question') throw new Error('payload kind changed');
    expect(request.payload.answers).toEqual({ go: 'yes' });
  });

  it('persists the validated status, the server owner decision and the field answers', async () => {
    const mem = createMemoryStore();
    await mem.put('requests', question('req-1'));
    const enqueuer = new RecordingEnqueuer();
    const res = await resolve(makeApp(mem, enqueuer), 'req-1', {
      action: 'answer',
      answers: { origin: 'Singapore' },
      by: 'someone-else',
      mode: 'auto',
    });

    expect(res.status).toBe(200);
    expect(await answerOf(res)).toBe('Singapore');
    const request = await stored(mem, 'req-1');
    expect(request.status).toBe('answered');
    expect(request.resolvedAt).toBeTruthy();
    expect(request.decision?.by).toBe(OWNER);
    expect(request.decision?.mode).toBe('manual');
    if (request.payload.kind !== 'question') throw new Error('payload kind changed');
    expect(request.payload.answers).toEqual({ origin: 'Singapore' });
    expect(enqueuer.wakes).toHaveLength(0);
  });

  it('rejects an empty required answer and leaves the request pending', async () => {
    const mem = createMemoryStore();
    await mem.put('requests', question('req-2'));
    const enqueuer = new RecordingEnqueuer();
    const res = await resolve(makeApp(mem, enqueuer), 'req-2', { action: 'answer', answers: { origin: '   ' } });

    expect(res.status).toBe(400);
    expect((await stored(mem, 'req-2')).status).toBe('pending');
    expect(enqueuer.wakes).toHaveLength(0);
    expect(enqueuer.awakeables).toHaveLength(0);
  });

  it('rejects a choice answer that is not one of the options', async () => {
    const mem = createMemoryStore();
    await mem.put('requests', choiceQuestion('req-3'));
    const res = await resolve(makeApp(mem, new RecordingEnqueuer()), 'req-3', {
      action: 'answer',
      answers: { city: 'Berlin' },
    });

    expect(res.status).toBe(400);
    expect((await stored(mem, 'req-3')).status).toBe('pending');
  });

  it('rejects an answer for a field the request does not have', async () => {
    const mem = createMemoryStore();
    await mem.put('requests', question('req-4'));
    const res = await resolve(makeApp(mem, new RecordingEnqueuer()), 'req-4', {
      action: 'answer',
      answers: { origin: 'Singapore', extra: 'nope' },
    });

    expect(res.status).toBe(400);
  });

  it('rejects an action the request kind does not accept', async () => {
    const mem = createMemoryStore();
    await mem.put('requests', question('req-5'));
    await mem.put('requests', approval('req-6'));
    const app = makeApp(mem, new RecordingEnqueuer());

    expect((await resolve(app, 'req-5', { action: 'approve' })).status).toBe(400);
    expect((await resolve(app, 'req-6', { action: 'answer', answers: { origin: 'x' } })).status).toBe(400);
    expect((await resolve(app, 'req-6', { action: 'approve' })).status).toBe(200);
    expect((await stored(mem, 'req-6')).status).toBe('approved');
  });

  it('records a declined question as denied', async () => {
    const mem = createMemoryStore();
    await mem.put('requests', question('req-7'));
    const res = await resolve(makeApp(mem, new RecordingEnqueuer()), 'req-7', { action: 'deny', note: 'not now' });

    expect(res.status).toBe(200);
    const request = await stored(mem, 'req-7');
    expect(request.status).toBe('denied');
    expect(request.decision?.by).toBe(OWNER);
    expect(request.decision?.note).toBe('not now');
  });

  it('refuses a request owned by another user', async () => {
    const mem = createMemoryStore();
    const scopedA = ownerStore(mem, 'owner-a');
    await scopedA.put('requests', question('req-9'));

    const otherOwner = scopedApp(ownerStore(mem, 'owner-b'), mem.eventBus, new RecordingEnqueuer(), 'owner-b');
    expect((await resolve(otherOwner, 'req-9', { action: 'answer', answers: { origin: 'Singapore' } })).status).toBe(404);
    expect((await stored(mem, 'req-9')).status).toBe('pending');

    const ownOwner = scopedApp(scopedA, mem.eventBus, new RecordingEnqueuer(), 'owner-a');
    expect((await resolve(ownOwner, 'req-9', { action: 'answer', answers: { origin: 'Singapore' } })).status).toBe(200);
  });

  it('serializes concurrent decisions so the first answer is not overwritten', async () => {
    const mem = createMemoryStore();
    await mem.put('requests', question('req-12'));
    const app = makeApp(mem, new RecordingEnqueuer());

    const [first, second] = await Promise.all([
      resolve(app, 'req-12', { action: 'answer', answers: { origin: 'Singapore' } }),
      resolve(app, 'req-12', { action: 'answer', answers: { origin: 'London' } }),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstAnswer = await answerOf(first);
    expect(await answerOf(second)).toBe(firstAnswer);
    const request = await stored(mem, 'req-12');
    if (request.payload.kind !== 'question') throw new Error('payload kind changed');
    expect(Object.values(request.payload.answers ?? {})[0]).toBe(firstAnswer);
  });

  describe('internal fields stay out of the public API', () => {
    const INTERNAL = ['awakeableId', 'wakeDeliveredAt', 'resolution', '"tool"'] as const;

    function expectNoInternals(value: unknown): void {
      const text = JSON.stringify(value);
      for (const key of INTERNAL) expect(text).not.toContain(key);
      expect(text).not.toContain('awk-secret');
    }

    it('never returns awakeableId, wakeDeliveredAt or resolution from GET /v1/requests and /v1/requests/:id', async () => {
      const mem = createMemoryStore();
      await mem.put('requests', question('req-20', { awakeableId: 'awk-secret', runId: 'run-1' }));
      const app = makeApp(mem, new RecordingEnqueuer());
      expect((await resolve(app, 'req-20', { action: 'answer', answers: { origin: 'Singapore' } })).status).toBe(200);
      const doc = await stored(mem, 'req-20');
      // The store really holds the internals; only the API hides them.
      expect(doc.awakeableId).toBe('awk-secret');
      expect(doc.wakeDeliveredAt).toBeTypeOf('string');
      expect(doc.resolution?.action).toBe('answer');

      const one = await app.request('/v1/requests/req-20');
      expect(one.status).toBe(200);
      expectNoInternals(await one.json());

      const list = await app.request('/v1/requests');
      expect(list.status).toBe(200);
      const body = (await list.json()) as { items: unknown[] };
      expect(body.items).toHaveLength(1);
      expectNoInternals(body);
    });

    it('never returns the internals from the resolve response, including an idempotent replay', async () => {
      const mem = createMemoryStore();
      await mem.put('requests', question('req-21', { awakeableId: 'awk-secret', runId: 'run-1' }));
      const app = makeApp(mem, new RecordingEnqueuer());
      const first = await resolve(app, 'req-21', { action: 'answer', answers: { origin: 'Singapore' } });
      expectNoInternals(await first.json());
      const replay = await resolve(app, 'req-21', { action: 'answer', answers: { origin: 'London' } });
      expect(replay.status).toBe(200);
      expectNoInternals(await replay.json());
    });

    it('emits request.resolved without the internals', async () => {
      const mem = createMemoryStore();
      await mem.put('requests', question('req-22', { awakeableId: 'awk-secret', runId: 'run-1' }));
      await resolve(makeApp(mem, new RecordingEnqueuer()), 'req-22', { action: 'answer', answers: { origin: 'Singapore' } });

      const events = (await mem.eventBus.since(0, 100)).filter((e) => e.event.type === 'request.resolved');
      expect(events).toHaveLength(1);
      expectNoInternals(events[0]?.event);
    });
  });
});

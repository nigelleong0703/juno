/**
 * The AG-UI run ingress through the production app: admission, stable retry identity, interrupt
 * resume, first-decision wins, whole-batch validation and idempotent redelivery.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import type { Agent, Conversation, Request } from '@agent-desktop/public-contracts';
import type { Enqueuer } from '@agent-desktop/contracts';
import type { Target } from '@agent-desktop/durable';
import { createTestApp, requestAs, withDefaultOwner } from '../../__tests__/test-app.js';
import { RunnerEnqueuer } from '../../enqueuer.js';
import { RunnerStub } from '../../__tests__/runner-stub.js';

type TestStore = ReturnType<typeof createMemoryStore>;

const OWNER = 'owner-agui-routes';
const AT = '2026-10-29T00:00:00.000Z';

function approval(id: string, convId: string, runId: string): Request {
  return {
    id,
    kind: 'approval',
    status: 'pending',
    title: 'Send the summary',
    summary: 'Send it to the team',
    agentId: 'agent-1',
    conversationId: convId,
    runId,
    createdAt: AT,
    payload: { kind: 'approval', action: 'Send the summary', why: 'the user asked' },
  };
}

function question(id: string, convId: string, runId: string): Request {
  return {
    id,
    kind: 'question',
    status: 'pending',
    title: 'Origin?',
    summary: 'Which city?',
    agentId: 'agent-1',
    conversationId: convId,
    runId,
    createdAt: AT,
    payload: { kind: 'question', ui: { version: 1, blocks: [{ type: 'fields', id: 'form', fields: [{ id: 'origin', label: 'Origin?', kind: 'text' }] }] } },
  };
}

function runInput(threadId: string, messages: unknown[], resume?: unknown[]): Record<string, unknown> {
  return { threadId, runId: 'run-wire', state: {}, messages, tools: [], context: [], ...(resume === undefined ? {} : { resume }) };
}

async function seedChat(store: TestStore, kind: 'direct' | 'room' = 'direct', id = 'conv-agui'): Promise<string> {
  const agentIds = kind === 'room' ? ['agent-1', 'agent-2'] : ['agent-1'];
  await store.put('conversations', { id, kind, title: 'Chat', agentIds, memberIds: [OWNER], unreadCount: 0, createdAt: AT } as unknown as Conversation);
  return id;
}

async function seedAgent(store: TestStore, id = 'agent-1'): Promise<void> {
  await store.put('agents', { id, name: 'Agent', status: 'idle', createdBy: OWNER, createdAt: AT, updatedAt: AT } as unknown as Agent);
}

function makeApp(store: TestStore, enqueuer: Enqueuer) {
  return createTestApp({ store, bus: store.eventBus, enqueuer });
}

/** A runner that dedupes by the enqueuer's idempotency key and counts real executions. */
class IdempotentRunner extends RunnerStub {
  executions = 0;
  readonly keys: Array<string | undefined> = [];
  private readonly seen = new Set<string>();

  override async invoke(target: Target, opts?: unknown): Promise<unknown> {
    const key = typeof opts === 'object' && opts !== null ? Reflect.get(opts, 'idempotencyKey') : undefined;
    const id = typeof key === 'string' ? key : undefined;
    this.calls.push({ method: 'invoke', target, opts });
    this.keys.push(id);
    if (id !== undefined && this.seen.has(id)) return { accepted: true };
    if (id !== undefined) this.seen.add(id);
    this.executions += 1;
    return { accepted: true };
  }
}

describe('POST /v1/conversations/:id/runs', () => {
  it('admits the whole composer and replays one stable wake identity (one execution)', async () => {
    const raw = createMemoryStore();
    const seed = withDefaultOwner(raw, OWNER);
    await seedAgent(seed);
    const chatId = await seedChat(seed);
    await seed.put('library', { id: 'att-1', name: 'diagram.png', kind: 'image', mimeType: 'image/png', sizeBytes: 10, shared: 'private', source: 'upload', tags: [], pinned: false, createdAt: AT, updatedAt: AT });
    const runner = new IdempotentRunner();
    const app = makeApp(raw, new RunnerEnqueuer(runner.asRunner(), raw));
    const input = runInput(chatId, [{ id: 'msg-1', role: 'user', content: 'Look at this' }]);
    input['forwardedProps'] = { juno: { composer: {
      text: 'Look at this',
      attachments: [{ id: 'att-1', name: 'diagram.png', kind: 'image', mimeType: 'image/png', url: 'https://example.com/diagram.png' }],
      mentions: [],
      options: { model: 'model-x', background: false },
    } } };
    const first = await requestAs(app, OWNER, '/v1/conversations/' + chatId + '/runs', { method: 'POST', body: input });
    expect(first.status).toBe(202);
    const admitted = await first.json() as { item: { id: string; attachments: Array<{ id: string }> } };
    expect(admitted.item.attachments.map((attachment) => attachment.id)).toEqual(['att-1']);

    const replay = await requestAs(app, OWNER, '/v1/conversations/' + chatId + '/runs', { method: 'POST', body: input });
    expect(replay.status).toBe(202);
    expect((await replay.json() as { item: { id: string } }).item.id).toBe(admitted.item.id);
    expect(runner.keys).toHaveLength(2);
    expect(runner.keys[0]).toBeDefined();
    expect(runner.keys[0]).toBe(runner.keys[1]);
    expect(runner.executions).toBe(1);
  });

  it('rejects a changed body for the same stable message id without enqueueing it', async () => {
    const raw = createMemoryStore();
    const seed = withDefaultOwner(raw, OWNER);
    await seedAgent(seed);
    const chatId = await seedChat(seed);
    const runner = new IdempotentRunner();
    const app = makeApp(raw, new RunnerEnqueuer(runner.asRunner(), raw));
    const path = '/v1/conversations/' + chatId + '/runs';
    expect((await requestAs(app, OWNER, path, { method: 'POST', body: runInput(chatId, [{ id: 'same-id', role: 'user', content: 'original' }]) })).status).toBe(202);
    expect((await requestAs(app, OWNER, path, { method: 'POST', body: runInput(chatId, [{ id: 'same-id', role: 'user', content: 'changed' }]) })).status).toBe(409);
    expect(runner.keys).toHaveLength(1);
  });

  it('preserves a complete denial and rejects cancelled with an approving payload', async () => {
    const raw = createMemoryStore();
    const seed = withDefaultOwner(raw, OWNER);
    const chatId = await seedChat(seed);
    await seed.put('requests', { ...approval('req-deny', chatId, 'run-deny'), awakeableId: 'awk-deny' });
    const stub = new RunnerStub();
    const app = makeApp(raw, new RunnerEnqueuer(stub.asRunner(), raw));
    const path = '/v1/conversations/' + chatId + '/runs';
    const entry = { interruptId: 'req-deny', status: 'cancelled', payload: { action: 'approve' } };
    expect((await requestAs(app, OWNER, path, { method: 'POST', body: runInput(chatId, [], [entry]) })).status).toBe(400);
    expect((await seed.get('requests', 'req-deny'))?.status).toBe('pending');
    const denial = { action: 'deny', reason: 'revise', note: 'Change the recipient' };
    expect((await requestAs(app, OWNER, path, { method: 'POST', body: runInput(chatId, [], [{ ...entry, payload: denial }]) })).status).toBe(202);
    expect(await seed.get('requests', 'req-deny')).toMatchObject({ resolution: denial, decision: { note: denial.note, reason: denial.reason } });
    expect(stub.calls.find((call) => call.method === 'resolveAwakeable')?.opts).toEqual({ id: 'awk-deny', value: denial });
    expect((await requestAs(app, OWNER, path, { method: 'POST', body: runInput(chatId, [], [{ ...entry, payload: { ...denial, note: 'different' } }]) })).status).toBe(409);
  });

  it('refuses an empty turn, a mismatched thread and a foreign conversation', async () => {
    const raw = createMemoryStore();
    const seed = withDefaultOwner(raw, OWNER);
    await seedAgent(seed);
    const chatId = await seedChat(seed);
    const app = makeApp(raw, new NoopEnqueuer());
    expect((await requestAs(app, OWNER, '/v1/conversations/' + chatId + '/runs', { method: 'POST', body: runInput(chatId, []) })).status).toBe(400);
    expect((await requestAs(app, OWNER, '/v1/conversations/' + chatId + '/runs', { method: 'POST', body: runInput('other-thread', [{ id: 'm', role: 'user', content: 'hi' }]) })).status).toBe(400);
    expect((await requestAs(app, 'owner-other', '/v1/conversations/' + chatId + '/runs', { method: 'POST', body: runInput(chatId, [{ id: 'm', role: 'user', content: 'hi' }]) })).status).toBe(404);
  });

  it('refuses an invalid composer payload instead of falling back to the bare message text', async () => {
    const raw = createMemoryStore();
    const seed = withDefaultOwner(raw, OWNER);
    await seedAgent(seed);
    const chatId = await seedChat(seed);
    const app = makeApp(raw, new NoopEnqueuer());
    const attachments = Array.from({ length: 6 }, (_, i) => ({ id: 'att-' + i, name: 'f' + i + '.txt', kind: 'file' }));
    const body = { ...runInput(chatId, [{ id: 'm-too-many', role: 'user', content: 'x' }]), forwardedProps: { juno: { composer: { text: 'x', attachments } } } };
    const res = await requestAs(app, OWNER, '/v1/conversations/' + chatId + '/runs', { method: 'POST', body });
    expect(res.status).toBe(400);
    expect(await raw.get('items', 'm-too-many')).toBeNull();
  });

  it('refuses a resume that names a request of another conversation', async () => {
    const raw = createMemoryStore();
    const seed = withDefaultOwner(raw, OWNER);
    const chatA = await seedChat(seed, 'direct', 'conv-a');
    const chatB = await seedChat(seed, 'direct', 'conv-b');
    await seed.put('requests', { ...approval('req_stp-a', chatB, 'run-b'), awakeableId: 'awk-b' });
    const app = makeApp(raw, new NoopEnqueuer());
    const response = await requestAs(app, OWNER, '/v1/conversations/' + chatA + '/runs', {
      method: 'POST',
      body: runInput(chatA, [], [{ interruptId: 'req_stp-a', status: 'resolved', payload: { action: 'approve' } }]),
    });
    expect(response.status).toBe(400);
    expect(await seed.get('requests', 'req_stp-a')).toMatchObject({ status: 'pending' });
  });

  it('answers every pending request of one run, and an invalid batch changes nothing', async () => {
    const raw = createMemoryStore();
    const seed = withDefaultOwner(raw, OWNER);
    const chatId = await seedChat(seed);
    await seed.put('requests', { ...approval('req_stp-a', chatId, 'run-one'), awakeableId: 'awk-a' });
    await seed.put('requests', { ...approval('req_stp-b', chatId, 'run-one'), awakeableId: 'awk-b' });
    const stub = new RunnerStub();
    const app = makeApp(raw, new RunnerEnqueuer(stub.asRunner(), raw));

    const partial = await requestAs(app, OWNER, '/v1/conversations/' + chatId + '/runs', {
      method: 'POST',
      body: runInput(chatId, [], [{ interruptId: 'req_stp-a', status: 'resolved', payload: { action: 'approve' } }]),
    });
    expect(partial.status).toBe(400);
    expect(await seed.get('requests', 'req_stp-a')).toMatchObject({ status: 'pending' });
    expect(await seed.get('requests', 'req_stp-b')).toMatchObject({ status: 'pending' });

    const duplicate = await requestAs(app, OWNER, '/v1/conversations/' + chatId + '/runs', {
      method: 'POST',
      body: runInput(chatId, [], [
        { interruptId: 'req_stp-a', status: 'resolved', payload: { action: 'approve' } },
        { interruptId: 'req_stp-a', status: 'cancelled' },
      ]),
    });
    expect(duplicate.status).toBe(400);
    expect(await seed.get('requests', 'req_stp-a')).toMatchObject({ status: 'pending' });

    const all = await requestAs(app, OWNER, '/v1/conversations/' + chatId + '/runs', {
      method: 'POST',
      body: runInput(chatId, [], [
        { interruptId: 'req_stp-a', status: 'resolved', payload: { action: 'approve' } },
        { interruptId: 'req_stp-b', status: 'resolved', payload: { action: 'approve' } },
      ]),
    });
    expect(all.status).toBe(202);
    expect(await seed.get('requests', 'req_stp-a')).toMatchObject({ status: 'approved' });
    expect(await seed.get('requests', 'req_stp-b')).toMatchObject({ status: 'approved' });
  });

  it('validates the whole batch before persisting: an invalid typed answer records nothing', async () => {
    const raw = createMemoryStore();
    const seed = withDefaultOwner(raw, OWNER);
    const chatId = await seedChat(seed);
    await seed.put('requests', { ...approval('req_stp-a', chatId, 'run-one'), awakeableId: 'awk-a' });
    await seed.put('requests', { ...question('req_stp-q', chatId, 'run-one'), awakeableId: 'awk-q' });
    const app = makeApp(raw, new RunnerEnqueuer(new RunnerStub().asRunner(), raw));
    const response = await requestAs(app, OWNER, '/v1/conversations/' + chatId + '/runs', {
      method: 'POST',
      body: runInput(chatId, [], [
        { interruptId: 'req_stp-a', status: 'resolved', payload: { action: 'approve' } },
        { interruptId: 'req_stp-q', status: 'resolved', payload: { action: 'answer', answers: { unknown: 'x' } } },
      ]),
    });
    expect(response.status).toBe(400);
    expect(await seed.get('requests', 'req_stp-a')).toMatchObject({ status: 'pending' });
    expect(await seed.get('requests', 'req_stp-q')).toMatchObject({ status: 'pending' });
  });

  it('re-delivers a decision whose first delivery failed, without deciding twice', async () => {
    const raw = createMemoryStore();
    const seed = withDefaultOwner(raw, OWNER);
    const chatId = await seedChat(seed);
    await seed.put('requests', { ...approval('req_stp-a', chatId, 'run-one'), awakeableId: 'awk-a' });
    const stub = new RunnerStub();
    stub.failWith = new Error('restate ingress unavailable');
    const input = runInput(chatId, [], [{ interruptId: 'req_stp-a', status: 'resolved', payload: { action: 'approve' } }]);
    const failing = makeApp(raw, new RunnerEnqueuer(stub.asRunner(), raw));
    expect((await requestAs(failing, OWNER, '/v1/conversations/' + chatId + '/runs', { method: 'POST', body: input })).status).toBe(502);
    expect(await seed.get('requests', 'req_stp-a')).toMatchObject({ status: 'approved' });
    expect((await seed.get('requests', 'req_stp-a'))?.wakeDeliveredAt).toBeUndefined();

    stub.failWith = undefined;
    const healthy = makeApp(raw, new RunnerEnqueuer(stub.asRunner(), raw));
    const retry = await requestAs(healthy, OWNER, '/v1/conversations/' + chatId + '/runs', { method: 'POST', body: input });
    expect(retry.status).toBe(202);
    expect((await seed.get('requests', 'req_stp-a'))?.wakeDeliveredAt).toBeDefined();
    expect(stub.calls.filter((call) => call.method === 'resolveAwakeable')).toHaveLength(2);
  });
});

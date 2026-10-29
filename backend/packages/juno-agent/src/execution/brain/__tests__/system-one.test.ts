/**
 * System One (BACKEND §10.14): the resolver order, the `systemone` wire against a fake server with the documented request
 * shape, and the emulation over the fast model (strict JSON, fail closed).
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { appSettingsSchema, settingsIdFor } from '@agent-desktop/public-contracts';
import type { Store } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { runWithOwner } from '../../../owner-context.js';
import { createBrain } from '../index.js';
import { describeSystemOne, readSystemOneEnv, resolveSystemOne } from '../system-one.js';
import { createJevSystemOne } from '../system-one-jev.js';
import { createEmulatedSystemOne } from '../system-one-emulation.js';
import { sealProviderKey } from '../user-providers.js';

const OWNER = 'owner-a';
const NOW = '2026-10-15T00:00:00.000Z';
const PLATFORM = { baseUrl: 'https://platform.example', apiKey: 'platform-key', modelId: 'jev-latest' };

const baseSettings = appSettingsSchema.parse({
  general: { launchAtLogin: false, language: 'en' },
  appearance: { theme: 'system', density: 'comfortable', accent: 'blue' },
  notifications: [],
  yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
  connections: { serverUrl: '', modelProviders: [] },
  privacy: { dataRetentionDays: 90, trainingOptIn: false },
  advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
});

async function seed(store: Store, systemOneModel?: { providerId: string; modelId: string }): Promise<void> {
  await runWithOwner(OWNER, async () => {
    await store.put('modelProviders', { id: 'mprov-s1', ownerId: OWNER, kind: 'systemone', name: 'Jev', baseUrl: 'https://owner.example', models: ['jev-latest', 'jev-mini'], apiKey: sealProviderKey('owner-key'), createdAt: NOW, updatedAt: NOW });
    await store.put('settings', { ...baseSettings, models: { defaultModel: null, ...(systemOneModel === undefined ? {} : { systemOneModel }) }, id: settingsIdFor(OWNER) });
  });
}
const resolve = (store: Store, platform?: typeof PLATFORM) => runWithOwner(OWNER, () => resolveSystemOne(store, OWNER, platform));

beforeAll(() => {
  process.env['SECRETS_KEY'] = randomBytes(32).toString('base64');
});

describe('resolveSystemOne order', () => {
  it('prefers the owner\'s chosen model, then the platform endpoint, else nothing (the fast model then emulates)', async () => {
    const store = createMemoryStore();
    await seed(store, { providerId: 'mprov-s1', modelId: 'jev-mini' });
    expect(await resolve(store, PLATFORM)).toMatchObject({ source: 'chosen', providerId: 'mprov-s1', endpoint: { baseUrl: 'https://owner.example', apiKey: 'owner-key', modelId: 'jev-mini' } });
    expect(await resolve(store)).toMatchObject({ source: 'chosen' });

    const unset = createMemoryStore();
    await seed(unset);
    expect(await resolve(unset, PLATFORM)).toMatchObject({ source: 'platform', providerId: null, endpoint: PLATFORM });
    expect(await resolve(unset)).toBeUndefined();
  });

  it('falls through when the choice is unusable (provider gone, model no longer listed)', async () => {
    for (const choice of [{ providerId: 'mprov-gone', modelId: 'jev-latest' }, { providerId: 'mprov-s1', modelId: 'removed' }]) {
      const store = createMemoryStore();
      await seed(store, choice);
      expect(await resolve(store, PLATFORM)).toMatchObject({ source: 'platform' });
    }
  });

  it('describes the choice, the platform, the fast model emulating, or nothing; the platform needs a base URL and a key', async () => {
    const fast = { providerId: null, modelId: 'qwen', source: 'agent' as const };
    expect(describeSystemOne({ source: 'platform', providerId: null, endpoint: PLATFORM }, fast)).toEqual({ providerId: null, modelId: 'jev-latest', source: 'platform' });
    expect(describeSystemOne(undefined, fast)).toEqual({ providerId: null, modelId: 'qwen', source: 'fast-model-emulation' });
    expect(describeSystemOne(undefined, null)).toBeNull();
    expect(readSystemOneEnv({ SYSTEM_ONE_BASE_URL: 'https://x' })).toBeUndefined();
    expect(readSystemOneEnv({ SYSTEM_ONE_BASE_URL: 'https://x', SYSTEM_ONE_API_KEY: 'k' })).toEqual({ baseUrl: 'https://x', apiKey: 'k', modelId: 'jev-latest' });
  });
});

describe('the systemone wire', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  /** A fake endpoint that records the request and answers `reply` (status 200 unless given). */
  async function fake(reply: unknown, status = 200) {
    const seen: { url?: string; auth?: string; body?: unknown; headers?: IncomingHttpHeaders } = {};
    server = createServer((request: IncomingMessage, response) => {
      let text = '';
      request.on('data', (chunk) => { text += String(chunk); });
      request.on('end', () => {
        seen.url = request.url ?? '';
        seen.auth = request.headers.authorization ?? '';
        seen.headers = request.headers;
        seen.body = JSON.parse(text);
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
    return { seen, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }
  const questions = {
    ok: { type: 'noul', instructions: 'Is it fine?' },
    where: { type: 'choice', instructions: 'Which?', options: { a: 'first', b: 'second' } },
    level: { type: 'score', instructions: 'How bad?', levels: ['low', 'mid', 'high'] },
  } as const;
  const jevReply = {
    model: 'jev-1.13.0',
    answers: {
      ok: { type: 'noul', noul: 0.68 },
      where: { type: 'choice', choice: 'b', probabilities: { b: 0.85, a: 0.15 }, confidence: 0.82 },
      level: { type: 'score', score: 1.32, legend: { 0: 'low', 1: 'mid', 2: 'high' }, probabilities: { 0: 0, 1: 0.68, 2: 0.32 }, confidence: 0.52 },
    },
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  it('sends the documented request and maps all three answer types', async () => {
    const { seen, baseUrl } = await fake(jevReply);
    const answers = await createJevSystemOne({ baseUrl, apiKey: 'sk-1', modelId: 'jev-latest' }).ask('the state', questions, AbortSignal.timeout(5000));
    expect(seen.url).toBe('/v1/systemone');
    expect(seen.auth).toBe('Bearer sk-1');
    expect(seen.headers?.['session-id']).toBeUndefined();
    expect(seen.headers?.['x-client-request-id']).toBeUndefined();
    expect(seen.body).toEqual({
      model: 'jev-latest',
      state: 'the state',
      questions: {
        ok: { type: 'noul', instructions: 'Is it fine?' },
        where: { type: 'choice', instructions: 'Which?', criteria: { a: 'first', b: 'second' } },
        level: { type: 'score', instructions: 'How bad?', criteria: ['low', 'mid', 'high'] },
      },
    });
    expect(answers).toEqual({
      ok: { type: 'noul', probability: 0.68 },
      where: { type: 'choice', choice: 'b', probabilities: { a: 0.15, b: 0.85 }, confidence: 0.82 },
      level: { type: 'score', score: 1.32, probabilities: [0, 0.68, 0.32], confidence: 0.52 },
    });
  });

  it('preserves structured browser state on the native wire instead of double encoding it', async () => {
    const { seen, baseUrl } = await fake(jevReply);
    const native = createJevSystemOne({ baseUrl, apiKey: 'k', modelId: 'jev-latest' });
    const state = { page: { elements: [{ i: 7, label: '2026-11-06' }] }, task: { goal: 'Choose November 6' } };
    const options = { allowEmulation: false, stateEncoding: 'json' as const };
    await native.ask(JSON.stringify(state), { ...questions, where: { ...questions.where, options: { a: null, b: null } } }, AbortSignal.timeout(5000), options);
    expect(seen.body).toMatchObject({ state, questions: { where: { criteria: { a: null, b: null } } } });
  });

  it('forwards only validated hashed session and request attribution headers', async () => {
    const { seen, baseUrl } = await fake(jevReply);
    const native = createJevSystemOne({ baseUrl, apiKey: 'k', modelId: 'jev-latest' });
    const hash = (value: string): string => 'juno-' + createHash('sha256').update(value).digest('hex').slice(0, 32);
    const sessionId = hash('agent:conversation');
    const requestId = hash('run');
    await native.ask('task only', questions, AbortSignal.timeout(5000), { allowEmulation: false, sessionId, requestId });
    expect(seen.headers?.['session-id']).toBe(sessionId);
    expect(seen.headers?.['x-client-request-id']).toBe(requestId);
    expect(seen.body).toMatchObject({ state: 'task only' });

    await native.ask('raw ids stay outside model state', questions, AbortSignal.timeout(5000), {
      sessionId: 'agent:conversation', requestId: 'run',
    });
    expect(seen.headers?.['session-id']).toBeUndefined();
    expect(seen.headers?.['x-client-request-id']).toBeUndefined();
    expect(JSON.stringify(seen.body)).not.toContain('agent:conversation');
  });

  it.each([
    ['an error status', { error: 'nope' }, 401],
    ['a missing answer', { answers: { ok: jevReply.answers.ok } }, 200],
    ['an answer of the wrong type', { answers: { ...jevReply.answers, ok: { type: 'choice', choice: 'a' } } }, 200],
    ['an option that was not offered', { answers: { ...jevReply.answers, where: { type: 'choice', choice: 'z', probabilities: { z: 1 }, confidence: 1 } } }, 200],
    ['a probability above 1', { answers: { ...jevReply.answers, ok: { type: 'noul', noul: 1.4 } } }, 200],
  ])('fails closed on %s', async (_name, reply, status) => {
    const { baseUrl } = await fake(reply, status);
    await expect(createJevSystemOne({ baseUrl, apiKey: 'k', modelId: 'm' }).ask('s', questions, AbortSignal.timeout(5000))).rejects.toThrow();
  });
});

describe('System One emulated by the fast model', () => {
  const questions = {
    ok: { type: 'noul', instructions: 'Fine?' },
    where: { type: 'choice', instructions: 'Which?', options: { a: 'first', b: 'second', c: 'third' } },
    level: { type: 'score', instructions: 'How bad?', levels: ['low', 'high'] },
  } as const;
  const ask = (reply: string | null) => createEmulatedSystemOne(async () => reply).ask('state', questions, AbortSignal.timeout(5000));

  it('maps the stated answers onto the typed answers', async () => {
    const answers = await ask('{"ok":{"probability":0.9},"where":{"choice":"b","confidence":0.8},"level":{"level":1,"confidence":0.7}}');
    expect(answers).toEqual({
      ok: { type: 'noul', probability: 0.9 },
      where: { type: 'choice', choice: 'b', probabilities: { a: expect.closeTo(0.1), b: 0.8, c: expect.closeTo(0.1) }, confidence: 0.8 },
      level: { type: 'score', score: 1, probabilities: [expect.closeTo(0.3), 0.7], confidence: 0.7 },
    });
  });

  it.each([
    ['no answer', null],
    ['prose', 'Sure! I think yes.'],
    ['a missing question', '{"ok":{"probability":0.9}}'],
    ['an unknown option', '{"ok":{"probability":0.9},"where":{"choice":"z","confidence":0.8},"level":{"level":1,"confidence":0.7}}'],
    ['a probability outside 0..1', '{"ok":{"probability":90},"where":{"choice":"a","confidence":0.8},"level":{"level":1,"confidence":0.7}}'],
    ['a level out of range', '{"ok":{"probability":0.9},"where":{"choice":"a","confidence":0.8},"level":{"level":2,"confidence":0.7}}'],
  ])('fails closed on %s', async (_name, reply) => {
    await expect(ask(reply)).rejects.toThrow();
  });

  it('is what the brain uses when there is no System One model, and null when there is no model at all', async () => {
    const store = createMemoryStore();
    await runWithOwner(OWNER, () => store.put('settings', { ...baseSettings, models: { defaultModel: null }, id: settingsIdFor(OWNER) }));
    const chat = vi.fn(async () => ({ text: '{"ok":{"probability":0.2}}', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }));
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: { call: chat } as never });
    const one = { ok: { type: 'noul', instructions: 'Fine?' } } as const;
    expect(await runWithOwner(OWNER, () => brain.systemOne?.ask('s', one, AbortSignal.timeout(5000)))).toEqual({ ok: { type: 'noul', probability: 0.2 } });
    expect(chat).toHaveBeenCalledTimes(1);
    const bare = await createBrain({ store, blobs: createMemoryBlobStore() });
    expect(await runWithOwner(OWNER, () => bare.systemOne?.ask('s', one, AbortSignal.timeout(5000)))).toBeNull();
  });
});

describe('native-only discovery (allowEmulation false)', () => {
  let nativeServer: Server | undefined;
  afterEach(() => nativeServer?.close());

  it('spends no fast-model call without a Jev endpoint, while the default still emulates', async () => {
    const store = createMemoryStore();
    await runWithOwner(OWNER, () => store.put('settings', { ...baseSettings, models: { defaultModel: null }, id: settingsIdFor(OWNER) }));
    const chat = vi.fn(async () => ({ text: '{"ok":{"probability":0.2}}', toolCalls: [], stopReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }));
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: { call: chat } as never });
    const one = { ok: { type: 'noul', instructions: 'Fine?' } } as const;
    await runWithOwner(OWNER, async () => {
      expect(await brain.systemOne?.ask('s', one, AbortSignal.timeout(5000), { allowEmulation: false })).toBeNull();
      expect(chat).not.toHaveBeenCalled();
      expect(await brain.systemOne?.ask('s', one, AbortSignal.timeout(5000))).toEqual({ ok: { type: 'noul', probability: 0.2 } });
      expect(chat).toHaveBeenCalledTimes(1);
    });
  });

  it('still answers through the platform native endpoint instead of returning null', async () => {
    const reply = { model: 'jev-1.13.0', answers: { ok: { type: 'noul', noul: 0.68 } }, usage: { input_tokens: 1, output_tokens: 1 } };
    let headers: IncomingHttpHeaders | undefined;
    nativeServer = createServer((request: IncomingMessage, response) => {
      request.resume();
      request.on('end', () => {
        headers = request.headers;
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((done) => nativeServer?.listen(0, '127.0.0.1', done));
    const baseUrl = 'http://127.0.0.1:' + String((nativeServer.address() as AddressInfo).port);
    const store = createMemoryStore();
    const chat = vi.fn(async () => ({ text: '{}', toolCalls: [], stopReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }));
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: { call: chat } as never, systemOne: { baseUrl, apiKey: 'k', modelId: 'jev-latest' } });
    const one = { ok: { type: 'noul', instructions: 'Fine?' } } as const;
    const sessionId = 'juno-' + createHash('sha256').update('agent:conversation').digest('hex').slice(0, 32);
    const requestId = 'juno-' + createHash('sha256').update('run').digest('hex').slice(0, 32);
    expect(await brain.systemOne?.ask('s', one, AbortSignal.timeout(5000), { allowEmulation: false, sessionId, requestId })).toEqual({ ok: { type: 'noul', probability: 0.68 } });
    expect(headers?.['session-id']).toBe(sessionId);
    expect(headers?.['x-client-request-id']).toBe(requestId);
    expect(chat).not.toHaveBeenCalled();
  });
});

/**
 * PH5 provider recovery.
 *
 * The classification half drives the REAL provider against a real HTTP fixture, so auth/quota/transient/
 * overflow are decided from the adapter's response status and pi-ai's own overflow predicate rather than
 * a message guess. The recovery half drives the real Run loop with a failing provider: bounded retries,
 * truthful terminal reasons, one compaction on overflow, stable journal keys (no duplicate provider
 * effect on a replay), cancellation preserved, and a truncated length turn never reported as complete.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { RestatePromise, TerminalError } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { AssistantTurn, Brain, BrainContext, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import type { Message } from '@earendil-works/pi-ai';
import { backendConfigSchema } from '../../config.js';
import { classifyProviderFailure, ProviderFailureError, retryAfterMsOf, responseStatus } from '../../brain/model-failure.js';
import { retryDelayMs } from '../engines/pi-core/recovery.js';
import { createOpenAIProvider } from '../../brain/provider.js';
import { createRunCancellation, NEVER_CANCELLED, type CancelSource } from '../services/cancel.js';
import { runLoop } from '../services/run-loop.js';
import type { RunContext, RunInput, RunServices } from '../services/run-types.js';

const AT = '2026-10-08T00:00:00.000Z';
const AGENT = 'agent-ph5';
const CONV = 'conv-ph5';
const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };

interface Fixture {
  url: string;
  reply(status: number, body: unknown, headers?: Record<string, string>): void;
  close(): Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  let status = 200;
  let body: unknown = {};
  let headers: Record<string, string> = {};
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model', context_window: 128000, max_output_tokens: 8192 }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server did not bind a port');
  return {
    url: 'http://127.0.0.1:' + String(address.port) + '/v1',
    reply: (nextStatus, nextBody, nextHeaders = {}) => {
      status = nextStatus;
      body = nextBody;
      headers = nextHeaders;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const configFor = (url: string) => backendConfigSchema.parse({
  DATABASE_URL: 'postgres://localhost',
  AGENTD_PORT: 8787,
  API_TOKEN: 'dev-token', OWNER_ID: 'user-1', MODEL_BASE_URL: url, MODEL_WIRE_API: 'chat', MODEL_API_KEY: 'sk-secret-key',
  MODEL_ID: 'test-model', FAST_MODEL_ID: '', FAST_MODEL_BASE_URL: '', FAST_MODEL_API_KEY: '', SYSTEM_ONE_BASE_URL: '', SYSTEM_ONE_API_KEY: '', SYSTEM_ONE_MODEL_ID: '',
});

const userMessage: Message = { role: 'user', content: 'hello', timestamp: 1 };
const errorBody = (message: string) => ({ error: { message, type: 'invalid_request_error' } });

async function failureFor(reply: (fixture: Fixture) => void): Promise<ProviderFailureError> {
  const fixture = await startFixture();
  try {
    reply(fixture);
    const provider = createOpenAIProvider(configFor(fixture.url));
    const thrown = await provider
      .call({ messages: [userMessage], tools: [], signal: new AbortController().signal })
      .then(() => null, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(ProviderFailureError);
    if (!(thrown instanceof ProviderFailureError)) throw new Error('expected a classified provider failure');
    return thrown;
  } finally {
    await fixture.close();
  }
}

describe('provider failure classification on the real wire', () => {
  it('classifies an authentication failure as terminal auth', async () => {
    const failure = await failureFor((fixture) => fixture.reply(401, errorBody('Invalid API key provided')));
    expect(failure.failure.kind).toBe('auth');
    expect(failure.message).toContain('authentication failed');
  });

  it('classifies a rate limit as quota and keeps the announced retry delay', async () => {
    const failure = await failureFor((fixture) => fixture.reply(429, errorBody('Rate limit reached'), { 'retry-after': '2' }));
    expect(failure.failure.kind).toBe('quota');
    // The adapter surfaces response headers only for a successful response, so the retry delay is read
    // from the real ProviderResponse shape the SDK defines (asserted here) and honoured at the run
    // boundary (the recovery test below proves the truthfully reported delay).
    const response = { status: 429, headers: { 'retry-after': '2' } };
    expect(responseStatus(response)).toBe(429);
    expect(retryAfterMsOf(response)).toBe(2000);
    // `retry-after-ms` is already milliseconds and must not be scaled again.
    expect(retryAfterMsOf({ status: 429, headers: { 'retry-after-ms': '1500' } })).toBe(1500);
    expect(classifyProviderFailure(undefined, response, undefined).retryAfterMs).toBe(2000);
  });

  it('classifies a server error as transient and a bad request as invalid', async () => {
    const server = await failureFor((fixture) => fixture.reply(500, errorBody('upstream exploded')));
    expect(server.failure.kind).toBe('transient');
    const bad = await failureFor((fixture) => fixture.reply(400, errorBody('missing model field')));
    expect(bad.failure.kind).toBe('invalid_request');
  });

  it('classifies a context overflow body through the SDK overflow predicate', async () => {
    const failure = await failureFor((fixture) => fixture.reply(400, errorBody('context_length_exceeded: too many tokens in the prompt')));
    expect(failure.failure.kind).toBe('context_overflow');
  });
});

function wake(): WakeEvent {
  return {
    id: 'wake-1', ownerId: 'owner-ph5', agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV,
    kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user',
    payload: { text: 'go', addressed: 'direct' }, at: AT, status: 'accepted',
  };
}
const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: AGENT + ':' + CONV, wakeEvents: [wake()] };
const emptyRegistry: ToolRegistry = { forAgent: async () => [], get: () => undefined };

function journalContext(shared?: Map<string, unknown>, sleeps: number[] = []): { ctx: RunContext; names: string[] } {
  const names: string[] = [];
  const journal = shared ?? new Map<string, unknown>();
  const used = new Set<string>();
  let seq = 0;
  return {
    names,
    ctx: {
      rand: { uuidv4: () => 'id-' + String(seq++) },
      run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
        if (used.has(name)) throw new Error('duplicate durable step: ' + name);
        used.add(name);
        names.push(name);
        if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
        return RestatePromise.resolve(action().then((value) => {
          journal.set(name, structuredClone(value));
          return value;
        }));
      },
      awakeable<T>(): { id: string; promise: RestatePromise<T> } {
        return { id: 'awake-' + String(seq++), promise: RestatePromise.resolve(new Promise<T>(() => {})) };
      },
      drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
      sleep: (ms: number) => {
        sleeps.push(ms);
        return RestatePromise.resolve<void>(undefined);
      },
    },
  };
}

function final(text: string): AssistantTurn {
  return { text, toolCalls: [], usage, stopReason: 'stop' };
}
function lengthTurn(text: string): AssistantTurn {
  return { text, toolCalls: [], usage, stopReason: 'length' };
}
function runDoc(): {
  id: string; agentId: string; conversationId: string; title: string; status: string; kind: string;
  steps: never[]; usage: { inputTokens: number; outputTokens: number; computeSeconds: number; costUsd: number; steps: number };
  startedAt: string; lastActivityAt: string;
} {
  return {
    id: 'run-1', agentId: AGENT, conversationId: CONV, title: 'test', status: 'running', kind: 'chat', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  };
}

/** A provider that fails with the scripted errors, then answers normally. */
function failingBrain(failures: Error[], then: AssistantTurn): { brain: Brain; attempts: () => number } {
  let attempts = 0;
  const brain: Brain = {
    async buildContext(): Promise<BrainContext> {
      return { sessionKey: input.sessionKey, agentId: AGENT };
    },
    async step(): Promise<AssistantTurn> {
      attempts += 1;
      const next = failures.shift();
      if (next !== undefined) throw next;
      return then;
    },
    shouldCompact: () => false,
    async compact(ctx) {
      return ctx;
    },
  };
  return { brain, attempts: () => attempts };
}

const transient = () => new ProviderFailureError({ kind: 'transient', code: 'transient', message: 'Model request failed: 502' });
const auth = () => new ProviderFailureError({ kind: 'auth', code: 'auth', message: 'Model authentication failed (401): bad key' });
const overflow = () => new ProviderFailureError({ kind: 'context_overflow', code: 'context_overflow', message: 'Model context overflow' });

async function drive(brain: Brain, names: string[], journal?: Map<string, unknown>): Promise<unknown> {
  const store = createMemoryStore();
  await store.put('runs', runDoc() as never, { conversationId: CONV });
  const h = journalContext(journal);
  const outcome = await runLoop(h.ctx, { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: emptyRegistry }, input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED)
    .then((value) => value, (error: unknown) => error);
  names.push(...h.names);
  return outcome;
}

describe('bounded provider recovery through the run', () => {
  it('retries a transient failure within a bounded budget and completes', async () => {
    const names: string[] = [];
    const provider = failingBrain([transient(), transient()], final('recovered'));
    const outcome = await drive(provider.brain, names);
    expect(outcome).toBe('completed');
    expect(provider.attempts()).toBe(3);
    expect(names).toEqual(expect.arrayContaining(['model:0', 'model:0:retry:1', 'model:0:retry:2']));
  });

  it('fails terminally with a truthful reason instead of retrying unboundedly', async () => {
    const names: string[] = [];
    const provider = failingBrain([transient(), transient(), transient(), transient()], final('never reached'));
    const outcome = await drive(provider.brain, names);
    expect(outcome).toBeInstanceOf(TerminalError);
    if (outcome instanceof TerminalError) {
      expect(outcome.message).toContain('kept failing after 3 attempts');
      expect(outcome.metadata).toMatchObject({ code: 'transient' });
    }
    expect(provider.attempts()).toBe(3);
  });

  it('backs off durably before each transient retry, honouring a short retry-after', async () => {
    const sleeps: number[] = [];
    const quotaRetry = new ProviderFailureError({ kind: 'quota', code: 'quota', message: 'Model quota exhausted (429)', retryAfterMs: 3000 });
    const provider = failingBrain([transient(), quotaRetry], final('recovered'));
    const h = journalContext(undefined, sleeps);
    const store = createMemoryStore();
    await store.put('runs', runDoc() as never, { conversationId: CONV });
    const outcome = await runLoop(h.ctx, { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: provider.brain, toolRegistry: emptyRegistry }, input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED)
      .then((value) => value, (error: unknown) => error);
    expect(outcome).toBe('completed');
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(sleeps[0]).toBeLessThan(1000);
    expect(sleeps[1]).toBe(3000);
  });

  it('computes a bounded, replay-stable backoff and skips a long retry-after', () => {
    const seed = 'run-1:0:1';
    expect(retryDelayMs(0, undefined, seed)).toBe(retryDelayMs(0, undefined, seed));
    expect(retryDelayMs(0, undefined, seed)).toBeGreaterThanOrEqual(500);
    expect(retryDelayMs(0, undefined, seed)).toBeLessThan(1000);
    expect(retryDelayMs(1, undefined, seed)!).toBeGreaterThanOrEqual(1000);
    expect(retryDelayMs(9, undefined, seed)).toBeLessThanOrEqual(8000);
    expect(retryDelayMs(0, 2000, seed)).toBe(2000);
    expect(retryDelayMs(0, 45_000, seed)).toBeUndefined();
  });

  it('falls back once to the snapshot model after the primary retries are spent, and serves the turn there', async () => {
    const seen: string[] = [];
    const brain: Brain = {
      async buildContext(): Promise<BrainContext> {
        return { sessionKey: input.sessionKey, agentId: AGENT };
      },
      async step(ctx): Promise<AssistantTurn> {
        const model = String((ctx['modelSelection'] as { modelId: string }).modelId);
        seen.push(model);
        if (model === 'primary') throw transient();
        return final('from fallback');
      },
      shouldCompact: () => false,
      async compact(ctx) {
        return ctx;
      },
    };
    const store = createMemoryStore();
    await store.put('runs', runDoc() as never, { conversationId: CONV });
    const h = journalContext();
    const brainCtx: BrainContext = {
      sessionKey: input.sessionKey, agentId: AGENT,
      modelSelection: { modelId: 'primary', baseUrl: 'http://fixture.invalid/v1', supportsImages: false, fallback: { modelId: 'fallback' } },
    };
    const outcome = await runLoop(h.ctx, { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: emptyRegistry }, input, 'run-1', brainCtx, NEVER_CANCELLED);
    expect(outcome).toBe('completed');
    expect(seen).toEqual(['primary', 'primary', 'primary', 'fallback']);
    expect(h.names).toContain('model:0:fallback:3');
    // The usage ledger records the model that actually served the turn.
    expect(await store.get('runs', 'run-1')).toMatchObject({ model: 'fallback' });
  });

  it('never falls back on an authentication failure', async () => {
    const seen: string[] = [];
    const brain: Brain = {
      async buildContext(): Promise<BrainContext> {
        return { sessionKey: input.sessionKey, agentId: AGENT };
      },
      async step(ctx): Promise<AssistantTurn> {
        seen.push(String((ctx['modelSelection'] as { modelId: string }).modelId));
        throw auth();
      },
      shouldCompact: () => false,
      async compact(ctx) {
        return ctx;
      },
    };
    const store = createMemoryStore();
    await store.put('runs', runDoc() as never, { conversationId: CONV });
    const brainCtx: BrainContext = {
      sessionKey: input.sessionKey, agentId: AGENT,
      modelSelection: { modelId: 'primary', baseUrl: 'http://fixture.invalid/v1', supportsImages: false, fallback: { modelId: 'fallback' } },
    };
    const outcome = await runLoop(journalContext().ctx, { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: emptyRegistry }, input, 'run-1', brainCtx, NEVER_CANCELLED)
      .then((value) => value, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(TerminalError);
    expect(seen).toEqual(['primary']);
  });

  it('compacts exactly once on a context overflow, then the run continues', async () => {
    const names: string[] = [];
    const provider = failingBrain([overflow()], final('streamed'));
    const outcome = await drive(provider.brain, names);
    expect(outcome).toBe('completed');
    expect(provider.attempts()).toBe(2);
    expect(names.filter((name) => name === 'compact:0:recovery')).toHaveLength(1);
  });

  it('fails truthfully when the overflow repeats after the one compaction', async () => {
    const names: string[] = [];
    const provider = failingBrain([overflow(), overflow(), overflow()], final('x'));
    const outcome = await drive(provider.brain, names);
    expect(outcome).toBeInstanceOf(TerminalError);
    expect(provider.attempts()).toBe(2);
    expect(names.filter((name) => name === 'compact:0:recovery')).toHaveLength(1);
  });

  it('never reports a truncated token-limit turn as complete', async () => {
    const provider = failingBrain([], lengthTurn('cut off mid sentence'));
    const outcome = await drive(provider.brain, []);
    expect(outcome).not.toBe('completed');
  });

  it('keeps a cancelled run stopped without calling the provider', async () => {
    const provider = failingBrain([], final('never reached'));
    const store = createMemoryStore();
    await store.put('runs', runDoc() as never, { conversationId: CONV });
    const cancelled: CancelSource = { peek: async () => true, get: () => RestatePromise.resolve(true) };
    const outcome = await runLoop(
      journalContext().ctx,
      { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: provider.brain, toolRegistry: emptyRegistry },
      input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, createRunCancellation(cancelled),
    );
    expect(outcome).toBe('stopped');
    expect(provider.attempts()).toBe(0);
  });

  it('replays a committed journal without a duplicate provider effect', async () => {
    const shared = new Map<string, unknown>();
    const first = failingBrain([], final('recovered'));
    expect(await drive(first.brain, [], shared)).toBe('completed');
    expect(first.attempts()).toBe(1);

    // The provider must not run again: every durable model step replays from the shared journal.
    const replay = failingBrain([], final('must not be called'));
    const forbidden: Brain = {
      ...replay.brain,
      async step(): Promise<AssistantTurn> {
        throw new Error('the provider must not be called on replay');
      },
    };
    expect(await drive(forbidden, [], shared)).toBe('completed');
  });

  it('journals a classified failure as a fulfilled outcome, so a replay never re-calls the provider', async () => {
    const shared = new Map<string, unknown>();
    const first = failingBrain([transient(), transient()], final('recovered'));
    expect(await drive(first.brain, [], shared)).toBe('completed');
    expect(first.attempts()).toBe(3);
    // The real-run contract: each attempt is a cached, FULFILLED outcome (never a rejected step), so
    // the runtime cannot retry it and a replay returns it instead of calling the provider again.
    expect(shared.get('model:0')).toMatchObject({ outcome: { kind: 'provider_failure' } });
    expect(shared.get('model:0:retry:1')).toMatchObject({ outcome: { kind: 'provider_failure' } });
    expect(shared.get('model:0:retry:2')).toMatchObject({ outcome: { kind: 'turn' } });

    let replayCalls = 0;
    const replay: Brain = {
      async buildContext(): Promise<BrainContext> {
        return { sessionKey: input.sessionKey, agentId: AGENT };
      },
      async step(): Promise<AssistantTurn> {
        replayCalls += 1;
        throw new Error('the provider must not be called on replay');
      },
      shouldCompact: () => false,
      async compact(ctx) {
        return ctx;
      },
    };
    expect(await drive(replay, [], shared)).toBe('completed');
    expect(replayCalls).toBe(0);
  });

  it('retries a context overflow with the context the compaction returned', async () => {
    const contexts: boolean[] = [];
    const failures = [overflow()];
    const brain: Brain = {
      async buildContext(): Promise<BrainContext> {
        return { sessionKey: input.sessionKey, agentId: AGENT };
      },
      async step(ctx): Promise<AssistantTurn> {
        contexts.push(ctx['compacted'] === true);
        const next = failures.shift();
        if (next !== undefined) throw next;
        return final('after compaction');
      },
      shouldCompact: () => false,
      async compact(ctx) {
        // A compaction returns a NEW context; the retry must build on it, not on the overflowed one.
        return { ...ctx, compacted: true };
      },
    };

    expect(await drive(brain, [])).toBe('completed');
    expect(contexts).toEqual([false, true]);
  });

  it('replays a raw assistant turn journaled under the first key by the previous build', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc() as never, { conversationId: CONV });
    // The pre-PH5 build journaled the raw turn under the same first key; a replay must normalize it.
    const shared = new Map<string, unknown>([['model:0', final('old reply')]]);
    let calls = 0;
    const provider: Brain = {
      async buildContext(): Promise<BrainContext> {
        return { sessionKey: input.sessionKey, agentId: AGENT };
      },
      async step(): Promise<AssistantTurn> {
        calls += 1;
        throw new Error('the provider must not be called for a replayed step');
      },
      shouldCompact: () => false,
      async compact(ctx) {
        return ctx;
      },
    };

    const outcome = await runLoop(
      journalContext(shared).ctx,
      { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: provider, toolRegistry: emptyRegistry },
      input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED,
    );

    expect(outcome).toBe('completed');
    expect(calls).toBe(0);
    const replies = (await store.list('items', { limit: 50 })).items.filter((item) => item.type === 'agent_message');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ markdown: 'old reply' });
  });

  it('retries a failed attempt and posts only the fresh answer, with no preview', async () => {
    const store = createMemoryStore();
    await store.put('runs', runDoc() as never, { conversationId: CONV });
    let attempt = 0;
    const brain: Brain = {
      async buildContext(): Promise<BrainContext> {
        return { sessionKey: input.sessionKey, agentId: AGENT };
      },
      async step(_ctx, _tools, opts): Promise<AssistantTurn> {
        attempt += 1;
        if (attempt === 1) {
          opts.onDelta?.('failed partial');
          throw transient();
        }
        opts.onDelta?.('fresh answer');
        return final('fresh answer');
      },
      shouldCompact: () => false,
      async compact(ctx) {
        return ctx;
      },
    };

    const outcome = await runLoop(
      journalContext().ctx,
      { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: emptyRegistry } as RunServices,
      input, 'run-1', { sessionKey: input.sessionKey, agentId: AGENT }, NEVER_CANCELLED,
    );

    expect(outcome).toBe('completed');
    const frames = (await store.eventBus.since(0, 200))
      .map((entry) => entry.event)
      // Provisional previews only: the committed reply is standard TEXT_MESSAGE_* too, but has no attempt id.
      .filter((event) => ((event.type === 'TEXT_MESSAGE_START' || event.type === 'TEXT_MESSAGE_CONTENT' || event.type === 'TEXT_MESSAGE_END') && event.metadata?.juno?.attemptId !== undefined)
        || (event.type === 'CUSTOM' && event.name.startsWith('juno.preview.')));
    expect(frames).toEqual([]);
    const posted = (await store.list('items')).items.flatMap((item) => (item.type === 'agent_message' ? [item.markdown] : []));
    expect(posted).toEqual(['fresh answer']);
  });
});

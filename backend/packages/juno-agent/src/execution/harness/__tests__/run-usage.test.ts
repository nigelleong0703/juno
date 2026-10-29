/**
 * PH11 usage/budget regression: real provider usage mapping, measured counters, unknown cost that is
 * never "free", replay-safe accounting, waiting excluded from active time, frozen owner budgets and
 * preserved tasks on exhaustion.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { RestatePromise } from '@agent-desktop/durable';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import type { Usage } from '@earendil-works/pi-ai';
import type { Brain, BrainContext, Store, ToolRegistry, WakeEvent } from '../../../contracts/index.js';
import type { Run } from '@agent-desktop/public-contracts';
import { appSettingsSchema } from '@agent-desktop/public-contracts';
import { createOpenAIProvider, toAssistantUsage } from '../../brain/provider.js';
import { backendConfigSchema } from '../../config.js';
import { requestScopedStore } from '../../../owner-context.js';
import { chargeModelStep } from '../services/model-budget.js';
import { loadRunBudget } from '../services/run-budget.js';
import type { RunContext, RunServices } from '../services/run-types.js';
import {
  addActiveMs,
  checkBudget,
  createUsageState,
  observeUsage,
  totalTokens,
  type UsageSample,
} from '../../usage/index.js';

const NO_PRICE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PRICED = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function measured(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 1000,
    output: 200,
    cacheRead: 400,
    cacheWrite: 100,
    totalTokens: 1700,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

const sample: UsageSample = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 100, costUsd: 0, costKnown: false };

const BUDGET_OWNER = 'owner-budget';
const AT = '2026-10-08T00:00:00.000Z';

/** A replay-aware durable context: a repeated step name returns the journaled value, not a re-run. */
function replayContext(): RunContext {
  const journal = new Map<string, unknown>();
  let seq = 0;
  return {
    rand: { uuidv4: () => 'id-' + String(seq++) },
    run: <T>(name: string, action: () => Promise<T>): RestatePromise<T> => {
      if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
      return RestatePromise.resolve(
        action().then((value) => {
          journal.set(name, structuredClone(value));
          return value;
        }),
      );
    },
    awakeable: <T>() => ({ id: 'awake-' + String(seq++), promise: RestatePromise.resolve(new Promise<T>(() => {})) }),
    drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
  };
}

function stubBrain(): Brain {
  return {
    async buildContext(): Promise<BrainContext> {
      return { sessionKey: 's', agentId: 'a' };
    },
    async step() {
      return { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costKnown: true }, stopReason: 'stop' };
    },
    shouldCompact: () => false,
    async compact(ctx) {
      return ctx;
    },
  };
}

function runServices(store: Store): RunServices {
  const registry: ToolRegistry = { forAgent: async () => [], get: () => undefined };
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: stubBrain(), toolRegistry: registry };
}

function runningRun(): Run {
  return {
    id: 'run-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    title: 'budget',
    status: 'running',
    kind: 'chat',
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: AT,
    lastActivityAt: AT,
  };
}

/** A real OpenAI-compatible streaming endpoint; withUsage controls whether a usage block is sent. */
async function startProvider(withUsage: boolean): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') {
      // Model-limit probing is a GET; answer it with JSON so the stream path stays the only SSE.
      response.setHeader('content-type', 'application/json');
      response.end('{}');
      return;
    }
    response.setHeader('content-type', 'text/event-stream');
    const base = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'fixture-model' };
    const frame = (payload: unknown): string => 'data: ' + JSON.stringify(payload) + '\n\n';
    response.write(frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] }));
    if (withUsage) {
      response.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }));
    } else {
      response.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: 'http://127.0.0.1:' + String(port),
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

describe('PH11 usage accounting', () => {
  it('maps measured provider tokens; missing pricing stays unknown, explicit free is known', () => {
    const missing = toAssistantUsage(measured(), undefined);
    expect(missing.inputTokens).toBe(1000);
    expect(missing.outputTokens).toBe(200);
    expect(missing.cacheReadTokens).toBe(400);
    expect(missing.cacheWriteTokens).toBe(100);
    expect(missing.costKnown).toBe(false);
    expect(missing.costUsd).toBe(0);

    const free = toAssistantUsage(measured({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }), NO_PRICE);
    expect(free.inputTokens).toBe(1000);
    expect(free.costKnown).toBe(true);
    expect(free.costUsd).toBe(0);

    const priced = toAssistantUsage(measured({ cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } }), PRICED);
    expect(priced.costKnown).toBe(true);
    expect(priced.costUsd).toBe(10);
  });

  it('keeps each owner budget frozen and independent', () => {
    const alice = createUsageState({ steps: 1 });
    const bob = createUsageState({ steps: 2 });
    const a1 = observeUsage(alice, sample, 'run-a:step-1');
    expect(checkBudget(a1)).toEqual({ ok: false, reason: 'step budget reached (1/1)' });
    const b1 = observeUsage(bob, sample, 'run-b:step-1');
    expect(checkBudget(b1).ok).toBe(true);
  });

  it('counts only active time against the budget', () => {
    const state = addActiveMs(createUsageState({ activeSeconds: 5 }), 2_000);
    expect(checkBudget(state).ok).toBe(true);
    const over = addActiveMs(state, 4_000);
    expect(checkBudget(over)).toEqual({ ok: false, reason: 'active time budget reached (6/5s)' });
  });

  it('never treats an unknown cost as spent budget', () => {
    const counters = observeUsage(createUsageState(), sample, 'run-a:step-1');
    expect(counters.unknownCost).toBe(true);
    // Default policy blocks truthfully instead of silently ignoring the configured cost budget.
    // A static cap only enforces the known lower bound, so a normal run does not stall on unknown price.
    expect(checkBudget({ ...counters, limits: { costUsd: 0.0001 } }).ok).toBe(true);
    // An explicit user cost budget blocks truthfully unless the user opted out.
    expect(checkBudget({ ...counters, limits: { costUsd: 0.0001, onUnknown: 'block' as const } }).ok).toBe(false);

    // The known lower bound still enforces even with unknown components.
    const partlyKnown = observeUsage(counters, { ...sample, costUsd: 0.6, costKnown: true }, 'run-a:step-2');
    expect(checkBudget({ ...partlyKnown, limits: { costUsd: 0.5 } }).ok).toBe(false);

    const known = observeUsage(createUsageState(), { ...sample, costUsd: 0.5, costKnown: true }, 'run-b:step-1');
    expect(known.unknownCost).toBe(false);
    expect(checkBudget({ ...known, limits: { costUsd: 0.4 } })).toEqual({ ok: false, reason: 'cost budget reached (0.5000/0.4)' });
  });

  it('qualifies unmeasured usage instead of counting it as zero', () => {
    const unmeasured = toAssistantUsage(undefined, NO_PRICE);
    expect(unmeasured.measured).toBe(false);
    expect(unmeasured.inputTokens).toBe(0);
    expect(unmeasured.costKnown).toBe(false);

    // The SDK always hands back an all-zero usage object, which is ambiguous, not a proven zero.
    const sdkDefault = toAssistantUsage(measured({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), NO_PRICE);
    expect(sdkDefault.measured).toBe(false);
    expect(sdkDefault.cacheReadTokens).toBe(0);
    expect(sdkDefault.costKnown).toBe(false);

    const counters = observeUsage(createUsageState(), { ...sample, measured: false }, 'run-a:step-1');
    expect(counters.unknownTokens).toBe(true);
    // Honest partial lower bound: the reported counters are kept and still enforce the ceiling,
    // while the unknown flag records that the true spend may be higher.
    expect(totalTokens(counters.totals)).toBe(1700);
    expect(checkBudget({ ...counters, limits: { tokens: 10 } })).toEqual({ ok: false, reason: 'token budget reached (1700/10)' });
    expect(checkBudget({ ...counters, limits: { tokens: 10, onUnknown: 'block' as const } }).ok).toBe(false);
    expect(checkBudget({ ...counters, limits: {} }).ok).toBe(true);
  });

  it('marks usage unmeasured when the real provider streams text without a usage block', async () => {
    const fixture = await startProvider(false);
    try {
      const provider = createOpenAIProvider(backendConfigSchema.parse({ MODEL_WIRE_API: 'chat', MODEL_BASE_URL: fixture.url, MODEL_ID: 'fixture-model', MODEL_API_KEY: 'k' }));
      const turn = await provider.call({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }], tools: [], signal: new AbortController().signal });
      expect(turn.text).toBe('hi');
      expect(turn.usage.measured).toBe(false);
      expect(turn.usage.costKnown).toBe(false);
      expect(turn.usage.inputTokens).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('marks usage measured when the real provider reports counters', async () => {
    const fixture = await startProvider(true);
    try {
      const provider = createOpenAIProvider(backendConfigSchema.parse({ MODEL_WIRE_API: 'chat', MODEL_BASE_URL: fixture.url, MODEL_ID: 'fixture-model', MODEL_API_KEY: 'k' }));
      const turn = await provider.call({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }], tools: [], signal: new AbortController().signal });
      expect(turn.usage.measured).toBe(true);
      expect(turn.usage.inputTokens).toBe(7);
      expect(turn.usage.outputTokens).toBe(3);
      expect(turn.usage.costKnown).toBe(false);
      expect(turn.usage.costUsd).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('charges real priced usage on the HTTP wire and enforces the cost budget', async () => {
    const fixture = await startProvider(true);
    try {
      const provider = createOpenAIProvider(backendConfigSchema.parse({ MODEL_WIRE_API: 'chat', MODEL_BASE_URL: fixture.url, MODEL_ID: 'fixture-model', MODEL_API_KEY: 'k' }), { pricing: PRICED });
      const turn = await provider.call({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }], tools: [], signal: new AbortController().signal });
      expect(turn.usage.measured).toBe(true);
      expect(turn.usage.costKnown).toBe(true);
      expect(turn.usage.costUsd).toBeCloseTo((7 * 3 + 3 * 15) / 1000000, 10);
      const charged = observeUsage(createUsageState({ costUsd: 0.00005 }), { inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens, costUsd: turn.usage.costUsd, costKnown: turn.usage.costKnown }, 'run-cost:step-1');
      expect(checkBudget(charged)).toEqual({ ok: false, reason: 'cost budget reached (0.0001/0.00005)' });
    } finally {
      await fixture.close();
    }
  });

  it('blocks a configured cost budget truthfully when spend is unknown', () => {
    const unknown = observeUsage(createUsageState(), { inputTokens: 10, outputTokens: 5, costKnown: false }, 'run-unknown:step-1');
    expect(unknown.unknownCost).toBe(true);
    expect(checkBudget({ ...unknown, limits: { costUsd: 1, onUnknown: 'block' as const } }).ok).toBe(false);
    expect(checkBudget({ ...unknown, limits: { costUsd: 1, onUnknown: 'block' as const } })).toEqual({ ok: false, reason: 'cost budget cannot be enforced: some actions reported no price (known 0.0000/1)' });
    expect(checkBudget({ ...unknown, limits: { costUsd: 1, onUnknown: 'ignore' as const } }).ok).toBe(true);
  });

  it('freezes the owner budget at run start so a later settings change cannot move it', async () => {
    const raw = createMemoryStore();
    const settingsDoc = {
      ...appSettingsSchema.parse({
      general: { launchAtLogin: false, language: 'en' },
      appearance: { theme: 'system', density: 'comfortable', accent: 'blue' },
      notifications: [],
      usage: { steps: 2 },
      yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
      connections: { serverUrl: '', modelProviders: [] },
      privacy: { dataRetentionDays: 90, trainingOptIn: false },
        advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
      }),
      id: 'app-settings-' + BUDGET_OWNER,
    };
    await raw.put('settings', settingsDoc);
    const store = requestScopedStore(raw);
    const budget = await loadRunBudget(replayContext(), runServices(store), BUDGET_OWNER);
    expect(budget.limits.steps).toBe(2);

    // The account raises its budget mid-run; the frozen run must not pick it up.
    await raw.patch('settings', 'app-settings-' + BUDGET_OWNER, { usage: { steps: 100 } });
    expect(budget.limits.steps).toBe(2);
    budget.charge('model:0', { inputTokens: 1, outputTokens: 1, costUsd: 0, costKnown: true }, 0);
    budget.charge('model:1', { inputTokens: 1, outputTokens: 1, costUsd: 0, costKnown: true }, 0);
    expect(budget.check().ok).toBe(false);
  });

  it('replaying a charged step adds nothing to the persisted run usage', async () => {
    const raw = createMemoryStore();
    await raw.put('runs', runningRun(), { conversationId: 'conv-1' });
    const store = requestScopedStore(raw);
    const ctx = replayContext();
    const budget = await loadRunBudget(ctx, runServices(store), BUDGET_OWNER);
    const usage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 30, cacheWriteTokens: 7, costUsd: 0, costKnown: false };

    await chargeModelStep({ ctx, services: runServices(store), runId: 'run-1', stepIndex: 0, budget, usage, durationMs: 100, model: 'model-x' });
    const once = budget.totals();
    // Same step key replayed: the durable step returns its journaled value and the counters dedup.
    await chargeModelStep({ ctx, services: runServices(store), runId: 'run-1', stepIndex: 0, budget, usage, durationMs: 100 });

    expect(budget.totals()).toEqual(once);
    expect(budget.unknowns().actions).toBe(1);
    expect((await raw.get('runs', 'run-1'))?.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 30,
      cacheWriteTokens: 7,
      costKnown: false,
      steps: 1,
    });
    expect((await raw.get('runs', 'run-1'))?.model).toBe('model-x');
  });

  it('never adds a replayed active duration twice', () => {
    const once = addActiveMs(createUsageState({ activeSeconds: 60 }), 2_000, 'run-a:span-1');
    const replayed = addActiveMs(once, 2_000, 'run-a:span-1');
    expect(replayed.totals.activeMs).toBe(2_000);
    const second = addActiveMs(replayed, 1_000, 'run-a:span-2');
    expect(second.totals.activeMs).toBe(3_000);
  });
});

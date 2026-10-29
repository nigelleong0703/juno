import { describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import type { Rule } from '@agent-desktop/public-contracts';
import type { Store, Tool, ToolContext, ToolRegistry, ToolResult, WakeEvent } from '../../../contracts/index.js';
import type { BrowserResult } from '../../../modules/tools/computer/contract.js';
import { browserResultSchema } from '../../../modules/tools/computer/contract.js';
import { resetBrowserAdvanceMemoryForTests, runBrowserAdvance } from '../../../modules/tools/computer/browser-advance.js';
import type { AdvanceExecution, RunBrowserAdvanceOptions } from '../../../modules/tools/computer/browser-advance-types.js';
import { readAdvanceHistory } from '../../../modules/tools/computer/browser-advance-history.js';
import { decisionState } from '../../../modules/tools/computer/browser-advance-decision.js';
import { buildCandidates } from '../../../modules/tools/computer/browser-advance-candidates.js';
import { createGoalBrowserTools } from '../../../modules/tools/tools/browserGoals.js';
import { createComputerBrowserAdvanceTool } from '../../../modules/tools/tools/computerBrowserAdvance.js';
import { snapshotText } from '../../../modules/tools/tools/computerBrowserActions.js';
import { createToolRegistry } from '../../../modules/tools/index.js';
import type { ComputerClient } from '../../../modules/tools/computer/contract.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { readTranscript } from '../../brain/transcript.js';
import { CANCELLED, NEVER_CANCELLED, createRunCancellation } from '../services/cancel.js';
import { executeSingleToolCall } from '../services/run-tools.js';
import type { ToolCallContext } from '../services/tool-policy.js';
import type { RunInput, RunServices } from '../services/run-types.js';
import { ScriptedModel } from '../testing/stubs.js';
import type { ChoiceQuestion, SystemOne, SystemOneAnswer } from '../../../ports/system-one/index.js';

const OWNER = 'owner-advance';
const AGENT = 'agent-advance';
const CONV = 'conv-advance';
const AT = '2026-10-20T00:00:00.000Z';
const SESSION = AGENT + ':' + CONV;

function wake(): WakeEvent {
  return {
    id: 'wake-advance', ownerId: OWNER, agentId: AGENT, sessionKey: SESSION, conversationId: CONV,
    kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'go' }, at: AT, status: 'accepted',
  };
}

const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: SESSION, wakeEvents: [wake()] };

type SnapshotPage = Extract<BrowserResult, { action: 'snapshot' }>;

function page(refs: Array<{ ref: string; role: string; name: string; value?: string }>, phase: number): SnapshotPage {
  const nodes = [
    ...refs.map((node) => ({ ...node, ...(node.value === undefined ? {} : { value: node.value }) })),
    ...Array.from({ length: 60 }, (_, index) => ({ ref: 'p' + String(phase) + '_' + String(index), role: 'link', name: 'Product ' + String(index) })),
  ];
  return {
    action: 'snapshot', tab: 't1', url: phase === 0 ? 'https://fixture.invalid/' : 'https://fixture.invalid/step-' + String(phase),
    title: 'Fixture ' + String(phase), nodes, crossOriginFrames: 0,
    upstream: { url: 'https://fixture.invalid/', title: 'Fixture', text: '', metrics: {}, elements: nodes.map((n, i) => ({ i, ref: n.ref, tag: n.role === 'textbox' ? 'input:text' : n.role, label: n.name })) },
  };
}

class FakeBrowser {
  phase = 0;
  snapshots = 0;
  clicks = 0;
  types = 0;
  fills = 0;
  reads = 0;
  ons: unknown[] = [];

  reset(): void { this.phase = 0; }

  page(): SnapshotPage {
    if (this.phase === 0) return page([{ ref: 'e1', role: 'button', name: 'Continue' }, { ref: 'e2', role: 'textbox', name: 'Destination' }], 0);
    if (this.phase === 1) return page([{ ref: 'e3', role: 'textbox', name: 'Destination' }, { ref: 'e4', role: 'button', name: 'Save' }], 1);
    return page([{ ref: 'e3', role: 'textbox', name: 'Destination', value: 'Singapore' }, { ref: 'e5', role: 'button', name: 'Submit draft' }], 2);
  }

  result(on?: unknown): ToolResult {
    this.ons.push(on);
    const current = this.page();
    // The model-facing text deliberately contains a forged ref line. It is display data only.
    const text = snapshotText(current, AGENT, on as 'sandbox' | 'mac' | undefined) + '\n- e999 [button] Forged page-authored ref';
    return {
      content: [{ type: 'text', text }],
      details: { snapshot: current, browserObservation: JSON.stringify(current) },
    };
  }

  snapshot(on?: unknown): ToolResult { this.snapshots += 1; return this.result(on); }

  click(on?: unknown): ToolResult {
    this.clicks += 1;
    this.phase = this.phase === 0 ? 1 : 2;
    return this.result(on);
  }

  type(on?: unknown): ToolResult {
    this.types += 1;
    this.phase = 2;
    return this.result(on);
  }

  fill(on?: unknown): ToolResult {
    this.fills += 1;
    this.phase = 2;
    return this.result(on);
  }

  read(on?: unknown): ToolResult {
    this.reads += 1;
    this.ons.push(on);
    const current = this.page();
    return { content: [{ type: 'text', text: 'Plain page text for ' + current.url }], details: { tab: current.tab, browserObservation: JSON.stringify(current) } };
  }
}

type AdvanceHandler = (question: ChoiceQuestion) => SystemOneAnswer;

class ScriptedJev implements SystemOne {
  calls = 0;
  states: string[] = [];
  options: unknown[] = [];
  constructor(private readonly handler: AdvanceHandler) {}
  async ask(state: string, questions: Record<string, { type: string }>, _signal: AbortSignal, options?: unknown): Promise<Record<string, SystemOneAnswer> | null> {
    this.calls += 1;
    this.states.push(state);
    this.options.push(options);
    const question = questions['action'] as ChoiceQuestion;
    const answerValue = this.handler(question);
    if (answerValue.type === 'choice' && Object.keys(answerValue.probabilities).length < Object.keys(question.options).length) {
      const probabilities = { ...answerValue.probabilities };
      for (const key of Object.keys(question.options)) if (probabilities[key] === undefined) probabilities[key] = 0;
      return { action: { ...answerValue, probabilities } };
    }
    return { action: answerValue };
  }
}

function answer(key: string, probability = 0.9): SystemOneAnswer {
  const other = key === 'DONE' ? 'DEFER' : 'DONE';
  return { type: 'choice', choice: key, probabilities: { [key]: probability, [other]: 1 - probability }, confidence: probability };
}

function choose(key: string): AdvanceHandler {
  return () => answer(key);
}

function chooseFromOptions(fragment: string): AdvanceHandler {
  return (question) => {
    const match = Object.entries(question.options).find(([, description]) => description?.includes(fragment));
    return answer(match?.[0] ?? 'DEFER');
  };
}

function malformedDistribution(question: ChoiceQuestion, mutate: (probabilities: Record<string, number>) => void): SystemOneAnswer {
  const probabilities = Object.fromEntries(Object.keys(question.options).map((key) => [key, 0]));
  probabilities['DONE'] = 1;
  mutate(probabilities);
  return { type: 'choice', choice: 'DONE', probabilities, confidence: 0.99 };
}

function ordinaryAdvance(_browser: FakeBrowser): AdvanceHandler {
  return (question) => {
    const options = question.options;
    const click = Object.entries(options).find(([, description]) => description?.includes('"Continue"'));
    if (click !== undefined) return answer(click[0]);
    const type = Object.entries(options).find(([, description]) => description?.startsWith('Type the exact main-supplied value'));
    if (type !== undefined) return answer(type[0]);
    return answer('DONE');
  };
}

function browserTools(browser: FakeBrowser, decisionTimeoutMs = 50): Tool[] {
  return [
    createComputerBrowserAdvanceTool({ decisionTimeoutMs }),
    {
      name: 'browser.snapshot', description: '', parameters: {}, replay: 'safe', sideEffect: false,
      execute: async (args: unknown) => browser.snapshot(args !== null && typeof args === 'object' ? Reflect.get(args, 'on') : undefined),
    },
    {
      name: 'browser.click', description: '', parameters: {}, replay: 'never', sideEffect: true,
      execute: async (args: unknown) => browser.click(args !== null && typeof args === 'object' ? Reflect.get(args, 'on') : undefined),
    },
    {
      name: 'browser.type', description: '', parameters: {}, replay: 'never', sideEffect: true,
      execute: async (args: unknown) => browser.type(args !== null && typeof args === 'object' ? Reflect.get(args, 'on') : undefined),
    },
    {
      name: 'browser.fill', description: '', parameters: {}, replay: 'never', sideEffect: true,
      execute: async (args: unknown) => browser.fill(args !== null && typeof args === 'object' ? Reflect.get(args, 'on') : undefined),
    },
    {
      name: 'browser.get_text', description: '', parameters: {}, replay: 'safe', sideEffect: false,
      execute: async (args: unknown) => browser.read(args !== null && typeof args === 'object' ? Reflect.get(args, 'on') : undefined),
    },
  ];
}

function registryOf(tools: Tool[]): ToolRegistry {
  return { forAgent: async () => tools, get: (name) => tools.find((tool) => tool.name === name) };
}

function servicesFor(store: Store, tools: Tool[], systemOne?: SystemOne, quickCalls?: { count: number }): RunServices {
  const brain: RunServices['brain'] = Object.assign(new ScriptedModel(), {
    ...(systemOne === undefined ? {} : { systemOne }),
    ...(quickCalls === undefined ? {} : { async quickText(): Promise<string | null> { quickCalls.count += 1; return 'hidden'; } }),
  });
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain, toolRegistry: registryOf(tools) };
}

interface JournalContext extends ToolCallContext {
  decide(value: unknown): void;
}

function journaling(prefix: string, journal = new Map<string, unknown>(), created: string[] = []): { ctx: JournalContext; journal: Map<string, unknown>; created: string[] } {
  let next = 0;
  let settle: ((value: unknown) => void) | undefined;
  return {
    journal, created,
    ctx: {
      rand: { uuidv4: () => prefix + String(next++) },
      run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
        created.push(name);
        if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
        return RestatePromise.resolve(action().then((value) => { journal.set(name, structuredClone(value)); return value; }));
      },
      awakeable<T>(): { id: string; promise: RestatePromise<T> } {
        const promise = new Promise<T>((resolve) => { settle = (value) => resolve(value as T); });
        return { id: 'awk-advance', promise: RestatePromise.resolve(promise) };
      },
      drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
      decide: (value) => settle?.(value),
    },
  };
}

async function seedRun(store: Store, runId: string): Promise<void> {
  // The owner's agent and direct chat: who is present is read from them (batch 5b), and the owner alone is the default.
  await (store.forOwner?.(OWNER) ?? store).put('agents', { id: AGENT, ownerId: OWNER, name: 'Advance' } as never);
  await (store.forOwner?.(OWNER) ?? store).put('conversations', { id: CONV, kind: 'direct', memberIds: [OWNER], agentIds: [AGENT] } as never);
  await (store.forOwner?.(OWNER) ?? store).put('runs', {
    id: runId, agentId: AGENT, conversationId: CONV, title: 'advance', status: 'running', kind: 'chat',
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  }, { conversationId: CONV });
}

function ruleFor(subject: string, behavior: Rule['behavior']): Rule {
  return { id: 'rule-advance', description: 'r', scope: 'action', behavior, source: 'user', enabled: true, subject, createdAt: AT, createdBy: OWNER };
}

async function pendingRequest(store: Store) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const request = (await store.list('requests', { limit: 10 })).items[0];
    if (request !== undefined) return request;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('approval request was never written');
}

function callAdvance(ctx: JournalContext, services: RunServices, runId: string, args: Record<string, unknown>, toolIdx = 0, cancellation = NEVER_CANCELLED) {
  return executeSingleToolCall(ctx, services, input, runId, 0, toolIdx, { id: 'call-1', name: 'browser.advance', arguments: { stage: Object.keys(args['values'] ?? {}).length > 0 ? 'form' : 'interact', ...args } }, cancellation, []);
}

function resultOf(outcome: Awaited<ReturnType<typeof callAdvance>>): ToolResult {
  if (outcome === CANCELLED) throw new Error('unexpected cancellation');
  return outcome.result;
}

describe('goal browser canonical policy', () => {
  it.each(['click', 'scroll'] as const)('refuses a nested goal %s when its canonical approval is denied', async (action) => {
    const store = createMemoryStore(); const runId = 'run-goal-denied'; await seedRun(store, runId);
    await store.put('rules', ruleFor('browser.' + action, 'ask'));
    const browser = new FakeBrowser();
    const native: SystemOne = { async ask(_state, questions) {
      return Object.fromEntries(Object.entries(questions).map(([name, q]) => {
        if (q.type === 'noul') return [name, { type: 'noul', probability: 0.01 }];
        if (q.type !== 'choice') throw new Error('unexpected');
        const keys = Object.keys(q.options); const key = name === 'tool' ? action : keys[0]!;
        return [name, { type: 'choice', choice: key, confidence: 0.8, probabilities: Object.fromEntries(keys.map(k => [k, keys.length === 1 ? 1 : k === key ? 0.8 : 0.2 / (keys.length - 1)])) }];
      }));
    } };
    const context = journaling('goal-deny');
    const running = executeSingleToolCall(context.ctx, servicesFor(store, [...browserTools(browser), { name: 'browser.scroll', description: 'Scroll', parameters: {}, sideEffect: true, replay: 'never', execute: async () => browser.click() }, ...createGoalBrowserTools()], native), input, runId, 0, 0,
      { id: 'goal-call', name: 'browser.do', arguments: { goal: 'Continue', completion: [{ match: { text: 'Continue' }, property: 'count', equals: 0 }], maxActions: 2 } }, NEVER_CANCELLED, []);
    void running.catch(() => undefined);
    const request = await pendingRequest(store); expect(request.tool).toBe('browser.' + action); expect(browser.clicks).toBe(0);
    await store.patch('requests', request.id, { status: 'denied', resolvedAt: AT }); context.ctx.decide({ action: 'deny' });
    expect(resultOf(await running).isError).toBe(true); expect(browser.clicks).toBe(0);
  });
  it('keeps fast-drafted fill behind the canonical approval gate', async () => {
    const store = createMemoryStore(); const runId = 'run-fast-fill-denied'; await seedRun(store, runId);
    await store.put('rules', ruleFor('browser.fill', 'ask'));
    const browser = new FakeBrowser(); const context = journaling('fast-fill-deny');
    const services = servicesFor(store, [...browserTools(browser), ...createGoalBrowserTools()]);
    services.brain.quickText = async () => JSON.stringify({ fields: [{ ref: 'e2', text: 'Mira builds furniture.' }] });
    const running = executeSingleToolCall(context.ctx, services, input, runId, 0, 0,
      { id: 'fill-call', name: 'browser.act', arguments: { action: 'write', args: { facts: 'Mira builds furniture', fields: [{ ref: 'e2', brief: 'One sentence' }] } } }, NEVER_CANCELLED, []);
    void running.catch(() => undefined);
    const request = await pendingRequest(store); expect(request.tool).toBe('browser.fill'); expect(browser.fills).toBe(0);
    await store.patch('requests', request.id, { status: 'denied', resolvedAt: AT }); context.ctx.decide({ action: 'deny' });
    expect(resultOf(await running).isError).toBe(true); expect(browser.fills).toBe(0);
  });

  it('preserves native-only policy review in nested actions while forbidding hidden text/emulation', async () => {
    const store = createMemoryStore(); const runId = 'run-policy-native'; await seedRun(store, runId);
    const quick = { count: 0 }; let reviews = 0;
    const native: SystemOne = { async ask(_state, _questions, _signal, options) { reviews++; expect(options?.allowEmulation).toBe(false); return { review: { type: 'choice', choice: 'proceed', confidence: 0.99, probabilities: { proceed: 0.99, commit: 0.01 } } }; } };
    const click: Tool = { name: 'browser.click', description: '', parameters: {}, sideEffect: true, replay: 'never', execute: async (_args, ctx) => {
      expect(ctx.quickText).toBeUndefined();
      const answer = await ctx.systemOne?.ask('Review an observed harmless continuation', { review: { type: 'choice', instructions: 'Assess the action', options: { proceed: 'Harmless', commit: 'Binding' } } }, ctx.signal);
      return answer ? { content: [] } : { content: [], isError: true };
    } };
    const result = resultOf(await executeSingleToolCall(journaling('native-policy').ctx, servicesFor(store, [click, ...createGoalBrowserTools()], native, quick), input, runId, 0, 0,
      { id: 'review-call', name: 'browser.act', arguments: { action: 'click', args: { ref: 'e1' } } }, NEVER_CANCELLED, []));
    expect(result.isError).not.toBe(true); expect(reviews).toBe(1); expect(quick.count).toBe(0);
  });

});

describe('browser.advance canonical orchestration', () => {
  it('rejects an unclassified stage before native inference or browser actions', async () => {
    const store = createMemoryStore();
    const runId = 'run-missing-stage';
    await seedRun(store, runId);
    const browser = new FakeBrowser();
    const jev = new ScriptedJev(choose('DONE'));
    const result = resultOf(await callAdvance(journaling('missing-stage').ctx, servicesFor(store, browserTools(browser), jev), runId, { stage: undefined, goal: 'Fill cities, dates, search and compare' }));
    expect(result.details?.['code']).toBe('missing_stage');
    expect(jev.calls).toBe(0);
    expect(browser.snapshots + browser.clicks + browser.types).toBe(0);
  });

  it('rejects a form without values and an interaction with typing before browser work or native inference', async () => {
    for (const testCase of [{ stage: 'form', code: 'missing_values' }, { stage: 'interact', values: { Destination: 'Singapore' }, code: 'stage_value_mismatch' }]) {
      const store = createMemoryStore();
      const runId = 'run-stage-' + testCase.stage;
      await seedRun(store, runId);
      const browser = new FakeBrowser();
      const jev = new ScriptedJev(choose('DONE'));
      const result = resultOf(await callAdvance(journaling(testCase.stage).ctx, servicesFor(store, browserTools(browser), jev), runId,
        { goal: 'Fill cities and dates', stage: testCase.stage, ...(testCase.values === undefined ? {} : { values: testCase.values }) }));
      expect(result.details?.['code']).toBe(testCase.code);
      expect(jev.calls).toBe(0);
      expect(browser.snapshots + browser.clicks + browser.types).toBe(0);
    }
  });

  it('redacts an unexpected orchestration error before writing the result or transcript', async () => {
    const store = createMemoryStore();
    const runId = 'run-advance-unexpected-error';
    await seedRun(store, runId);
    const tool = createComputerBrowserAdvanceTool({});
    tool.orchestrate = async () => { throw new Error('upstream echoed Bearer abcdefgh12345678'); };
    const result = resultOf(await callAdvance(journaling('unexpected-error').ctx, servicesFor(store, [tool]), runId, { goal: 'Continue' }));
    expect(result.isError).toBe(true);
    const persisted = JSON.stringify([result, await readTranscript(store, SESSION)]);
    expect(persisted).toContain('[redacted]');
    expect(persisted).not.toContain('abcdefgh12345678');
  });

  it('works through the production browser tool registry and detail projection with more than 50 nodes', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-production-tools';
    await seedRun(store, runs);
    const state = new FakeBrowser();
    const secret = 'Bearer abcdefgh12345678';
    const actualPage = state.page.bind(state);
    state.page = () => {
      const current = actualPage();
      const link = current.nodes.find((node) => node.role === 'link');
      if (link !== undefined) link.name = secret;
      return current;
    };
    const client = {
      browser: async (_agentId: string, input: { action: string }): Promise<BrowserResult> => {
        if (input.action === 'snapshot') return state.page();
        if (input.action === 'click') {
          state.clicks += 1;
          state.phase = 1;
          return { action: 'click', tab: 't1', url: state.page().url, title: state.page().title, clicked: true };
        }
        if (input.action === 'type') {
          state.types += 1;
          state.phase = 2;
          return { action: 'type', tab: 't1', url: state.page().url, title: state.page().title, typed: true };
        }
        if (input.action === 'get_text') {
          return { action: 'get_text', tab: 't1', url: state.page().url, title: state.page().title, text: 'Fixture prose' };
        }
        throw new Error('unexpected browser action ' + input.action);
      },
    } as unknown as ComputerClient;
    const registry = await createToolRegistry({ store, enqueuer: new NoopEnqueuer(), computer: () => client });
    const jev = new ScriptedJev(ordinaryAdvance(state));
    const services: RunServices = {
      store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
      brain: Object.assign(new ScriptedModel(), { systemOne: jev }), toolRegistry: registry,
    };
    const result = resultOf(await callAdvance(journaling('prod').ctx, services, runs, {
      goal: 'Set the destination and continue', values: { Destination: 'Singapore' }, maxActions: 4,
    }));
    expect(state.clicks).toBe(0);
    expect(state.types).toBe(1);
    const encoded = String(result.details?.['browserObservation']);
    expect(encoded).not.toContain('abcdefgh12345678');
    expect(encoded).toContain('[redacted]');
    const canonical = browserResultSchema.parse(JSON.parse(encoded));
    expect(canonical.action).toBe('snapshot');
    if (canonical.action !== 'snapshot') throw new Error('expected snapshot');
    expect(canonical.nodes).toHaveLength(62);
  });

  it('persists ref-free progress across stages and process-memory resets without leaking it to another run or target', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore().forOwner?.(OWNER);
    if (store === undefined) throw new Error('owner-scoped store required');
    const runId = 'history-run'; await seedRun(store, runId);
    const browser = new FakeBrowser();
    const firstJev = new ScriptedJev(chooseFromOptions('"Continue"'));
    const firstContext = journaling('history-first');
    const first = resultOf(await callAdvance(firstContext.ctx, servicesFor(store, browserTools(browser), firstJev), runId, { goal: 'Open next page', maxActions: 1 }));
    const saved = await readTranscript(store, SESSION);
    expect(saved[0]?.toolState?.['browserAdvance']).toBeDefined();
    expect(JSON.stringify(saved[0]?.message)).not.toContain('browserAdvance');
    resetBrowserAdvanceMemoryForTests();
    const nextJev = new ScriptedJev(chooseFromOptions('Type the exact main-supplied value'));
    const services = servicesFor(store, browserTools(browser), nextJev);
    await callAdvance(journaling('history-second').ctx, services, runId, { goal: 'Fill destination', values: { Destination: 'Singapore' }, maxActions: 1 }, 1);
    const state = JSON.parse(nextJev.states[0] ?? '{}');
    expect(state.history).toMatchObject({ priorCheckpointFound: true, continuity: 'matched' });
    expect(state.last_observed_progress).toMatchObject([{ action: 'click', goal: 'Open next page', target: [{ label: 'Continue' }], result: 'changed' }]);
    expect(JSON.stringify(state.last_observed_progress)).not.toContain('"ref"');
    expect(state.observation.controls.some((node: { ref: string }) => node.ref === 'e1')).toBe(false);
    const otherRun = 'other-history-run'; await seedRun(store, otherRun);
    const otherJev = new ScriptedJev(choose('DONE'));
    await callAdvance(journaling('history-other').ctx, servicesFor(store, browserTools(browser), otherJev), otherRun, { goal: 'Other task', maxActions: 1 });
    expect(JSON.parse(otherJev.states[0] ?? '{}').last_observed_progress).toEqual([]);
    const scope = { ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId, stepId: 'new-history-step', store };
    expect(await readAdvanceHistory(scope, 'mac', { page: browser.page() })).toBeUndefined();
    expect(await readAdvanceHistory({ ...scope, ownerId: 'another-owner' }, 'sandbox', { page: browser.page() })).toBeUndefined();
    expect(await readAdvanceHistory(scope, 'sandbox', { page: { ...browser.page(), tab: 't2' } })).toBeUndefined();
    browser.phase = 0;
    const changedJev = new ScriptedJev(choose('DONE'));
    await callAdvance(journaling('history-changed').ctx, servicesFor(store, browserTools(browser), changedJev), runId, { goal: 'Recheck changed page', maxActions: 1 });
    expect(JSON.parse(changedJev.states[0] ?? '{}').history.continuity).toBe('changed');
    const replay = resultOf(await callAdvance(journaling('history-first', firstContext.journal).ctx, servicesFor(store, browserTools(browser), firstJev), runId, { goal: 'Open next page', maxActions: 1 }));
    expect(replay.details?.['browserAdvanceCheckpoint']).toEqual(first.details?.['browserAdvanceCheckpoint']);
    expect(browser.clicks).toBe(1);
    expect(firstJev.calls).toBe(1);
  });

  it('trims oldest evidence explicitly while retaining the latest step and all current candidates', () => {
    const observation = { page: { action: 'snapshot' as const, tab: 't1', url: 'https://fixture.invalid/', title: 'Large', crossOriginFrames: 0,
      nodes: Array.from({ length: 12 }, (_, i) => ({ ref: 'fresh' + i, role: 'button', name: 'Control ' + i + 'x'.repeat(130) })) } };
    const entries = Array.from({ length: 12 }, (_, i) => ({ goal: 'goal'.repeat(40), action: 'click' as const,
      target: [{ role: 'button', label: 'old step ' + i + 'x'.repeat(120) }], omittedTargets: 0,
      observed: [{ kind: 'title', now: 'state '.repeat(25) }], result: 'changed' as const }));
    const options: RunBrowserAdvanceOptions = { args: { goal: 'Continue current task' }, history: { entries, totalSteps: 30, continuity: 'matched' },
      ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: 'budget', signal: new AbortController().signal,
      journal: async (_key, action) => action(), execute: async () => ({ kind: 'cancelled' }) };
    const encoded = decisionState(options,
      observation, buildCandidates(observation, {}), []);
    const state = JSON.parse(encoded);
    expect(encoded.length).toBeLessThanOrEqual(7000);
    expect(state.last_observed_progress.length).toBeGreaterThan(0);
    expect(state.last_observed_progress.at(-1).target[0].label).toContain('old step 11');
    expect(state.history.omittedSteps).toBe(30 - state.last_observed_progress.length);
    expect(state.observation.controls).toHaveLength(12);
  });

  it('uses a projected canonical observation with over 50 nodes, fills the requested field without clicking unrelated controls, and replays without duplicate effects', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-actions';
    await seedRun(store, runs);
    const browser = new FakeBrowser();
    const jev = new ScriptedJev(ordinaryAdvance(browser));
    const services = servicesFor(store, browserTools(browser), jev);
    const firstContext = journaling('a');
    const args = { goal: 'Set the destination and continue', values: { Destination: 'Singapore' }, maxActions: 4 };
    const firstOutcome = await callAdvance(firstContext.ctx, services, runs, args);
    if (firstOutcome === CANCELLED) throw new Error('unexpected cancellation');
    const first = firstOutcome.result;

    expect(browser.clicks).toBe(0);
    expect(browser.types).toBe(1);
    expect(jev.calls).toBe(1);
    expect(jev.options[0]).toMatchObject({ allowEmulation: false });
    expect(first.content[0]?.type).toBe('text');
    expect(first.content[0]?.type === 'text' ? first.content[0].text : '').toContain('Singapore');
    expect(first.content[0]?.type === 'text' ? first.content[0].text : '').not.toContain('e999');
    expect(first.details?.['actionCount']).toBe(1);
    expect(first.details?.['stopReason']).toBe('form-filled');
    const canonical = browserResultSchema.parse(JSON.parse(String(first.details?.['browserObservation'])));
    expect(canonical.action).toBe('snapshot');
    if (canonical.action !== 'snapshot') throw new Error('expected a snapshot observation');
    expect(canonical.nodes).toHaveLength(62);

    const transcript = await readTranscript(store, SESSION);
    expect(transcript).toHaveLength(1);
    expect((transcript[0]?.message as { toolCallId?: string }).toolCallId).toBe('call-1');

    const replayContext = journaling('a', firstContext.journal);
    const replayOutcome = await callAdvance(replayContext.ctx, services, runs, args);
    if (replayOutcome === CANCELLED) throw new Error('unexpected replay cancellation');
    const replay = replayOutcome.result;
    expect(browser.clicks).toBe(0);
    expect(browser.types).toBe(1);
    expect(replay.details?.['stopReason']).toBe(first.details?.['stopReason']);
    expect(replay.details?.['progress']).toEqual(first.details?.['progress']);
    expect(replay.details?.['browserObservation']).toBe(first.details?.['browserObservation']);
    expect(replayOutcome.activeMs).toBe(firstOutcome.activeMs);
    expect(replayContext.created).toEqual(firstContext.created);
    expect(await readTranscript(store, SESSION)).toHaveLength(1);

    // A later parent writes a low-confidence block for the same stage. Replaying the first parent
    // must still use the stage-memory value recorded in its own journal.
    browser.reset();
    const low = new ScriptedJev(() => answer('DONE', 0.55));
    const lowServices = servicesFor(store, browserTools(browser), low);
    const later = journaling('b');
    const laterResult = resultOf(await callAdvance(later.ctx, lowServices, runs, args, 1));
    expect(laterResult.details?.['stopReason']).toBe('low-confidence');
    expect(low.calls).toBe(1);

    const replayAfterLater = journaling('a', firstContext.journal);
    const afterLater = resultOf(await callAdvance(replayAfterLater.ctx, services, runs, args));
    expect(afterLater.details?.['stopReason']).toBe(first.details?.['stopReason']);
    expect(replayAfterLater.created).toEqual(firstContext.created);
    expect(browser.clicks).toBe(0);
    expect(browser.types).toBe(1);
  });

  it('makes no browser change and no hidden auxiliary model call when native Jev is absent', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-no-native';
    await seedRun(store, runs);
    const browser = new FakeBrowser();
    const quickCalls = { count: 0 };
    const services = servicesFor(store, browserTools(browser), undefined, quickCalls);
    const ctx = journaling('n');
    const result = resultOf(await callAdvance(ctx.ctx, services, runs, { goal: 'Continue', maxActions: 4 }));
    expect(result.details?.['stopReason']).toBe('native-unavailable');
    expect(result.details?.['native']).toBe(false);
    expect(result.details?.['nativeAttempted']).toBe(false);
    expect(result.details?.['nativeDecisionUsed']).toBe(false);
    expect(result.details?.['actionCount']).toBe(0);
    expect(browser.clicks + browser.types + browser.fills).toBe(0);
    expect(browser.snapshots).toBe(1);
    expect(quickCalls.count).toBe(0);
  });

  it('reports native:false when the production wrapper is present but returns null', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-null-native';
    await seedRun(store, runs);
    const browser = new FakeBrowser();
    let asks = 0;
    const systemOne: SystemOne = { ask: async () => { asks += 1; return null; } };
    const services = servicesFor(store, browserTools(browser), systemOne);
    const result = resultOf(await callAdvance(journaling('nn').ctx, services, runs, { goal: 'Continue' }));
    expect(result.details?.['stopReason']).toBe('native-unavailable');
    expect(result.details?.['native']).toBe(false);
    expect(result.details?.['nativeAttempted']).toBe(true);
    expect(result.details?.['nativeDecisionUsed']).toBe(false);
    expect(asks).toBe(1);
    expect(browser.clicks + browser.types).toBe(0);
  });

  it('remembers a low-confidence stage by goal and values but retries after a goal change', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-memory';
    await seedRun(store, runs);
    const browser = new FakeBrowser();
    const low = new ScriptedJev(() => answer('DONE', 0.55));
    const services = servicesFor(store, browserTools(browser), low);
    const first = resultOf(await callAdvance(journaling('m1').ctx, services, runs, { goal: 'Do the first thing', values: { Destination: 'Singapore' } }, 0));
    expect(first.details?.['stopReason']).toBe('low-confidence');
    expect(low.calls).toBe(1);
    const second = resultOf(await callAdvance(journaling('m2').ctx, services, runs, { goal: 'Do the first thing', values: { Destination: 'Singapore' } }, 1));
    expect(second.details?.['stopReason']).toBe('blocked-repeat');
    expect(low.calls).toBe(1);
    const third = resultOf(await callAdvance(journaling('m3').ctx, services, runs, { goal: 'Do a different thing', values: { Destination: 'Singapore' } }, 2));
    expect(third.details?.['stopReason']).toBe('low-confidence');
    expect(low.calls).toBe(2);
  });

  it('gives the native decision the actual eligible main-supplied value, once, and never a sensitive value', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-values';
    await seedRun(store, runs);
    const browser = new FakeBrowser();
    browser.page = () => page([
      { ref: 'e1', role: 'textbox', name: 'Max price', ...(browser.phase === 0 ? {} : { value: '900' }) },
      { ref: 'e2', role: 'textbox', name: 'Password' },
      { ref: 'e3', role: 'button', name: 'Apply' },
    ], browser.phase);
    const jev = new ScriptedJev(chooseFromOptions('Type the exact main-supplied value for "Max price"'));
    const services = servicesFor(store, browserTools(browser), jev);
    const result = resultOf(await callAdvance(journaling('v').ctx, services, runs, {
      goal: 'Set the maximum price', values: { 'Max price': '900', Password: 'hunter2' }, maxActions: 1,
    }));
    expect(browser.types).toBe(1);
    expect(jev.calls).toBe(1);
    expect(jev.states[0]).toContain('"label":"Max price"');
    expect(jev.states[0]).toContain('"value":"900"');
    expect(jev.states[0]).not.toContain('hunter2');
    expect(result.details?.['stopReason']).toBe('max-actions');
  });

  it('executes only majority winners with a sufficient lead through the canonical click path', async () => {
    const cases = [
      { probability: 0.78, second: 0.18, execute: true },
      { probability: 0.51, second: 0.25, execute: true },
      { probability: 0.50, second: 0.30, execute: false },
      { probability: 0.49, second: 0.30, execute: false },
      { probability: 0.55, second: 0.45, execute: false },
    ];
    for (const [index, testCase] of cases.entries()) {
      resetBrowserAdvanceMemoryForTests();
      const store = createMemoryStore();
      const runId = 'run-majority-' + String(index);
      await seedRun(store, runId);
      const browser = new FakeBrowser();
      const jev = new ScriptedJev((question) => {
        const key = Object.entries(question.options).find(([, description]) => description?.includes('"Continue"'))?.[0] ?? 'DEFER';
        return { type: 'choice', choice: key, confidence: testCase.probability,
          probabilities: { [key]: testCase.probability, DONE: testCase.second, DEFER: Math.max(0, 1 - testCase.probability - testCase.second) } };
      });
      const services = servicesFor(store, browserTools(browser), jev);
      const result = resultOf(await callAdvance(journaling('majority-' + String(index)).ctx, services, runId, { stage: 'interact', goal: 'Continue', maxActions: 1 }));
      expect(browser.clicks, JSON.stringify(testCase)).toBe(testCase.execute ? 1 : 0);
      expect(result.details?.['stopReason']).toBe(testCase.execute ? 'max-actions' : 'low-confidence');
    }
  });

  it('fails closed on a malformed native probability distribution without an action', async () => {
    const cases: Array<{ name: string; mutate: (probabilities: Record<string, number>) => void }> = [
      { name: 'nan', mutate: (probabilities) => { probabilities[Object.keys(probabilities)[0] ?? 'DONE'] = Number.NaN; } },
      { name: 'negative', mutate: (probabilities) => { probabilities[Object.keys(probabilities)[0] ?? 'DONE'] = -0.1; } },
      { name: 'sum-two', mutate: (probabilities) => { probabilities[Object.keys(probabilities)[0] ?? 'DONE'] = 1; } },
      { name: 'unknown-key', mutate: (probabilities) => { probabilities['rogue'] = 0.01; } },
    ];
    for (const testCase of cases) {
      resetBrowserAdvanceMemoryForTests();
      const store = createMemoryStore();
      const runs = 'run-advance-malformed-' + testCase.name;
      await seedRun(store, runs);
      const browser = new FakeBrowser();
      const systemOne = new ScriptedJev((question) => malformedDistribution(question, testCase.mutate));
      const services = servicesFor(store, browserTools(browser), systemOne);
      const result = resultOf(await callAdvance(journaling('bad' + testCase.name).ctx, services, runs, { goal: 'Continue' }));
      expect(result.details?.['stopReason']).toBe('invalid-decision');
      expect(result.details?.['actionCount']).toBe(0);
      expect(browser.clicks + browser.types + browser.fills).toBe(0);
    }
  });

  it('routes an inner click approval by browser.click name and denial prevents the effect', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-denied';
    await seedRun(store, runs);
    await store.put('rules', ruleFor('browser.click', 'ask'));
    const browser = new FakeBrowser();
    const jev = new ScriptedJev(ordinaryAdvance(browser));
    const services = servicesFor(store, browserTools(browser), jev);
    const context = journaling('d');
    const running = callAdvance(context.ctx, services, runs, { goal: 'Continue', maxActions: 2 });
    void running.catch(() => undefined);
    const request = await pendingRequest(store);
    expect(request.tool).toBe('browser.click');
    expect(browser.clicks).toBe(0);
    await store.patch('requests', request.id, { status: 'denied', resolvedAt: AT });
    context.ctx.decide({ action: 'deny' });
    const outcome = resultOf(await running);
    expect(outcome.isError).toBe(true);
    expect(browser.clicks).toBe(0);
    expect((await readTranscript(store, SESSION)).filter((entry) => (entry.message as { toolCallId?: string }).toolCallId === 'call-1')).toHaveLength(1);
  });

  it('applies an approval to the inner browser.click and then performs that click', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-approved';
    await seedRun(store, runs);
    await store.put('rules', ruleFor('browser.click', 'ask'));
    const browser = new FakeBrowser();
    const services = servicesFor(store, browserTools(browser), new ScriptedJev(ordinaryAdvance(browser)));
    const context = journaling('y');
    const running = callAdvance(context.ctx, services, runs, { goal: 'Continue', maxActions: 1 });
    void running.catch(() => undefined);
    const request = await pendingRequest(store);
    expect(request.tool).toBe('browser.click');
    await store.patch('requests', request.id, { status: 'approved', resolvedAt: AT });
    context.ctx.decide({ action: 'approve' });
    const outcome = resultOf(await running);
    expect(outcome.isError).toBeUndefined();
    expect(browser.clicks).toBe(1);
    expect(outcome.details?.['stopReason']).toBe('max-actions');
  });

  it('re-checks the outer rule after approval before any native call or child action', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-rule-changed';
    await seedRun(store, runs);
    await store.put('rules', ruleFor('browser.advance', 'ask'));
    const browser = new FakeBrowser();
    const jev = new ScriptedJev(ordinaryAdvance(browser));
    const services = servicesFor(store, browserTools(browser), jev);
    const context = journaling('rr');
    const running = callAdvance(context.ctx, services, runs, { goal: 'Continue' });
    void running.catch(() => undefined);
    const request = await pendingRequest(store);
    expect(request.tool).toBe('browser.advance');
    await store.put('rules', ruleFor('browser.advance', 'handoff'));
    await store.patch('requests', request.id, { status: 'approved', resolvedAt: AT });
    context.ctx.decide({ action: 'approve' });
    const outcome = resultOf(await running);
    expect(outcome.isError).toBe(true);
    expect(browser.snapshots).toBe(0);
    expect(jev.calls).toBe(0);
  });

  it('approves the inner click and never runs a later action after suspension', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-suspend';
    await seedRun(store, runs);
    const browser = new FakeBrowser();
    const jev = new ScriptedJev(ordinaryAdvance(browser));
    const tools = browserTools(browser);
    const click = tools.find((tool) => tool.name === 'browser.click');
    if (click === undefined) throw new Error('missing click');
    tools[tools.indexOf(click)] = {
      ...click,
      execute: async (): Promise<ToolResult> => ({
        content: [{ type: 'text', text: 'Needs user hand-back' }],
        suspend: { reason: 'user', awakeableId: 'hand-back-1' },
      }),
    };
    const services = servicesFor(store, tools, jev);
    const result = resultOf(await callAdvance(journaling('s').ctx, services, runs, { goal: 'Continue', maxActions: 3 }));
    expect(result.suspend).toEqual({ reason: 'user', awakeableId: 'hand-back-1' });
    expect(result.details?.['stopReason']).toBe('suspended');
    expect(browser.types).toBe(0);
    expect(result.details?.['actionCount']).toBe(1);
  });

  it('cancels a pending native decision without an action or transcript', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-stop';
    await seedRun(store, runs);
    const browser = new FakeBrowser();
    const pending = new Promise<Record<string, SystemOneAnswer> | null>(() => {});
    const systemOne: SystemOne = { ask: async () => pending };
    const services = servicesFor(store, browserTools(browser, 5_000), systemOne);
    let cancel: Promise<boolean | undefined> = new Promise<boolean | undefined>(() => {});
    const never = new Promise<boolean>(() => {});
    const cancellation = createRunCancellation({ peek: () => cancel, get: () => RestatePromise.resolve(never) });
    const running = callAdvance(journaling('x').ctx, services, runs, { goal: 'Continue' }, 0, cancellation);
    for (let attempt = 0; attempt < 200 && browser.snapshots === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    cancel = Promise.resolve(true);
    cancellation.abort();
    expect(await running).toBe(CANCELLED);
    expect(browser.clicks + browser.types).toBe(0);
    expect(await readTranscript(store, SESSION)).toHaveLength(0);
  });

  it('rejects an out-of-bounds action count before reading or acting', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-bound';
    await seedRun(store, runs);
    const browser = new FakeBrowser();
    const services = servicesFor(store, browserTools(browser), new ScriptedJev(ordinaryAdvance(browser)));
    const result = resultOf(await callAdvance(journaling('b').ctx, services, runs, { goal: 'Continue', maxActions: 7 }));
    expect(result).toMatchObject({ isError: true, details: { code: 'invalid_arguments' } });
    expect(browser.snapshots).toBe(0);
    expect(browser.clicks).toBe(0);
  });

  it('does not silently truncate an oversized observed candidate set', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-candidate-cap';
    await seedRun(store, runs);
    const browser = new FakeBrowser();
    browser.page = () => ({
      action: 'snapshot', tab: 't1', url: 'https://fixture.invalid/huge', title: 'Huge',
      nodes: Array.from({ length: 125 }, (_, index) => ({ ref: 'h' + String(index), role: 'button', name: 'Button ' + String(index) })),
      crossOriginFrames: 0,
    });
    const jev = new ScriptedJev(ordinaryAdvance(browser));
    const services = servicesFor(store, browserTools(browser), jev);
    const result = resultOf(await callAdvance(journaling('cc').ctx, services, runs, { goal: 'Pick one control' }));
    expect(result.details?.['stopReason']).toBe('done-requested');
    expect(result.details?.['candidateCount']).toBe(125);
    expect(jev.calls).toBe(1);
    expect(browser.clicks).toBe(0);
    const canonical = browserResultSchema.parse(JSON.parse(String(result.details?.['browserObservation'])));
    if (canonical.action !== 'snapshot') throw new Error('expected snapshot');
    expect(canonical.nodes).toHaveLength(125);
  });

  it('expands beyond 32 and 124 candidates without browser effects, then fences the observed target and replays', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-expand-target';
    await seedRun(store, runs);
    const browser = new FakeBrowser();
    browser.page = () => ({ action: 'snapshot', tab: 't1', url: 'https://fixture.invalid/large', title: 'Large', crossOriginFrames: 0,
      nodes: Array.from({ length: 200 }, (_, i) => ({ ref: 'x' + i, role: 'link', name: i === 199 ? 'Target resource' : 'Resource ' + i })) });
    const jev = new ScriptedJev(question => {
      const target = Object.entries(question.options).find(([, description]) => description?.startsWith('Click observed') && description?.includes('Target resource'));
      const group = Object.entries(question.options).find(([key, description]) => key.startsWith('EXPAND_') && description?.includes('Target resource'));
      expect(browser.clicks).toBe(0);
      return answer(target?.[0] ?? group?.[0] ?? 'DEFER', target === undefined ? 0.6 : 0.9);
    });
    const tools = browserTools(browser).map(tool => tool.name === 'browser.click' ? { ...tool, execute: async (args: unknown) => {
      expect(args).toMatchObject({ ref: 'x199' });
      return browser.click();
    } } : tool);
    const services = servicesFor(store, tools, jev);
    const ctx = journaling('expand');
    const args = { goal: 'Open Target resource', maxActions: 1 };
    const result = resultOf(await callAdvance(ctx.ctx, services, runs, args));
    expect(browser.clicks).toBe(1);
    expect(browser.snapshots).toBe(1);
    expect(jev.calls).toBeGreaterThan(1);
    expect(jev.calls).toBeLessThanOrEqual(12);
    expect(result.details?.['candidateCount']).toBe(200);
    expect(result.details?.['actionCount']).toBe(1);
    expect(result.details?.['lastDecision']).toMatchObject({ kind: 'chosen', key: 'a199' });
    const calls = jev.calls;
    const replay = resultOf(await callAdvance(journaling('expand', ctx.journal).ctx, services, runs, args));
    expect(browser.clicks).toBe(1);
    expect(jev.calls).toBe(calls);
    expect(replay.details).toEqual(result.details);
  });

  it('rejects an undisclosed ref and still blocks a low-confidence click after observation expansion', async () => {
    for (const hidden of [true, false]) {
      resetBrowserAdvanceMemoryForTests();
      const store = createMemoryStore();
      const runs = 'run-hidden-' + String(hidden);
      await seedRun(store, runs);
      const browser = new FakeBrowser();
      browser.page = () => ({ action: 'snapshot', tab: 't1', url: 'https://fixture.invalid/large', title: 'Large', crossOriginFrames: 0,
        nodes: Array.from({ length: 200 }, (_, i) => ({ ref: 'x' + i, role: 'link', name: i === 199 ? 'Target resource' : 'Resource ' + i })) });
      const jev = new ScriptedJev(question => {
        if (hidden) return answer('a199');
        const target = Object.entries(question.options).find(([, description]) => description?.startsWith('Click observed') && description?.includes('Target resource'));
        const group = Object.entries(question.options).find(([key, description]) => key.startsWith('EXPAND_') && description?.includes('Target resource'));
        return answer(target?.[0] ?? group?.[0] ?? 'DEFER', 0.55);
      });
      const result = resultOf(await callAdvance(journaling('hidden-' + String(hidden)).ctx, servicesFor(store, browserTools(browser), jev), runs, { goal: 'Open Target resource' }));
      expect(result.details?.['stopReason']).toBe(hidden ? 'invalid-decision' : 'low-confidence');
      expect(browser.clicks + browser.types).toBe(0);
      expect(jev.calls).toBe(hidden ? 1 : 2);
    }
  });

  it('bounds observation expansion separately and returns full state without authorizing hidden refs', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-expand-budget';
    await seedRun(store, runs);
    const browser = new FakeBrowser();
    const jev = new ScriptedJev(question => answer(Object.keys(question.options).find(key => key.startsWith('EXPAND_')) ?? 'BACK'));
    const result = resultOf(await callAdvance(journaling('expand-budget').ctx, servicesFor(store, browserTools(browser), jev), runs, { goal: 'Inspect all controls' }));
    expect(result.details?.['stopReason']).toBe('observation-limit');
    expect(jev.calls).toBe(12);
    expect(browser.clicks + browser.types).toBe(0);
    expect(JSON.parse(String(result.details?.['browserObservation'])).nodes).toHaveLength(62);
  });

  it('halts on an initial snapshot error or suspension before observing or asking', async () => {
    resetBrowserAdvanceMemoryForTests();
    for (const failure of [
      { name: 'error', result: { content: [{ type: 'text' as const, text: 'snapshot refused' }], isError: true } as ToolResult },
      { name: 'suspend', result: { content: [{ type: 'text' as const, text: 'waiting' }], suspend: { reason: 'user' as const, awakeableId: 'snap-wait' } } as ToolResult },
    ]) {
      const store = createMemoryStore();
      const runs = 'run-advance-initial-' + failure.name;
      await seedRun(store, runs);
      const browser = new FakeBrowser();
      const tools = browserTools(browser);
      const snapshot = tools.find((tool) => tool.name === 'browser.snapshot');
      if (snapshot === undefined) throw new Error('missing snapshot');
      tools[tools.indexOf(snapshot)] = { ...snapshot, execute: async () => failure.result };
      const jev = new ScriptedJev(ordinaryAdvance(browser));
      const services = servicesFor(store, tools, jev);
      const result = resultOf(await callAdvance(journaling('i' + failure.name).ctx, services, runs, { goal: 'Continue' }));
      expect(jev.calls).toBe(0);
      expect(browser.clicks).toBe(0);
      if (failure.name === 'error') {
        expect(result.isError).toBe(true);
        expect(result.details?.['stopReason']).toBe('snapshot-error');
      } else {
        expect(result.suspend).toEqual({ reason: 'user', awakeableId: 'snap-wait' });
        expect(result.details?.['stopReason']).toBe('suspended');
      }
    }
  });

  it('replays stalled parents with identical journal order and suppresses the same stage in a later parent', async () => {
    resetBrowserAdvanceMemoryForTests();
    const store = createMemoryStore();
    const runs = 'run-advance-stalled';
    await seedRun(store, runs);
    const browser = new FakeBrowser();
    const tools = browserTools(browser);
    const click = tools.find((tool) => tool.name === 'browser.click');
    if (click === undefined) throw new Error('missing click');
    tools[tools.indexOf(click)] = { ...click, execute: async () => { browser.clicks += 1; return browser.result(); } };
    const services = servicesFor(store, tools, new ScriptedJev(chooseFromOptions('"Continue"')));
    const args = { goal: 'Try a control that does nothing', maxActions: 2 };
    const original = journaling('st');
    const before = resultOf(await callAdvance(original.ctx, services, runs, args));
    expect(before.details?.['stopReason']).toBe('stalled');
    expect(browser.clicks).toBe(1);
    const replay = journaling('st', original.journal);
    const after = resultOf(await callAdvance(replay.ctx, services, runs, args));
    expect(after.details?.['stopReason']).toBe('stalled');
    expect(replay.created).toEqual(original.created);
    expect(browser.clicks).toBe(1);
    const later = resultOf(await callAdvance(journaling('st2').ctx, services, runs, args, 1));
    expect(later.details?.['stopReason']).toBe('blocked-repeat');
    expect(browser.clicks).toBe(1);
  });

  it('replays DONE and unavailable parents with identical journal order and no extra effects', async () => {
    resetBrowserAdvanceMemoryForTests();
    const cases: Array<{ name: string; systemOne?: SystemOne; handler?: AdvanceHandler; expectReason: string }> = [
      { name: 'done', handler: choose('DONE'), expectReason: 'done-requested' },
      { name: 'unavailable', expectReason: 'native-unavailable' },
    ];
    for (const testCase of cases) {
      const store = createMemoryStore();
      const runs = 'run-replay-' + testCase.name;
      await seedRun(store, runs);
      const browser = new FakeBrowser();
      const systemOne = testCase.systemOne ?? (testCase.handler === undefined ? undefined : new ScriptedJev(testCase.handler));
      const services = servicesFor(store, browserTools(browser), systemOne);
      const args = { goal: 'Replay ' + testCase.name, maxActions: 2 };
      const original = journaling(testCase.name);
      const before = resultOf(await callAdvance(original.ctx, services, runs, args));
      expect(before.details?.['stopReason']).toBe(testCase.expectReason);
      if (testCase.name === 'done') {
        expect(before.content[0]?.type === 'text' ? before.content[0].text : '').toContain('not evidence that the task succeeded');
      }
      const replay = journaling(testCase.name, original.journal);
      const after = resultOf(await callAdvance(replay.ctx, services, runs, args));
      expect(after.details?.['stopReason']).toBe(testCase.expectReason);
      expect(after.details?.['progress']).toEqual(before.details?.['progress']);
      expect(replay.created).toEqual(original.created);
      expect(browser.clicks + browser.types).toBe(0);
    }
  });

  it('propagates the Mac target to every nested snapshot, action and read', async () => {
    resetBrowserAdvanceMemoryForTests();
    const browser = new FakeBrowser();
    const jev = new ScriptedJev(ordinaryAdvance(browser));
    const seen: Array<{ action: string; args: Record<string, unknown> }> = [];
    const execute = async (action: 'snapshot' | 'click' | 'type' | 'fill' | 'get_text', args: Record<string, unknown>): Promise<AdvanceExecution> => {
      seen.push({ action, args });
      if (action === 'snapshot') return { kind: 'completed', result: browser.snapshot(args['on']) };
      if (action === 'click') return { kind: 'completed', result: browser.click(args['on']) };
      if (action === 'type') return { kind: 'completed', result: browser.type(args['on']) };
      if (action === 'fill') return { kind: 'completed', result: browser.fill(args['on']) };
      return { kind: 'completed', result: browser.read(args['on']) };
    };
    const outcome = await runBrowserAdvance({
      args: { goal: 'Continue', values: { Destination: 'Singapore' }, on: 'mac', maxActions: 4 },
      ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: 'run-advance-mac', stepId: 'stp_mac',
      signal: new AbortController().signal, systemOne: jev, journal: async (_key, action) => action(), execute,
    });
    expect(outcome.kind).toBe('completed');
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((call) => call.args['on'] === 'mac')).toBe(true);
    expect(seen.map((call) => call.action)).toEqual(expect.arrayContaining(['snapshot', 'click', 'type']));
  });

  it('fails a direct tool invocation closed instead of mutating the browser', async () => {
    const tool = createComputerBrowserAdvanceTool({});
    const result = await tool.execute({}, {} as ToolContext);
    expect(result).toMatchObject({ isError: true, details: { code: 'orchestration_required', actionCount: 0 } });
  });
});

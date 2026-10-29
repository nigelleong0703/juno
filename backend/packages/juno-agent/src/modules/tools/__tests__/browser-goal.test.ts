import { beforeEach, describe, expect, it } from 'vitest';
import { chromeGoalSession } from '../computer/upstream-browser.js';
import { createGoalBrowserTools } from '../tools/browserGoals.js';
import { resetBrowserAdvanceMemoryForTests } from '../computer/browser-advance.js';
import type { RunBrowserAdvanceOptions, SnapshotPage } from '../computer/browser-advance-types.js';
import type { SystemOne, SystemOneAnswers, SystemOneQuestion } from '../../../ports/system-one/index.js';
import { createToolRegistry } from '../index.js';
import { presentForModel } from '../tools/toolSearch.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';

function answers(questions: Record<string, SystemOneQuestion>, chosen: Record<string, string>, done = false): SystemOneAnswers {
  return Object.fromEntries(Object.entries(questions).map(([key, q]) => {
    if (q.type === 'noul') return [key, { type: 'noul', probability: key.startsWith('done') && done ? 0.96 : 0.01 }];
    if (q.type !== 'choice') throw new Error('unexpected score');
    const keys = Object.keys(q.options); const winner = chosen[key] ?? keys[0]!;
    return [key, { type: 'choice', choice: winner, confidence: 0.8, probabilities: Object.fromEntries(keys.map(k => [k, keys.length === 1 ? 1 : k === winner ? 0.8 : 0.2 / (keys.length - 1)])) }];
  }));
}

function withDom(page: SnapshotPage): SnapshotPage {
  return { ...page, upstream: { url: page.url, title: page.title, text: '', metrics: {}, elements: page.nodes.filter(n => n.ref).map((n, i) => ({ i, tag: n.role === 'textbox' ? 'input:text' : n.role, ref: n.ref!, label: n.name, value: n.value })) } };
}

function fixture(suspend = false) {
  let phase = 0; const calls: string[] = [];
  const page = (): SnapshotPage => ({ action: 'snapshot', tab: 't1', title: 'Draft', url: 'https://fixture.invalid/', crossOriginFrames: 0,
    nodes: phase === 0 ? [{ ref: 'open', role: 'button', name: 'Open city' }] : [{ ref: 'city', role: 'textbox', name: 'Destination', ...(phase === 2 ? { value: 'Bangkok' } : {}) }] });
  const systemOne: SystemOne = { async ask(_state, qs, _signal, options) { expect(options?.stateEncoding).toBe('json'); expect(qs.target?.type === 'choice' ? qs.target.options['0'] : undefined).toBeNull(); return answers(qs, { tool: phase === 0 ? 'click' : 'type', target: '0', value: 'city' }, phase === 2); } };
  const options = { goalMode: true, ownerId: 'owner', agentId: 'agent', conversationId: 'conv', runId: 'run-goal', signal: new AbortController().signal,
    args: { completion: [{ match: { label: 'Destination' }, property: 'value', equals: 'Bangkok' }], goal: 'Set destination Bangkok', values: { city: 'Bangkok' }, maxActions: 4 }, systemOne,
    journal: async <T>(_key: string, fn: () => Promise<T>): Promise<T> => fn(),
    execute: async (action: string, args: Record<string, unknown>) => {
      calls.push(action);
      if (action !== 'snapshot') {
        if (suspend) return { kind: 'completed' as const, result: { content: [], suspend: { reason: 'user' as const } } };
        expect(args.tab).toBe('t1');
        if (action === 'type') expect(args.text).toBe('Bangkok');
        phase++;
      }
      return { kind: 'completed' as const, result: { content: [{ type: 'text' as const, text: 'page display' }], details: { browserObservation: JSON.stringify(withDom(page())) } } };
    },
  };
  return { options, calls };
}

async function context(options: RunBrowserAdvanceOptions) {
  const store = createMemoryStore();
  await store.forOwner!(options.ownerId).put('runs', { id: options.runId, agentId: options.agentId, conversationId: options.conversationId } as never);
  return { store, stepId: 'step-goal', ownerId: options.ownerId, agentId: options.agentId, conversationId: options.conversationId, runId: options.runId, systemOne: options.systemOne } as never;
}
async function runBrowserAdvance(options: RunBrowserAdvanceOptions) {
  const tool = createGoalBrowserTools().find(t => t.name === 'browser.do')!;
  return tool.orchestrate!(options.args, await context(options),
    { signal: options.signal, journal: options.journal, run: options.execute });
}

describe('goal browser adapter', () => {
  beforeEach(() => resetBrowserAdvanceMemoryForTests());
  it('chooses its model-facing interface from native availability without opening a computer', async () => {
    let native = true;
    const registry = await createToolRegistry({ store: createMemoryStore(), enqueuer: new NoopEnqueuer(), computer: () => { throw new Error('must not probe'); }, nativeBrowserAvailable: async () => native });
    let shown = presentForModel(await registry.forAgent('a'), {}).map(t => t.name);
    expect(shown).toEqual(expect.arrayContaining(['browser.open', 'browser.do', 'browser.read', 'browser.check', 'browser.act']));
    expect(shown).not.toContain('browser.advance'); expect(shown).not.toContain('browser.click');
    const reversed = presentForModel((await registry.forAgent('a')).reverse(), {}).map(t => t.name);
    expect(reversed).toEqual(shown);
    native = false;
    shown = presentForModel(await registry.forAgent('a'), {}).map(t => t.name);
    expect(shown).toContain('browser.click'); expect(shown).not.toContain('browser.do'); expect(shown).not.toContain('browser.advance');
    expect(registry.get('browser.click')).toBeDefined();
    native = true;
    const search = await registry.get('tool_load')!.execute({ names: ['browser.advance', 'browser.do'] }, { agentId: 'a', runId: 'r', store: createMemoryStore(), signal: new AbortController().signal } as never);
    const text = search.content.filter(b => b.type === 'text').map(b => b.text).join('');
    expect(text).toContain('Exact tools (1 of 2 found)');
    expect(text).toContain('browser.advance — not found');
  });
  it('runs mixed click and supplied typing through canonical dispatch and returns compact evidence', async () => {
    const { options, calls } = fixture();
    const result = await runBrowserAdvance(options as RunBrowserAdvanceOptions);
    expect(calls).toEqual(['snapshot', 'click', 'snapshot', 'type', 'snapshot', 'snapshot']);
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.result.details?.stopReason).toBe('done');
    expect(result.result.content).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('Latest full state') })]));
  });
  it('preserves likely_done and verifies the still-open page with a fresh snapshot', async () => {
    const options = fixture().options as RunBrowserAdvanceOptions;
    let reads = 0;
    options.execute = async () => {
      reads++;
      const page = withDom({ action: 'snapshot', tab: 't1', url: 'https://fixture.invalid/', title: 'Picker', crossOriginFrames: 0,
        nodes: [{ ref: 'apply', role: 'button', name: 'Apply date' }, { ref: 'date', role: 'textbox', name: 'Departure', value: '2026-11-06' }] });
      return { kind: 'completed', result: { content: [], details: { browserObservation: JSON.stringify(page) } } };
    };
    options.systemOne = { async ask(_state, questions) {
      const result = answers(questions, { tool: 'none', target: '0' }, true);
      if (questions.complete) result.complete = { type: 'noul', probability: 0.5 };
      return result;
    } };
    const outcome = await runBrowserAdvance(options as RunBrowserAdvanceOptions);
    expect(reads).toBe(2);
    if (outcome.kind !== 'completed') throw new Error('expected result');
    const text = outcome.result.content.find(b => b.type === 'text');
    const result = JSON.parse(text?.type === 'text' ? text.text : '{}');
    expect(result.status).toBe('likely_done');
    expect(result.handoff.current_page).toContain('Apply date');
    expect(result.handoff.current_page).toContain('2026-11-06');
  });
  it('feeds actual zero scroll displacement back into the original upstream history', async () => {
    const { options } = fixture();
    let requests = 0;
    options.systemOne = { async ask(state, questions) {
      if (requests++ > 0) expect(JSON.parse(state).task.history[0].result).toContain('0 px');
      return answers(questions, { tool: 'scroll', target: '0' }, requests > 1);
    } };
    const tool = createGoalBrowserTools().find(t => t.name === 'browser.do')!;
    const outcome = await tool.orchestrate!(options.args, await context(options as RunBrowserAdvanceOptions),
      { signal: options.signal, journal: options.journal, run: async (action, args) => action === 'scroll' ? { kind: 'completed', result: { content: [], details: { scrolled: 0 } } } : options.execute(action, args) });
    if (outcome.kind !== 'completed') throw new Error('expected completed');
    expect(outcome.result.isError).not.toBe(true);
    expect(requests).toBeGreaterThan(1);
  });
  it('preserves suspension before performing another nested action', async () => {
    const { options, calls } = fixture(true);
    const result = await runBrowserAdvance(options as unknown as RunBrowserAdvanceOptions);
    expect(calls).toEqual(['snapshot', 'click']);
    if (result.kind === 'completed') expect(result.result.suspend).toEqual({ reason: 'user' as const });
  });
  it('does not emulate a missing native model or perform a mutation', async () => {
    const { options, calls } = fixture();
    options.systemOne = { async ask() { return null; } };
    const result = await runBrowserAdvance(options as RunBrowserAdvanceOptions);
    expect(calls).toEqual(['snapshot']);
    if (result.kind === 'completed') expect(result.result.details?.code).toBe('upstream_browser_handoff');
  });
  it('keeps targets in a second likely group reachable rather than truncating the page', async () => {
    const { options } = fixture();
    const pg: SnapshotPage = { action: 'snapshot', tab: 't1', title: 'Many controls', url: 'https://fixture.invalid/', crossOriginFrames: 0,
      nodes: Array.from({ length: 300 }, (_, i) => ({ ref: 'r' + i, role: 'button', name: 'Control ' + i })) };
    let calls = 0;
    options.systemOne = { async ask(state, qs) {
      calls++;
      if (calls === 1) return answers(qs, { tool: 'click', group: '0' });
      expect(JSON.parse(state).page.elements.some((n: { i: number }) => n.i === 40)).toBe(true);
      return answers(qs, { target: '40' });
    } };
    const bridge = chromeGoalSession({ ownerId: 'o', agentId: 'a', conversationId: 'c', runId: 'r', systemOne: options.systemOne } as never, { signal: options.signal, journal: options.journal, run: options.execute }, {});
    const result = await bridge.session.decide({ url: pg.url, title: pg.title, text: '', metrics: {}, elements: pg.nodes.map((n, i) => ({ i, tag: 'button', text: n.name })) }, 'Choose Control 40', {}, []);
    expect(calls).toBe(2); expect((result.target as { choice: string }).choice).toBe('40');
  });
  it('rejects secret value maps before reading a page or contacting native inference', async () => {
    const tool = createGoalBrowserTools().find(t => t.name === 'browser.do')!;
    let touched = false;
    const outcome = await tool.orchestrate!({ goal: 'Log in', values: { password: 'private' } }, {} as never,
      { signal: new AbortController().signal, journal: async () => { touched = true; throw new Error('unexpected'); }, run: async () => { touched = true; throw new Error('unexpected'); } });
    expect(touched).toBe(false);
    if (outcome.kind === 'completed') expect(outcome.result.isError).toBe(true);
  });

  it('checks displayed input values from canonical controls, not body text alone', async () => {
    const check = createGoalBrowserTools().find(t => t.name === 'browser.check')!;
    const outcome = await check.orchestrate!({ question: 'Is Destination Bangkok?' }, { ownerId: 'o', agentId: 'a', conversationId: 'c', runId: 'r', systemOne: { async ask(state: string) {
      expect(JSON.parse(state).page.elements).toContainEqual(expect.objectContaining({ label: 'Destination', value: 'Bangkok' }));
      return { q: { type: 'noul', probability: 0.95 } };
    } } } as never, { signal: new AbortController().signal, journal: async (_key, fn) => fn(), run: async action => ({ kind: 'completed', result: { content: [{ type: 'text', text: 'Destination' }], ...(action === 'snapshot' ? { details: { browserObservation: JSON.stringify(withDom({ action: 'snapshot', tab: 't1', url: 'https://fixture.invalid/', title: 'Form', crossOriginFrames: 0, nodes: [{ role: 'textbox', ref: 'city', name: 'Destination', value: 'Bangkok' }] })) } } : {}) } }) });
    if (outcome.kind === 'completed') expect(JSON.parse(outcome.result.content[0]?.type === 'text' ? outcome.result.content[0].text : '{}').p_yes).toBe(0.95);
  });

});

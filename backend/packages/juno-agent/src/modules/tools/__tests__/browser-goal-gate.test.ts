import { verifyBrowserCompletion } from '../computer/browser-goal-gate.js';
import type { SystemOneQuestion } from '../../../ports/system-one/index.js';
import { describe, expect, it } from 'vitest';
import { createGoalBrowserTools } from '../tools/browserGoals.js';
import { createMemoryStore } from '../../../testing/store.js';
import type { ToolContext, ToolOrchestrationOutcome, ToolOrchestrationRuntime } from '../../../contracts/index.js';

const unpack = (out: ToolOrchestrationOutcome) => {
  if (out.kind !== 'completed') throw new Error('cancelled');
  const block = out.result.content.find(b => b.type === 'text');
  const text = block?.type === 'text' ? block.text : '{}';
  return { ...out.result, data: text.startsWith('{') ? JSON.parse(text) : { code: text } };
};
async function fixture() {
  const store = createMemoryStore();
  await store.put('runs', { id: 'r', ownerId: 'o', agentId: 'a', conversationId: 'c' } as never);
  let expanded = true; let nativeCalls = 0; let writes = 0;
  const ctx = { store, ownerId: 'o', agentId: 'a', conversationId: 'c', runId: 'r', stepId: 's1', systemOne: { async ask(_state: string, qs: Record<string, SystemOneQuestion>) {
    nativeCalls++;
    return Object.fromEntries(Object.entries(qs).map(([k, q]) => {
      if (q.type === 'noul') return [k, { type: 'noul', probability: k === 'done' || k === 'complete' ? 0.99 : 0.01 }];
      if (q.type !== 'choice') throw new Error('unexpected question');
      const choice = k === 'tool' ? 'none' : Object.keys(q.options)[0]!;
      return [k, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.options).map(key => [key, key === choice ? 1 : 0])) }];
    }));
  } } } as unknown as ToolContext;
  const runtime: ToolOrchestrationRuntime = { signal: new AbortController().signal, journal: async (_key, fn) => fn(), run: async action => {
    if (action === 'click') { writes++; expanded = false; }
    const upstream = { url: 'https://fixture.invalid/', title: 'Preferences', text: '', metrics: {}, elements: [
      { i: 0, tag: 'input:text', ref: 'value', label: 'Nickname', value: 'Mira' },
      ...(expanded ? [{ i: 1, tag: 'button', ref: 'close', text: 'Finish editing' }] : []),
    ] };
    return { kind: 'completed', result: { content: [], details: { browserObservation: JSON.stringify({ action: 'snapshot', tab: 't1', url: upstream.url, title: upstream.title, nodes: [], crossOriginFrames: 0, upstream }) } } };
  } };
  const call = async (name: string, args: Record<string, unknown>) => unpack(await createGoalBrowserTools().find(t => t.name === name)!.orchestrate!(args, ctx, runtime));
  return { call, ctx, store, runtime, counts: () => ({ nativeCalls, writes }) };
}
const completion = [{ match: { label: 'Nickname' }, property: 'value', equals: 'Mira' }, { match: { text: 'Finish editing' }, property: 'count', equals: 0 }];
describe('durable browser stage gate', () => {
  it('requires observable conditions before inference or effects', async () => {
    const f = await fixture();
    const result = await f.call('browser.do', { goal: 'Edit preferences' });
    expect(result.isError).toBe(true);
    expect(result.data.issues.some((issue: { message: string }) => issue.message.includes('completion'))).toBe(true);
    expect(f.counts()).toEqual({ nativeCalls: 0, writes: 0 });
  });
  it('keeps upstream done but blocks the next stage until direct recovery satisfies all original conditions', async () => {
    const f = await fixture();
    const first = await f.call('browser.do', { goal: 'Finish editing preferences', completion });
    expect(first.data.status).toBe('done');
    expect(first.data.verification.passed).toBe(false);
    const before = f.counts(); f.ctx.stepId = 's2';
    const blocked = await f.call('browser.do', { goal: 'Unrelated next outcome', completion: [{ match: { label: 'Nickname' }, property: 'value', equals: 'Mira' }] });
    expect(blocked.data.code).toBe('previous_browser_goal_pending');
    expect(f.counts()).toEqual(before);
    expect((await f.call('browser.open', { url: 'https://other.invalid/' })).data.code).toBe('previous_browser_goal_pending');
    const recovered = await f.call('browser.act', { action: 'click', args: { ref: 'close' } });
    expect(recovered.data.verification.passed).toBe(true);
    f.ctx.stepId = 's3';
    expect((await f.call('browser.do', { goal: 'Next', completion: [completion[0]] })).data.verification.passed).toBe(true);
    expect(f.counts().writes).toBe(1);
  });
});

describe('completion evidence boundaries', () => {
  it('retains original criteria during recovery and requires an explicit reason to abandon', async () => {
    const f = await fixture();
    await f.call('browser.do', { goal: 'Finish editing', completion });
    f.ctx.stepId = 'recovery';
    expect((await f.call('browser.do', { goal: 'Pretend done', recover: true, completion: [completion[0]] })).isError).toBe(true);
    const recovered = await f.call('browser.do', { goal: 'Close the observed editing panel', recover: true });
    expect(recovered.data.verification.conditions).toHaveLength(2);
    expect(recovered.data.pending).toBe(true);
    expect((await f.call('browser.act', { action: 'abandon' })).isError).toBe(true);
    expect((await f.call('browser.act', { action: 'abandon', args: { reason: 'User cancelled editing' } })).data).toMatchObject({ status: 'abandoned', verified: false });
    expect((await f.store.list('browserGoalGates')).items[0]?.status).toBe('abandoned');
    expect((await f.call('browser.do', { goal: 'Bypass failed stage', completion: [completion[0]] })).data.code).toBe('browser_goal_abandoned');
  });
  it('does not let nested scope or a different tab satisfy the pending stage', async () => {
    const f = await fixture();
    await f.call('browser.do', { goal: 'Finish editing', completion });
    expect((await f.call('browser.act', { action: 'click', args: { ref: 'close', tab: 't2' } })).data.code).toBe('scope_must_be_top_level');
    expect((await f.call('browser.act', { action: 'click', tab: 't2', args: { ref: 'close' } })).data.code).toBe('previous_browser_goal_pending');
    expect(f.counts().writes).toBe(0);
  });
});

it('fails ambiguous, missing, truncated and incomplete evidence without a model judgment', () => {
  const control = { i: 0, tag: 'input:text', label: 'Nickname', value: 'Mira' };
  const page = { url: 'https://fixture.invalid/', title: '', text: '', metrics: {}, elements: [control] };
  const criterion = [{ match: { label: 'Nickname' }, property: 'value' as const, equals: 'Mira' }];
  expect(verifyBrowserCompletion(page, criterion).passed).toBe(true);
  for (const [elements, metrics, reason] of [
    [[control, { ...control, i: 1 }], {}, 'ambiguous_control'],
    [[], {}, 'control_not_observed'],
    [[{ ...control, value: 'x'.repeat(60) }], {}, 'value_may_be_truncated'],
    [[control], { skippedFrames: 1 }, 'incomplete_page_coverage'],
  ] as const) {
    const result = verifyBrowserCompletion({ ...page, elements: [...elements], metrics }, criterion);
    expect(result.passed).toBe(false); expect(result.conditions[0]?.reason).toBe(reason);
  }
  expect(verifyBrowserCompletion({ ...page, elements: [{ i: 0, tag: 'input:checkbox', label: 'Keep signed in', checked: true }] }, [{ match: { label: 'Keep signed in' }, property: 'checked', equals: true }]).passed).toBe(true);
  expect(verifyBrowserCompletion({ ...page, elements: [{ i: 0, tag: 'button', text: 'Menu' }] }, [{ match: { text: 'Menu' }, property: 'expanded', equals: false }]).passed).toBe(false);
});

it('preserves a snapshot suspension and keeps a cancelled stage pending before any effects', async () => {
  const f = await fixture();
  f.runtime.run = async () => ({ kind: 'completed', result: { content: [], suspend: { reason: 'user' } } });
  expect((await f.call('browser.act', { action: 'snapshot' })).suspend).toEqual({ reason: 'user' });
  const aborted = new AbortController(); aborted.abort(); f.runtime.signal = aborted.signal;
  const outcome = await createGoalBrowserTools().find(t => t.name === 'browser.do')!.orchestrate!({ goal: 'Edit', completion }, f.ctx, f.runtime);
  expect(outcome.kind).toBe('cancelled');
  expect((await f.store.list('browserGoalGates')).items[0]?.status).toBe('pending');
  expect(f.counts()).toEqual({ nativeCalls: 0, writes: 0 });
});

it('batches known text with zero Jev/fast calls, and drafts optional text once through the existing fast route', async () => {
  const f = await fixture(); const seen: unknown[] = [];
  f.runtime.run = async (action, args) => { expect(action).toBe('fill'); seen.push(args); return { kind: 'completed', result: { content: [] } }; };
  let drafts = 0;
  f.ctx.quickText = async prompt => { drafts++; expect(prompt).toContain('Mira builds furniture'); return JSON.stringify({ fields: [{ ref: 'bio', text: 'Mira builds furniture.' }] }); };
  await f.call('browser.act', { action: 'fill', args: { fields: [{ ref: 'name', text: 'Mira' }, { ref: 'city', text: 'Singapore' }] } });
  expect(drafts).toBe(0);
  await f.call('browser.act', { action: 'write', args: { facts: 'Mira builds furniture', fields: [{ ref: 'bio', brief: 'One short sentence in English' }] } });
  expect(drafts).toBe(1); expect(seen).toHaveLength(2);
  expect(seen[1]).toMatchObject({ fields: [{ ref: 'bio', text: 'Mira builds furniture.' }] });
  expect(f.counts().nativeCalls).toBe(0);
});
it('refuses a fast draft that changes field targets before any canonical write', async () => {
  const f = await fixture();
  f.ctx.quickText = async () => JSON.stringify({ fields: [{ ref: 'other-field', text: 'wrong target' }] });
  f.runtime.run = async () => { throw new Error('must not write'); };
  expect((await f.call('browser.act', { action: 'write', args: { facts: 'Mira', fields: [{ ref: 'bio', brief: 'Introduce Mira' }] } })).data.code).toBe('browser_text_unavailable_use_exact_fill');
  expect(f.counts()).toEqual({ nativeCalls: 0, writes: 0 });
});

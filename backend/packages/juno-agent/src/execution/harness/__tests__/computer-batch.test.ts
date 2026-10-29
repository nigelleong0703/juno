/**
 * computer.batch (M-BATCH-TOOLS): sequencing, stop on failure, stop BEFORE a step that needs approval, the allowed-tool filter,
 * one durable step per action (replay and resume mid-batch), and the observation modes. Runs through the production tool
 * registry and the real browser tools against a fake browser helper, and the harness's canonical call path.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { RestatePromise } from '@agent-desktop/durable';
import type { Rule } from '@agent-desktop/public-contracts';
import type { Store, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { ComputerError, type BrowserResult, type ComputerClient } from '../../../modules/tools/computer/contract.js';
import { clearBrowserObservationState } from '../../../modules/tools/computer/browser-observation.js';
import { createToolRegistry } from '../../../modules/tools/index.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { NEVER_CANCELLED } from '../services/cancel.js';
import { executeSingleToolCall } from '../services/run-tools.js';
import type { RunInput, RunServices } from '../services/run-types.js';
import type { ToolCallContext } from '../services/tool-policy.js';
import { ScriptedModel } from '../testing/stubs.js';

const OWNER = 'owner-batch';
const AGENT = 'agent-batch';
const CONV = 'conv-batch';
const AT = '2026-10-26T00:00:00.000Z';
const SESSION = AGENT + ':' + CONV;
const wake: WakeEvent = {
  id: 'wake-batch', ownerId: OWNER, agentId: AGENT, sessionKey: SESSION, conversationId: CONV,
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text: 'go' }, at: AT, status: 'accepted',
};
const input: RunInput = { agentId: AGENT, conversationId: CONV, sessionKey: SESSION, wakeEvents: [wake] };

type SnapshotPage = Extract<BrowserResult, { action: 'snapshot' }>;

/** A one-tab fake browser helper: a small form whose fields keep what was typed, and a log of every action it served. */
class FakeBrowser {
  log: string[] = [];
  values: Record<string, string> = {};
  saved = false;
  submitName = 'Place order';
  /** Fail the next action of this kind (once), as a stale ref does. */
  failNext: string | undefined;

  page(): SnapshotPage {
    const field = (ref: string, name: string) => ({ ref, role: 'textbox', name, ...(this.values[ref] === undefined ? {} : { value: this.values[ref] }) });
    return {
      action: 'snapshot', tab: 't1', url: 'https://fixture.invalid/form', title: 'Form', crossOriginFrames: 0,
      nodes: [field('e1', 'Name'), field('e2', 'Notes'), { ref: 'e3', role: 'button', name: 'Save' }, { ref: 'e4', role: 'button', name: 'Place order' }, ...(this.saved ? [{ ref: 'e5', role: 'status', name: 'Saved' }] : [])],
    };
  }

  count(prefix: string): number { return this.log.filter((entry) => entry.startsWith(prefix)).length; }

  asClient(): ComputerClient {
    return {
      browser: async (_agentId: string, request: { action: string; ref?: string; text?: string; url?: string }): Promise<BrowserResult> => {
        this.log.push(request.action + (request.ref === undefined ? '' : ':' + request.ref));
        if (request.action === 'snapshot') return this.page();
        if (this.failNext === request.action) {
          this.failNext = undefined;
          throw new ComputerError('failed', 'ref ' + String(request.ref) + ' is stale');
        }
        const base = { tab: 't1', url: 'https://fixture.invalid/form', title: 'Form' };
        if (request.action === 'type') { this.values[request.ref ?? ''] = request.text ?? ''; return { action: 'type', ...base, typed: true }; }
        if (request.action === 'click') { if (request.ref === 'e3') this.saved = true; return { action: 'click', ...base, clicked: true }; }
        if (request.action === 'navigate') return { action: 'navigate', ...base };
        // The focused control is the Name field of a form whose submit button is "Place order" (or the one a test sets).
        if (request.action === 'point') return { action: 'point', ...base, element: { role: 'textbox', name: 'Name' }, submit: { role: 'button', name: this.submitName } };
        throw new Error('unexpected browser action ' + request.action);
      },
      pressKey: async (_agentId: string, key: string): Promise<void> => { this.log.push('key:' + key); },
    } as unknown as ComputerClient;
  }
}

function journaling(journal = new Map<string, unknown>()): { ctx: ToolCallContext; journal: Map<string, unknown> } {
  let next = 0;
  return {
    journal,
    ctx: {
      rand: { uuidv4: () => 'b' + String(next++) },
      run<T>(name: string, action: () => Promise<T>): RestatePromise<T> {
        if (journal.has(name)) return RestatePromise.resolve(structuredClone(journal.get(name)) as T);
        return RestatePromise.resolve(action().then((value) => { journal.set(name, structuredClone(value)); return value; }));
      },
      drainInbox: () => RestatePromise.resolve<WakeEvent[]>([]),
    },
  };
}

async function seedRun(store: Store, runId: string): Promise<void> {
  await (store.forOwner?.(OWNER) ?? store).put('agents', { id: AGENT, ownerId: OWNER, name: 'Batch' } as never);
  await (store.forOwner?.(OWNER) ?? store).put('conversations', { id: CONV, kind: 'direct', memberIds: [OWNER], agentIds: [AGENT] } as never);
  await (store.forOwner?.(OWNER) ?? store).put('runs', {
    id: runId, agentId: AGENT, conversationId: CONV, title: 'batch', status: 'running', kind: 'chat',
    steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: AT, lastActivityAt: AT,
  }, { conversationId: CONV });
}

async function servicesFor(store: Store, browser: FakeBrowser): Promise<RunServices> {
  const toolRegistry = await createToolRegistry({ store, enqueuer: new NoopEnqueuer(), computer: () => browser.asClient() });
  return { store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(), brain: new ScriptedModel(), toolRegistry };
}

function askRule(subject: string): Rule {
  return { id: 'rule-' + subject, description: 'r', scope: 'action', behavior: 'ask', source: 'user', enabled: true, subject, createdAt: AT, createdBy: OWNER };
}

type Step = { tool: string; args?: Record<string, unknown> };
const type = (ref: string, text: string): Step => ({ tool: 'browser.type', args: { ref, text } });
const click = (ref: string, extra: Record<string, unknown> = {}): Step => ({ tool: 'browser.click', args: { ref, ...extra } });

async function runBatch(services: RunServices, runId: string, args: Record<string, unknown>, journal = journaling()): Promise<{ result: ToolResult; journal: Map<string, unknown> }> {
  const outcome = await executeSingleToolCall(journal.ctx, services, input, runId, 0, 0, { id: 'call-batch', name: 'computer.batch', arguments: args }, NEVER_CANCELLED, []);
  if (typeof outcome === 'symbol') throw new Error('unexpected cancellation');
  return { result: outcome.result, journal: journal.journal };
}

const textOf = (result: ToolResult): string => result.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');

beforeEach(() => clearBrowserObservationState());

describe('computer.batch', () => {
  it('runs the steps in order, each as its own step, and reads the page once at the end', async () => {
    const store = createMemoryStore();
    await seedRun(store, 'run-seq');
    const browser = new FakeBrowser();
    const { result } = await runBatch(await servicesFor(store, browser), 'run-seq', { steps: [type('e1', 'Mira'), type('e2', 'Builds chairs'), click('e3')] });

    expect(result.isError).not.toBe(true);
    expect(browser.log.filter((entry) => entry !== 'snapshot')).toEqual(['type:e1', 'type:e2', 'click:e3']);
    // One observation for the whole batch, not one per action.
    expect(browser.count('snapshot')).toBe(1);
    const text = textOf(result);
    expect(text).toContain('Batch done: all 3 steps ran.');
    expect(text).toContain('Page after the batch:');
    expect(text).toContain('Saved');
    // Every action is a step of its own, and the batch's result names them.
    const stepIds = (result.details?.['steps'] as Array<{ stepId: string; tool: string }>).map((step) => step.stepId);
    expect(stepIds).toHaveLength(3);
    const stored = (await store.list('steps', { limit: 50 })).items.map((step) => ({ id: step.id, tool: step.tool }));
    for (const id of stepIds) expect(stored.map((step) => step.id)).toContain(id);
    expect(stored.filter((step) => step.id.includes(':batch:')).map((step) => step.tool)).toEqual(['browser.type', 'browser.type', 'browser.click']);
  });

  it('stops at the first failing step, says which and why, and runs nothing after it', async () => {
    const store = createMemoryStore();
    await seedRun(store, 'run-fail');
    const browser = new FakeBrowser();
    browser.failNext = 'type';
    const { result } = await runBatch(await servicesFor(store, browser), 'run-fail', { steps: [click('e3'), type('e1', 'Mira'), click('e4')] });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Batch stopped after 1 of 3 steps.');
    expect(text).toContain('Step 2 (browser.type) failed');
    expect(text).toContain('stale');
    expect(text).toContain('Not run: steps 3-3.');
    expect(browser.count('click')).toBe(1);
    // The model sees where the page is now, to recover from.
    expect(text).toContain('Page after the batch:');
  });

  it('stops BEFORE a step that would need approval, asks nothing and says to call it alone', async () => {
    const store = createMemoryStore();
    await seedRun(store, 'run-approval');
    await store.put('rules', askRule('browser.click'));
    const browser = new FakeBrowser();
    const { result } = await runBatch(await servicesFor(store, browser), 'run-approval', { steps: [type('e1', 'Mira'), click('e3'), type('e2', 'never typed')] });

    const text = textOf(result);
    expect(result.isError).not.toBe(true);
    expect(text).toContain("Step 2 (browser.click) needs the user's approval");
    expect(text).toContain('Call browser.click directly now, outside computer.batch');
    expect(browser.count('click')).toBe(0);
    expect(browser.count('type')).toBe(1);
    expect((await store.list('requests', { limit: 10 })).items).toHaveLength(0);
    expect(text).toContain('Not run: steps 3-3.');
    // The stopped step never became a step row either: only the first action did.
    expect((await store.list('steps', { limit: 50 })).items.filter((step) => step.id.includes(':batch:')).map((step) => step.tool)).toEqual(['browser.type']);
  });

  it('stops before a step the agent marked confirm (a purchase), and never self-approves', async () => {
    const store = createMemoryStore();
    await seedRun(store, 'run-confirm');
    const browser = new FakeBrowser();
    const { result } = await runBatch(await servicesFor(store, browser), 'run-confirm', {
      steps: [type('e1', 'Mira'), click('e4', { confirm: 'Place the order: 1 chair, S$45' })],
    });
    expect(textOf(result)).toContain("Step 2 (browser.click) needs the user's approval");
    expect(browser.count('click')).toBe(0);
    expect((await store.list('requests', { limit: 10 })).items).toHaveLength(0);
  });

  it('a final purchase click without confirm fails the batch with the tool\'s own refusal', async () => {
    const store = createMemoryStore();
    await seedRun(store, 'run-purchase');
    const browser = new FakeBrowser();
    const services = await servicesFor(store, browser);
    // The labels the gate knows come from a snapshot the model saw.
    await services.toolRegistry.get('browser.snapshot')?.execute({}, { ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: 'run-purchase', store, blobs: services.blobs, enqueuer: services.enqueuer, wake, step: async (_n: string, fn: () => Promise<never>) => fn(), signal: new AbortController().signal });
    const { result } = await runBatch(services, 'run-purchase', { steps: [type('e1', 'Mira'), click('e4')] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Step 2 (browser.click) failed');
    expect(textOf(result)).toContain('places the order or pays');
    // The retry with confirm is made directly: inside a batch it would only stop again.
    expect(textOf(result)).toContain('not inside computer.batch');
    expect(browser.count('click')).toBe(0);
  });

  it('Return in a field of a purchase form is the final purchase click inside a batch too; Return in a search form is not', async () => {
    const store = createMemoryStore();
    await seedRun(store, 'run-enter');
    const browser = new FakeBrowser();
    const services = await servicesFor(store, browser);
    const enter: Step = { tool: 'computer.key', args: { key: 'Return' } };

    const blocked = await runBatch(services, 'run-enter', { steps: [type('e1', 'Mira'), enter] });
    expect(blocked.result.isError).toBe(true);
    expect(textOf(blocked.result)).toContain('Step 2 (computer.key) failed');
    expect(textOf(blocked.result)).toContain('submits the form with the button "Place order"');
    expect(textOf(blocked.result)).toContain('not inside computer.batch');
    expect(browser.count('key:')).toBe(0);

    // With the confirm sentence the policy asks the user, so the batch stops before the step instead of pressing it.
    const confirmed = await runBatch(services, 'run-enter', { steps: [type('e1', 'Mira'), { tool: 'computer.key', args: { key: 'Return', confirm: 'Place the order: 1 chair, S$45' } }] }, journaling());
    expect(textOf(confirmed.result)).toContain("Step 2 (computer.key) needs the user's approval");
    expect(browser.count('key:')).toBe(0);

    browser.submitName = 'Search';
    const allowed = await runBatch(services, 'run-enter', { steps: [enter] }, journaling());
    expect(allowed.result.isError).not.toBe(true);
    expect(browser.count('key:')).toBe(1);
  });

  it('refuses a step that is not a browser or screen action before running anything', async () => {
    const store = createMemoryStore();
    await seedRun(store, 'run-allowed');
    const browser = new FakeBrowser();
    const services = await servicesFor(store, browser);
    for (const tool of ['shell.run', 'files.write', 'send_message', 'computer.batch', 'browser.advance', 'tool_call', 'browser.snapshot', 'computer.act']) {
      const { result } = await runBatch(services, 'run-allowed', { steps: [type('e1', 'Mira'), { tool, args: {} }] });
      expect(result.isError, tool).toBe(true);
      expect(result.details?.['code']).toBe('step_not_allowed');
      expect(textOf(result)).toContain('Step 2: ' + tool + ' cannot run inside computer.batch');
    }
    expect(browser.log).toEqual([]);
  });

  it('rejects an empty batch and one over twelve steps', async () => {
    const store = createMemoryStore();
    await seedRun(store, 'run-size');
    const services = await servicesFor(store, new FakeBrowser());
    expect((await runBatch(services, 'run-size', { steps: [] })).result.details?.['code']).toBe('invalid_arguments');
    expect((await runBatch(services, 'run-size', { steps: Array.from({ length: 13 }, () => click('e3')) })).result.details?.['code']).toBe('invalid_arguments');
    expect((await runBatch(services, 'run-size', { steps: [click('e3')], observe: 'sometimes' })).result.details?.['code']).toBe('invalid_arguments');
  });

  it('replays from the journal without repeating an action, and resumes mid-batch where it stopped', async () => {
    const store = createMemoryStore();
    await seedRun(store, 'run-replay');
    const browser = new FakeBrowser();
    const services = await servicesFor(store, browser);
    const args = { steps: [type('e1', 'Mira'), type('e2', 'Builds chairs'), click('e3')] };
    const first = await runBatch(services, 'run-replay', args);
    expect(browser.log.filter((entry) => entry !== 'snapshot')).toEqual(['type:e1', 'type:e2', 'click:e3']);

    // The same journal again (a replay after a restart): nothing runs a second time, the answer is the same.
    const again = await runBatch(services, 'run-replay', args, journaling(first.journal));
    expect(browser.log.filter((entry) => entry !== 'snapshot')).toEqual(['type:e1', 'type:e2', 'click:e3']);
    expect(textOf(again.result)).toBe(textOf(first.result));

    // A restart in the middle: steps 2 and 3 never reached the journal. Step 1 is not repeated, the rest run once.
    const partial = new Map([...first.journal].filter(([key]) => !key.includes(':batch:2') && !key.includes(':batch:3') && !key.includes(':observe') && !key.includes(':final')));
    const resumed = await runBatch(services, 'run-replay', args, journaling(partial));
    expect(browser.log.filter((entry) => entry !== 'snapshot')).toEqual(['type:e1', 'type:e2', 'click:e3', 'type:e2', 'click:e3']);
    expect(resumed.result.isError).not.toBe(true);
  });

  it('observes the changes since the last snapshot the model saw, or nothing with observe none', async () => {
    const store = createMemoryStore();
    await seedRun(store, 'run-observe');
    const browser = new FakeBrowser();
    const services = await servicesFor(store, browser);
    const ctx = { ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: 'run-observe', store, blobs: services.blobs, enqueuer: services.enqueuer, wake, step: async (_n: string, fn: () => Promise<never>) => fn(), signal: new AbortController().signal };
    // The model's own snapshot is the baseline: the batch's observation is a diff against it, so it lists only what moved.
    const seen = await services.toolRegistry.get('browser.snapshot')?.execute({}, ctx);
    expect(textOf(seen as ToolResult)).toContain('Snapshot of tab t1');

    const withChanges = await runBatch(services, 'run-observe', { steps: [type('e1', 'Mira'), click('e3')] });
    const text = textOf(withChanges.result);
    expect(text).toContain('What changed since the last snapshot');
    expect(text).toContain('e5');
    expect(text).not.toContain('e2 [textbox]');

    const snapshotsBefore = browser.count('snapshot');
    const quiet = await runBatch(services, 'run-observe', { steps: [click('e3')], observe: 'none' }, journaling());
    expect(browser.count('snapshot')).toBe(snapshotsBefore);
    expect(textOf(quiet.result)).toContain('Batch done: all 1 steps ran.');
    expect(textOf(quiet.result)).not.toContain('Page after the batch');
  });

  it('keeps the tool hidden behind tool search unless it is loaded', async () => {
    const store = createMemoryStore();
    const registry = await createToolRegistry({ store, enqueuer: new NoopEnqueuer(), computer: () => new FakeBrowser().asClient() });
    const tool = (await registry.forAgent(AGENT)).find((candidate) => candidate.name === 'computer.batch');
    expect(tool?.deferLoading).toBe(true);
    expect(tool?.orchestrate).toBeDefined();
    // Without a computer there is no batch at all.
    const bare = await createToolRegistry({ store, enqueuer: new NoopEnqueuer() });
    expect((await bare.forAgent(AGENT)).some((candidate) => candidate.name === 'computer.batch')).toBe(false);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { createToolRegistry } from '../index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import type { Store, Tool, ToolContext } from '../../../contracts/index.js';
import { projectResult } from '../../../execution/harness/services/tool-projection.js';
import { createCompaction } from '../../../execution/brain/compaction.js';
import { sessionKey } from '../../../contracts/index.js';
import {
  BROWSER_OBSERVATION_MAX_DELTA_ITEMS,
  BROWSER_OBSERVATION_MAX_SCOPES,
  BROWSER_OBSERVATION_TTL_MS,
  clearBrowserObservationState,
  observeBrowserSnapshot,
  type BrowserObservationInput,
  type BrowserObservationScope,
  type ObservedSnapshotNode,
} from '../computer/browser-observation.js';
import { browserResultSchema, type BrowserResult, type ComputerClient } from '../computer/contract.js';

type Snap = Extract<BrowserResult, { action: 'snapshot' }>;

function snap(nodes: Snap['nodes'], overrides: Partial<Snap> = {}): Snap {
  return { action: 'snapshot', url: 'https://shop.example/', title: 'Shop', tab: 't1', nodes, crossOriginFrames: 0, ...overrides };
}

function nd(ref: string, name?: string): ObservedSnapshotNode {
  return { ref, line: '- ' + ref + ' [button] ' + (name === undefined ? ref : name) };
}

let ids = 0;
function scope(overrides: Partial<BrowserObservationScope> = {}): BrowserObservationScope {
  ids += 1;
  return { ownerId: 'owner-' + ids, agentId: 'agent-' + ids, conversationId: 'conv-' + ids, runId: 'run-' + ids, target: 'sandbox', tab: 't1', ...overrides };
}

function inputFor(sc: BrowserObservationScope, nodes: ObservedSnapshotNode[], overrides: Partial<BrowserObservationInput> = {}): BrowserObservationInput {
  return { scope: sc, url: 'https://shop.example/', title: 'Shop', crossOriginFrames: 0, blocked: false, notices: false, restarted: false, compactionEpoch: null, headings: [], textSig: '', nodes, ...overrides };
}

beforeEach(() => {
  clearBrowserObservationState();
});
describe('observeBrowserSnapshot', () => {
  it('reads the first snapshot in full and an identical one as unchanged', () => {
    const sc = scope();
    expect(observeBrowserSnapshot(inputFor(sc, [nd('e1'), nd('e2')]))).toEqual({ kind: 'full' });
    expect(observeBrowserSnapshot(inputFor(sc, [nd('e1'), nd('e2')]))).toEqual({ kind: 'unchanged' });
  });

  it('never reports a reorder of surviving refs as unchanged', () => {
    const sc = scope();
    const first = [nd('e1', 'Alpha'), nd('e2', 'Beta'), nd('e3', 'Gamma')];
    expect(observeBrowserSnapshot(inputFor(sc, first)).kind).toBe('full');
    const reordered = [nd('e3', 'Gamma'), nd('e1', 'Alpha'), nd('e2', 'Beta')];
    expect(observeBrowserSnapshot(inputFor(sc, reordered)).kind).toBe('full');
    expect(observeBrowserSnapshot(inputFor(sc, reordered)).kind).toBe('unchanged');
  });

  it('diffs added, removed and updated refs with before lines', () => {
    const sc = scope();
    expect(observeBrowserSnapshot(inputFor(sc, [nd('e1', 'Keep'), nd('e2', 'Old'), nd('e3', 'Gone')])).kind).toBe('full');
    const decision = observeBrowserSnapshot(inputFor(sc, [nd('e1', 'Keep'), nd('e2', 'New'), nd('e4', 'Added')]));
    expect(decision).toEqual({
      kind: 'delta',
      added: [nd('e4', 'Added')],
      removed: [nd('e3', 'Gone')],
      updated: [{ ref: 'e2', before: '- e2 [button] Old', after: '- e2 [button] New' }],
      headingsChanged: false,
      headings: [],
    });
  });

  it('reports changed headings', () => {
    const sc = scope();
    expect(observeBrowserSnapshot(inputFor(sc, [nd('e1')], { headings: ['## Deals'] })).kind).toBe('full');
    const decision = observeBrowserSnapshot(inputFor(sc, [nd('e1')], { headings: ['## Clearance'] }));
    expect(decision.kind).toBe('delta');
    if (decision.kind === 'delta') {
      expect(decision.headingsChanged).toBe(true);
      expect(decision.headings).toEqual(['## Clearance']);
    }
  });

  it('reads in full when the fitted prose changes, then settles', () => {
    const sc = scope();
    expect(observeBrowserSnapshot(inputFor(sc, [nd('e1')], { textSig: 'We deliver in 3 days' })).kind).toBe('full');
    expect(observeBrowserSnapshot(inputFor(sc, [nd('e1')], { textSig: 'We deliver in 5 days' })).kind).toBe('full');
    expect(observeBrowserSnapshot(inputFor(sc, [nd('e1')], { textSig: 'We deliver in 5 days' })).kind).toBe('unchanged');
  });

  it('isolates owner, run, target and tab', () => {
    const base = scope();
    expect(observeBrowserSnapshot(inputFor(base, [nd('e1')])).kind).toBe('full');
    expect(observeBrowserSnapshot(inputFor(base, [nd('e1')])).kind).toBe('unchanged');
    expect(observeBrowserSnapshot(inputFor({ ...base, ownerId: 'someone-else' }, [nd('e1')])).kind).toBe('full');
    expect(observeBrowserSnapshot(inputFor({ ...base, runId: 'another-run' }, [nd('e1')])).kind).toBe('full');
    expect(observeBrowserSnapshot(inputFor({ ...base, target: 'mac' }, [nd('e1')])).kind).toBe('full');
    expect(observeBrowserSnapshot(inputFor({ ...base, tab: 't2' }, [nd('e1')])).kind).toBe('full');
    expect(observeBrowserSnapshot(inputFor(base, [nd('e1')])).kind).toBe('unchanged');
  });

  it('forces full on request and on a stale baseline', () => {
    const sc = scope();
    expect(observeBrowserSnapshot(inputFor(sc, [nd('e1')], { now: 1000 })).kind).toBe('full');
    expect(observeBrowserSnapshot(inputFor(sc, [nd('e1')], { now: 1000, forceFull: true })).kind).toBe('full');
    expect(observeBrowserSnapshot(inputFor(sc, [nd('e1')], { now: 1000 + BROWSER_OBSERVATION_TTL_MS + 1 })).kind).toBe('full');
  });

  it('treats a rotation with no stable ref as full, not a rewrite', () => {
    const sc = scope();
    expect(observeBrowserSnapshot(inputFor(sc, [nd('e1'), nd('e2')])).kind).toBe('full');
    expect(observeBrowserSnapshot(inputFor(sc, [nd('f1'), nd('f2')])).kind).toBe('full');
  });

  it('reads in full when the change is too large', () => {
    const sc = scope();
    expect(observeBrowserSnapshot(inputFor(sc, [nd('e1')])).kind).toBe('full');
    const added = Array.from({ length: BROWSER_OBSERVATION_MAX_DELTA_ITEMS + 1 }, (_, i) => nd('n' + (i + 1)));
    expect(observeBrowserSnapshot(inputFor(sc, [nd('e1')].concat(added))).kind).toBe('full');
  });

  it('reads in full when the page identity, notices or epoch change', () => {
    const cases: Array<Partial<BrowserObservationInput>> = [
      { url: 'https://other.example/' },
      { title: 'Other' },
      { omitted: 3 },
      { crossOriginFrames: 2 },
      { blocked: true },
      { notices: true },
      { restarted: true },
      { compactionEpoch: 7 },
    ];
    for (const over of cases) {
      const sc = scope();
      expect(observeBrowserSnapshot(inputFor(sc, [nd('e1')])).kind).toBe('full');
      expect(observeBrowserSnapshot(inputFor(sc, [nd('e1')], over)).kind).toBe('full');
    }
    const steady = scope();
    expect(observeBrowserSnapshot(inputFor(steady, [nd('e1')], { compactionEpoch: 7 })).kind).toBe('full');
    expect(observeBrowserSnapshot(inputFor(steady, [nd('e1')], { compactionEpoch: 7 })).kind).toBe('unchanged');
  });

  it('reads in full for an incomplete scope and stores nothing', () => {
    const bad = { ...scope(), runId: '' };
    expect(observeBrowserSnapshot(inputFor(bad, [nd('e1')])).kind).toBe('full');
    expect(observeBrowserSnapshot(inputFor(bad, [nd('e1')])).kind).toBe('full');
  });

  it('evicts the oldest scope past the bound', () => {
    const first = scope();
    expect(observeBrowserSnapshot(inputFor(first, [nd('e1')])).kind).toBe('full');
    for (let i = 0; i < BROWSER_OBSERVATION_MAX_SCOPES + 5; i++) {
      observeBrowserSnapshot(inputFor(scope(), [nd('e1')]));
    }
    expect(observeBrowserSnapshot(inputFor(first, [nd('e1')])).kind).toBe('full');
  });
});
describe('browser observation tools', () => {
  class FakeBrowser {
    page: Snap = snap([]);
    inputs: unknown[] = [];
    async browser(_agentId: string, input: { action: string }): Promise<BrowserResult> {
      this.inputs.push(input);
      if (input.action === 'snapshot') return { ...this.page, nodes: this.page.nodes.map((node) => ({ ...node })) };
      if (input.action === 'click') {
        return { action: 'click', url: this.page.url, title: this.page.title, tab: this.page.tab, clicked: true } as BrowserResult;
      }
      if (input.action === 'type') {
        return { action: 'type', url: this.page.url, title: this.page.title, tab: this.page.tab, typed: true } as BrowserResult;
      }
      throw new Error('unsupported browser action ' + input.action);
    }
  }

  let seq = 0;
  function context(store: Store, overrides: Partial<ToolContext> = {}): ToolContext {
    seq += 1;
    const ownerId = 'owner-tools-' + seq;
    const agentId = 'agent-tools-' + seq;
    const conversationId = 'conv-tools-' + seq;
    return {
      ownerId,
      agentId,
      conversationId,
      runId: 'run-tools-' + seq,
      store,
      blobs: createMemoryBlobStore(),
      enqueuer: new NoopEnqueuer(),
      wake: {
        id: 'wake-' + seq, ownerId, agentId, conversationId, sessionKey: 's-' + seq, kind: 'user_message',
        origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: new Date().toISOString(), status: 'accepted',
      },
      step: async (_name, fn) => fn(),
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  function requireTool(registry: { get(name: string): Tool | undefined }, name: string): Tool {
    const tool = registry.get(name);
    expect(tool, name).toBeDefined();
    if (tool === undefined) throw new Error(name + ' missing');
    return tool;
  }

  async function snapshotRegistry(fake: FakeBrowser, store: Store): Promise<{ get(name: string): Tool | undefined }> {
    return createToolRegistry({ store, enqueuer: new NoopEnqueuer(), computer: () => fake as unknown as ComputerClient });
  }

  function shopNodes(count: number): Snap['nodes'] {
    return Array.from({ length: count }, (_, i) => ({ ref: 'e' + (i + 1), role: 'checkbox', name: 'Preference ' + (i + 1), state: ['unchecked'] }));
  }

  it('emits a full snapshot, then a bounded unchanged note, with canonical details', async () => {
    const fake = new FakeBrowser();
    fake.page = snap(shopNodes(60));
    const store = createMemoryStore();
    const registry = await snapshotRegistry(fake, store);
    const tool = requireTool(registry, 'browser.snapshot');
    const ctx = context(store);
    const first = JSON.stringify((await tool.execute({}, ctx)).content);
    expect(first).toContain('Preference 60');
    const second = await tool.execute({}, ctx);
    const secondText = JSON.stringify(second.content);
    expect(secondText.toLowerCase()).toContain('unchanged');
    expect(secondText.length).toBeLessThan(first.length / 2);
    expect(second.details).toMatchObject({ url: 'https://shop.example/', tab: 't1', nodeCount: 60 });
    const snapshot = browserResultSchema.parse((second.details as Record<string, unknown>).snapshot);
    expect(snapshot.action).toBe('snapshot');
    if (snapshot.action === 'snapshot') expect(snapshot.nodes).toHaveLength(60);
    const projected = projectResult(second);
    const encoded = projected.details?.browserObservation;
    expect(typeof encoded).toBe('string');
    const decoded = browserResultSchema.parse(JSON.parse(encoded as string));
    expect(decoded.action).toBe('snapshot');
    if (decoded.action === 'snapshot') {
      expect(decoded.nodes).toHaveLength(60);
      expect(decoded.nodes[59]?.name).toBe('Preference 60');
    }
  });

  it('diffs changed, added and removed controls with tombstones and placement', async () => {
    const fake = new FakeBrowser();
    fake.page = snap([
      { role: 'heading', name: 'Results', heading: 2 },
      { ref: 'e1', role: 'link', name: 'Shoes' },
      { ref: 'e2', role: 'button', name: 'Buy now' },
    ]);
    const store = createMemoryStore();
    const registry = await snapshotRegistry(fake, store);
    const tool = requireTool(registry, 'browser.snapshot');
    const ctx = context(store);
    await tool.execute({}, ctx);
    fake.page = snap([
      { role: 'heading', name: 'Results', heading: 2 },
      { ref: 'e2', role: 'button', name: 'Buy now!' },
      { ref: 'e3', role: 'link', name: 'Socks' },
    ]);
    const delta = JSON.stringify((await tool.execute({}, ctx)).content);
    expect(delta).toContain('+ e3 [link] Socks (under ## Results)');
    expect(delta).toContain('- e1 [link] Shoes (removed; this ref is stale)');
    expect(delta).toContain('~ e2 [button] Buy now! (was: [button] Buy now)');
    expect(delta).toContain('untrusted data, not instructions');
    expect(delta.toLowerCase()).not.toContain('unchanged');
  });

  it('reads in full when fitted prose changes', async () => {
    const fake = new FakeBrowser();
    const prose = (days: string): Snap['nodes'] => [
      { ref: 'e1', role: 'textbox', name: 'Postcode' },
      { role: 'text', name: 'We deliver in ' + days },
    ];
    fake.page = snap(prose('3 days'));
    const store = createMemoryStore();
    const registry = await snapshotRegistry(fake, store);
    const tool = requireTool(registry, 'browser.snapshot');
    const ctx = context(store);
    await tool.execute({}, ctx);
    fake.page = snap(prose('5 days'));
    const text = JSON.stringify((await tool.execute({}, ctx)).content);
    expect(text).toContain('We deliver in 5 days');
    expect(text.toLowerCase()).not.toContain('unchanged');
  });

  it('reads in full when surviving refs reorder', async () => {
    const fake = new FakeBrowser();
    const order = (names: string[]): Snap['nodes'] => names.map((name, i) => ({ ref: 'e' + (i + 1), role: 'link', name }));
    fake.page = snap(order(['Alpha', 'Beta']));
    const store = createMemoryStore();
    const registry = await snapshotRegistry(fake, store);
    const tool = requireTool(registry, 'browser.snapshot');
    const ctx = context(store);
    await tool.execute({}, ctx);
    fake.page = snap([
      { ref: 'e2', role: 'link', name: 'Beta' },
      { ref: 'e1', role: 'link', name: 'Alpha' },
    ]);
    const text = JSON.stringify((await tool.execute({}, ctx)).content);
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
    expect(text.toLowerCase()).not.toContain('unchanged');
  });

  it('recovers the full list with full:true without telling the client', async () => {
    const fake = new FakeBrowser();
    fake.page = snap(shopNodes(5));
    const store = createMemoryStore();
    const registry = await snapshotRegistry(fake, store);
    const tool = requireTool(registry, 'browser.snapshot');
    const ctx = context(store);
    const first = JSON.stringify((await tool.execute({}, ctx)).content);
    await tool.execute({}, ctx);
    const recovered = JSON.stringify((await tool.execute({ full: true }, ctx)).content);
    expect(recovered).toBe(first);
    for (const input of fake.inputs) {
      expect('full' in (input as Record<string, unknown>)).toBe(false);
    }
  });

  it('isolates scopes across owners and targets', async () => {
    const fake = new FakeBrowser();
    fake.page = snap(shopNodes(3));
    const store = createMemoryStore();
    const registry = await snapshotRegistry(fake, store);
    const tool = requireTool(registry, 'browser.snapshot');
    const ctx = context(store);
    await tool.execute({}, ctx);
    await tool.execute({}, ctx);
    const foreign = JSON.stringify((await tool.execute({}, context(store))).content);
    expect(foreign).toContain('Preference 3');
    const mac = JSON.stringify((await tool.execute({ on: 'mac' }, ctx)).content);
    expect(mac).toContain('Preference 3');
  });

  it('resets to full when the session compacts', async () => {
    const fake = new FakeBrowser();
    fake.page = snap(shopNodes(3));
    const store = createMemoryStore();
    const registry = await snapshotRegistry(fake, store);
    const tool = requireTool(registry, 'browser.snapshot');
    const ctx = context(store);
    await tool.execute({}, ctx);
    const quiet = JSON.stringify((await tool.execute({}, ctx)).content);
    expect(quiet.toLowerCase()).toContain('unchanged');
    await store.put('compactions', createCompaction(sessionKey(ctx.agentId, ctx.conversationId), 1, 'summary', 0));
    const after = JSON.stringify((await tool.execute({}, ctx)).content);
    expect(after).toContain('Preference 3');
    expect(after.toLowerCase()).not.toContain('unchanged');
  });

  it('remembers labels on compact observations for the purchase gate', async () => {
    const fake = new FakeBrowser();
    fake.page = snap([
      { ref: 'e1', role: 'button', name: 'Add to Bag' },
      { ref: 'e2', role: 'button', name: 'Place Order' },
    ]);
    const store = createMemoryStore();
    const registry = await snapshotRegistry(fake, store);
    const snapshot = requireTool(registry, 'browser.snapshot');
    const click = requireTool(registry, 'browser.click');
    const ctx = context(store);
    await snapshot.execute({}, ctx);
    fake.page = snap([
      { ref: 'e1', role: 'button', name: 'Add to Bag' },
      { ref: 'e2', role: 'button', name: 'Place Order' },
      { ref: 'e9', role: 'link', name: 'Socks' },
    ]);
    const delta = JSON.stringify((await snapshot.execute({}, ctx)).content);
    expect(delta).toContain('+ e9');
    const refused = await click.execute({ ref: 'e2' }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.details).toMatchObject({ code: 'purchase_needs_confirm', label: 'Place Order' });
    const done = await click.execute({ ref: 'e1', confirm: 'Add the bag: 1 item' }, ctx);
    expect(done.isError).toBeFalsy();
    const text = JSON.stringify(done.content);
    expect(text).toContain('Snapshot of tab t1');
    const followed = browserResultSchema.parse((done.details as Record<string, unknown>).snapshot);
    expect(followed.action).toBe('snapshot');
    if (followed.action === 'snapshot') expect(followed.nodes.length).toBeGreaterThan(0);
  });
});

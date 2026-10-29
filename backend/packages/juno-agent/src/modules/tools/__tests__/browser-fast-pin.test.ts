import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '../index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import type { ToolContext } from '../../../contracts/index.js';
import { projectResult } from '../../../execution/harness/services/tool-projection.js';
import { browserResultSchema } from '../computer/contract.js';
import type { ComputerClient, BrowserResult } from '../computer/contract.js';
const page: Extract<BrowserResult, { action: 'snapshot' }> = {
  action: 'snapshot', tab: 't1', url: 'https://fixture.invalid/', title: 'Fixture', crossOriginFrames: 0,
  nodes: Array.from({ length: 75 }, (_, i) => ({ ref: `e${i + 1}`, role: 'checkbox', name: `Independent preference ${i + 1}`, state: ['unchecked'] })),
};
const unsupported = async (): Promise<never> => { throw new Error('Unexpected non-browser call'); };
const computer: ComputerClient = { browser: async () => page, screenshot: unsupported, click: unsupported, type: unsupported, pressKey: unsupported, scroll: unsupported, navigate: unsupported, runShell: unsupported, readFile: unsupported, writeFile: unsupported, environment: unsupported };
function context(ownerId: string, runId: string): ToolContext {
  return { ownerId, agentId: 'fast-pin-agent', conversationId: 'fast-pin-conversation', runId,
    store: createMemoryStore(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
    wake: { id: 'wake', ownerId, agentId: 'fast-pin-agent', conversationId: 'fast-pin-conversation', sessionKey: 's', kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, status: 'accepted', at: new Date().toISOString() },
    step: async (_name, fn) => fn(), signal: new AbortController().signal };
}
describe('browser fast production pins', () => {
  it('registers the bounded browser advance entry in the production registry', async () => {
    const registry = await createToolRegistry({ store: createMemoryStore(), enqueuer: new NoopEnqueuer(), computer: () => computer });
    expect(registry.get('browser.advance')).toBeDefined();
  });
  it('retains a complete validated internal observation through canonical projection', async () => {
    const registry = await createToolRegistry({ store: createMemoryStore(), enqueuer: new NoopEnqueuer(), computer: () => computer });
    const tool = registry.get('browser.snapshot');
    if (tool === undefined) throw new Error('missing browser.snapshot');
    const projected = projectResult(await tool.execute({}, context('owner-projection-pin', 'run-projection-pin')));
    const encoded = projected.details?.browserObservation;
    expect(typeof encoded).toBe('string');
    if (typeof encoded !== 'string') throw new Error('missing canonical observation');
    const decoded = browserResultSchema.parse(JSON.parse(encoded));
    expect(decoded.action).toBe('snapshot');
    if (decoded.action !== 'snapshot') throw new Error('wrong observation');
    expect(decoded.nodes).toHaveLength(75);
    expect(decoded.nodes[74]?.name).toBe('Independent preference 75');
  });
  it('emits bounded unchanged observations only within the same owner/run', async () => {
    const registry = await createToolRegistry({ store: createMemoryStore(), enqueuer: new NoopEnqueuer(), computer: () => computer });
    const tool = registry.get('browser.snapshot');
    if (tool === undefined) throw new Error('missing browser.snapshot');
    const ctx = context('owner-fast-pin', 'run-fast-pin');
    const first = JSON.stringify((await tool.execute({}, ctx)).content);
    const second = JSON.stringify((await tool.execute({}, ctx)).content);
    expect(second.toLowerCase()).toContain('unchanged');
    expect(second.length).toBeLessThan(first.length / 2);
    const foreign = JSON.stringify((await tool.execute({}, context('another-owner', 'another-run'))).content);
    expect(foreign).toContain('Independent preference 75');
  });
});

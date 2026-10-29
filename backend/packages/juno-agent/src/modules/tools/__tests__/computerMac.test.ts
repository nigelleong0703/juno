import { describe, expect, it } from 'vitest';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { wakeEventSchema, type Store, type ToolContext } from '../../../contracts/index.js';
import { createToolRegistry, ComputerError, type ComputerClient } from '../index.js';
import type { MacDesktopAction, MacDesktopResult } from '../../../ports/computer/index.js';
import { createComputerActTool, createComputerSnapshotTool, createComputerVerifyTool } from '../tools/computerMac.js';

const wake = wakeEventSchema.parse({
  id: 'wk-1', ownerId: 'owner', agentId: 'agent-1', sessionKey: 'agent-1:conv-1', conversationId: 'conv-1',
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: new Date().toISOString(),
});

function context(store: Store): ToolContext {
  return {
    ownerId: 'owner', agentId: 'agent-1', conversationId: 'conv-1', runId: 'run-1', store, blobs: createMemoryBlobStore(),
    enqueuer: new NoopEnqueuer(), wake, step: async (_name, fn) => fn(), signal: new AbortController().signal,
  };
}

function client(answer: MacDesktopResult | Error) {
  const calls: Array<{ agentId: string; action: MacDesktopAction; input: Record<string, unknown> }> = [];
  const fake = {
    macDesktop: async (agentId: string, action: MacDesktopAction, input: Record<string, unknown>) => {
      calls.push({ agentId, action, input });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as ComputerClient;
  return { fake, calls };
}

describe('computer.snapshot / act / verify', () => {
  it('maps the three onto the Mac client with the agent id, and keeps the declared costs honest', async () => {
    const { fake, calls } = client({ ok: true, text: 'Notes — "a" (window 7)\n- [0] AXWindow' });
    const store = createMemoryStore();
    const provider = () => fake;
    const snapshot = createComputerSnapshotTool({ computer: provider });
    const act = createComputerActTool({ computer: provider });
    const verify = createComputerVerifyTool({ computer: provider });
    expect([snapshot, act, verify].map((tool) => [tool.name, tool.replay, tool.sideEffect])).toEqual([
      ['computer.snapshot', 'safe', false], ['computer.act', 'never', true], ['computer.verify', 'safe', false],
    ]);

    const read = await snapshot.execute({ app: 'Notes', query: 'Save', screenshot: true }, context(store));
    expect(read.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('AXWindow') });
    const steps = [{ tool: 'click', args: { element_token: 's1:2' } }];
    await act.execute({ app: 'Notes', steps, confirm: 'Place the order', approval: { sentence: 'x' } }, context(store));
    await verify.execute({ app: 'Notes', expect: [{ window: { exists: true } }] }, context(store));
    // The agent's own approval words are for the policy; they never reach the Mac.
    expect(calls).toEqual([
      { agentId: 'agent-1', action: 'snapshot', input: { app: 'Notes', query: 'Save', screenshot: true } },
      { agentId: 'agent-1', action: 'act', input: { app: 'Notes', steps } },
      { agentId: 'agent-1', action: 'verify', input: { app: 'Notes', expect: [{ window: { exists: true } }] } },
    ]);
  });

  it('returns the small picture, marks a failure, and tells the model what to do when the app needs the front', async () => {
    const withImage = client({ ok: true, text: 'tree', image: { mimeType: 'image/png', data: 'AAAA' } });
    const shot = await createComputerSnapshotTool({ computer: () => withImage.fake }).execute({ app: 'Notes' }, context(createMemoryStore()));
    expect(shot.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'AAAA' });

    const front = client({ ok: false, text: 'background_unavailable', needsForeground: true });
    const result = await createComputerActTool({ computer: () => front.fake }).execute({ app: 'Notes', steps: [{ tool: 'click' }] }, context(createMemoryStore()));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('call computer.act again with foreground true (the user is asked first)');
    expect(result.details).toMatchObject({ app: 'Notes', needsForeground: true });
  });

  it('passes foreground through and says plainly when the Mac connection cannot do it', async () => {
    const ok = client({ ok: true, text: 'done' });
    await createComputerActTool({ computer: () => ok.fake }).execute({ app: 'Notes', steps: [{ tool: 'click' }], foreground: true }, context(createMemoryStore()));
    expect(ok.calls[0]?.input).toMatchObject({ foreground: true });

    const none = { } as unknown as ComputerClient;
    const refused = await createComputerVerifyTool({ computer: () => none }).execute({ app: 'Notes', expect: [{}] }, context(createMemoryStore()));
    expect(refused.isError).toBe(true);
    expect(refused.details).toMatchObject({ code: 'unavailable', reason: expect.stringContaining('not available') });

    const offline = client(new ComputerError('failed', 'Your Mac was offline before the action was sent.'));
    const gone = await createComputerSnapshotTool({ computer: () => offline.fake }).execute({ app: 'Notes' }, context(createMemoryStore()));
    expect(gone).toMatchObject({ isError: true });
    expect(JSON.stringify(gone.content)).toContain('offline');
  });

  it('rejects malformed input before anything is sent', async () => {
    const { fake, calls } = client({ ok: true, text: '' });
    const act = createComputerActTool({ computer: () => fake });
    await expect(act.execute({ app: '', steps: [{ tool: 'click' }] }, context(createMemoryStore()))).rejects.toThrow();
    await expect(act.execute({ app: 'Notes', steps: [] }, context(createMemoryStore()))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('offers the three only to an agent allowed on the Mac', async () => {
    const store = createMemoryStore();
    const { fake } = client({ ok: true, text: '' });
    const registry = await createToolRegistry({ store, enqueuer: new NoopEnqueuer(), computer: () => fake });
    const names = async () => (await registry.forAgent('agent-1')).map((tool) => tool.name);
    expect(await names()).not.toContain('computer.act');
    await store.put('agents', { id: 'agent-1', macAccess: true } as never);
    expect(await names()).toEqual(expect.arrayContaining(['computer.snapshot', 'computer.act', 'computer.verify']));
  });
});

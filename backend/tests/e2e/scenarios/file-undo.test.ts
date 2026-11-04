import { describe, expect, it } from 'vitest';
import { createAccount, scriptedChat, toolCall, waitForToolActivity } from '../harness/client';

/**
 * Undo for an agent's file writes (BACKEND 5.2d) through the whole stack: the agent writes a file and edits it, the history of the path shows
 * the versions it replaced, the owner's restore (`POST /v1/files/restore`) puts the original back and keeps what it replaced, and the agent's
 * own `files.restore` brings that back in turn. The (fake) computer is the one the stack runs; the bytes of every version are in the blob store.
 */
describe('undo for file writes', () => {
  it('keeps what a write replaces, restores it for the owner and for the agent, and each restore can be undone', async () => {
    const account = await createAccount('file-undo');
    const agent = await account.api('POST', '/v1/agents', { name: 'Editor' });
    expect(agent.status).toBe(201);
    expect((await account.api('POST', '/v1/computers/ensure', { agentId: agent.body.id })).status).toBeLessThan(300);
    const path = '/workspace/plan.md';

    const first = await scriptedChat(account, agent.body.id, [
      { toolCalls: [toolCall('w1', 'files.write', { path, content: 'original plan' })] },
      { toolCalls: [toolCall('w2', 'files.write', { path, content: 'first rewrite' })] },
      { toolCalls: [toolCall('e1', 'files.edit', { path, oldText: 'first', newText: 'second' })] },
      { text: 'EDITED' },
    ], 'write the plan, then change it twice');
    const edits = await waitForToolActivity(first.sessionKey, (a) => a.results.length >= 3, 40_000);
    expect(edits.results.map((r) => [r.toolName, r.isError])).toEqual([['files.write', false], ['files.write', false], ['files.edit', false]]);

    // Creating the file kept nothing; each change after that kept the text it replaced.
    const query = `/v1/files/history?path=${encodeURIComponent(path)}&agentId=${agent.body.id}`;
    const history = await account.api('GET', query);
    expect(history.status).toBe(200);
    expect(history.body.items.map((item: { tool: string; sizeBytes: number }) => [item.tool, item.sizeBytes])).toEqual([['files.edit', 'first rewrite'.length], ['files.write', 'original plan'.length]]);
    expect(JSON.stringify(history.body)).not.toMatch(/blobKey|original plan/);
    const original = history.body.items[1];

    // The owner puts the original back; what was there (the edited text) is kept as a new version of the path.
    const restored = await account.api('POST', '/v1/files/restore', { snapshotId: original.id });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ path, on: 'sandbox', restored: { id: original.id }, undo: { tool: 'files.restore' } });
    const other = await account.api('POST', '/v1/files/restore', { snapshotId: 'fsn_not_there' });
    expect(other.status).toBe(404);

    // The agent reads the file (the original is back), then undoes the owner's restore with its own tool, and reads again.
    const second = await scriptedChat(account, agent.body.id, [
      { toolCalls: [toolCall('r1', 'files.read', { path })] },
      { toolCalls: [toolCall('u1', 'files.restore', { path })] },
      { toolCalls: [toolCall('r2', 'files.read', { path })] },
      { text: 'UNDONE' },
    ], 'what does the plan say now, and undo that restore');
    const undone = await waitForToolActivity(second.sessionKey, (a) => a.results.length >= 3, 40_000);
    expect(undone.results.map((r) => [r.toolName, r.isError])).toEqual([['files.read', false], ['files.restore', false], ['files.read', false]]);
    expect(undone.results[0]?.text).toContain('original plan');
    expect(undone.results[1]?.text).toContain('Restored /workspace/plan.md');
    expect(undone.results[2]?.text).toContain('second rewrite');

    // Both restores are in the history now, and they are the newest.
    const after = await account.api('GET', query);
    expect(after.body.items.slice(0, 2).map((item: { tool: string }) => item.tool)).toEqual(['files.restore', 'files.restore']);
  }, 120_000);
});

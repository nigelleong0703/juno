/** A new child starts with its parent's conversation as the parent's own model call sees it. */
import { describe, expect, it } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { createMemoryStore } from '../../../testing/store.js';
import { appendToTranscript, readTranscript } from '../../../execution/brain/transcript.js';
import { createCompaction } from '../../../execution/brain/compaction.js';
import { seedContinuation } from '../childRetry.js';
import type { ChildRun } from '../childRead.js';

const PARENT_KEY = 'a1:c1';
const CHILD_KEY = 'a1:c1::child:r2';
const user = (text: string): Message => ({ role: 'user', content: text, timestamp: 1 });
const call = (id: string, name: string): Message => ({
  role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: {} }], api: 'openai-completions', provider: 'openai', model: 'test', stopReason: 'toolUse', timestamp: 2,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const result = (id: string): Message => ({ role: 'toolResult', toolCallId: id, toolName: 'x', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 3 });

describe('seeding a new child from its parent', () => {
  it('skips the system row, respects the checkpoint and drops the open child_spawn call', async () => {
    const store = createMemoryStore();
    await appendToTranscript(store, PARENT_KEY, [{ role: 'system', content: 'sys', timestamp: 1 } as Message, user('old'), user('find chicken rice'), call('t1', 'web_search'), result('t1'), call('t2', 'child_spawn')]);
    const entries = await readTranscript(store, PARENT_KEY);
    const old = entries.find((e) => (e.message as { content?: unknown }).content === 'old');
    await store.put('compactions', createCompaction(PARENT_KEY, 1, 'earlier summary', old?.seq ?? 0));
    await store.put('runs', { id: 'r1', agentId: 'a1', conversationId: 'c1', status: 'running' } as ChildRun);
    await seedContinuation(store, { id: 'r2', agentId: 'a1', conversationId: 'c1', parentRunId: 'r1', childSessionKey: CHILD_KEY } as ChildRun);

    const seeded = (await readTranscript(store, CHILD_KEY)).map((e) => e.message as Message);
    expect(seeded.some((m) => m.role === 'system')).toBe(false);
    expect(JSON.stringify(seeded)).toContain('earlier summary');
    expect(JSON.stringify(seeded)).toContain('find chicken rice');
    expect(JSON.stringify(seeded)).not.toContain('"content":"old"');
    expect(JSON.stringify(seeded)).toContain('t1');
    expect(JSON.stringify(seeded)).not.toContain('t2');
  });
});

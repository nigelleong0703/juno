/**
 * Provider-sized compaction: the brain must compact against the provider's real window, persist a
 * durable summary checkpoint scoped to the session, and rebuild a reduced context from it.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store } from '../../../contracts/index.js';
import type { Message } from '@earendil-works/pi-ai';
import { createBrain } from '../index.js';
import { parseContext } from '../context.js';
import { contextPressure } from '../compaction-metrics.js';
import type { LimitsAwareProvider } from '../model-limits.js';
import { withoutNotes } from './context-text.js';

const NOW = '2026-10-06T00:00:00.000Z';
const LONG = 'history '.repeat(200);


function userMessage(text: string): Message {
  return { role: 'user', content: text, timestamp: 1 };
}

function assistantToolCall(id: string, name: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name, arguments: {} }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: 2,
  };
}

function toolResult(name: string, callId: string, text: string): Message {
  return { role: 'toolResult', toolCallId: callId, toolName: name, content: [{ type: 'text', text }], isError: false, timestamp: 3 };
}

function assistantReply(text: string, inputTokens: number): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'test',
    usage: { input: inputTokens, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: inputTokens + 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 4,
  };
}

async function seedTranscript(store: Store, sessionKey: string, messages: Message[], startSeq = 0): Promise<void> {
  let seq = startSeq;
  for (const message of messages) {
    await store.put('transcripts', {
      id: 'tx_' + sessionKey + '_' + String(seq),
      sessionKey,
      seq: seq++,
      message: { ...message },
      compactionEpoch: 0,
      at: NOW,
    });
  }
}

async function seedLongHistory(store: Store, sessionKey: string, count: number): Promise<void> {
  const messages: Message[] = [];
  for (let index = 0; index < count; index += 1) messages.push(userMessage(LONG));
  await seedTranscript(store, sessionKey, messages);
}

function limitsProvider(contextWindow: number, maxOutputTokens: number): LimitsAwareProvider {
  return {
    getLimits: async () => ({ contextWindow, maxOutputTokens }),
    call: async () => ({
      text: 'Prior discussion summarized.',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      stopReason: 'stop',
    }),
  };
}

function capturingProvider(contextWindow: number, maxOutputTokens: number): { provider: LimitsAwareProvider; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    provider: {
      getLimits: async () => ({ contextWindow, maxOutputTokens }),
      call: async callOptions => {
        prompts.push(JSON.stringify(callOptions.messages));
        return {
          text: 'Prior discussion summarized.',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          stopReason: 'stop',
        };
      },
    },
  };
}

function options(sessionKey: string) {
  return { agentId: 'agent-1', conversationId: 'conv-1', sessionKey, wake: [] };
}

describe('provider-sized compaction with durable checkpoints', () => {
  it('persists a summary for a too-large transcript and rebuilds a reduced context', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 'agent-1:conv-1', 20);
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: limitsProvider(4096, 512) });

    const before = await brain.buildContext(options('agent-1:conv-1'));
    expect(brain.shouldCompact(before)).toBe(true);

    await brain.compact(before);
    const saved = await store.list('compactions');
    expect(saved.items.length).toBe(1);
    expect(saved.items[0]?.sessionKey).toBe('agent-1:conv-1');

    const rebuilt = await brain.buildContext(options('agent-1:conv-1'));
    expect(JSON.stringify(rebuilt.messages).length).toBeLessThan(JSON.stringify(before.messages).length);
    expect(JSON.stringify(rebuilt.messages)).toContain('Prior discussion summarized.');
    expect(rebuilt.compactionEpoch).toBe(1);

    // The full transcript is retained, not deleted.
    const transcripts = await store.list('transcripts', { limit: 500 });
    expect(transcripts.items.filter(row => row.message['role'] !== 'system' && !String(row.message['content']).startsWith('<context_update>')).length).toBe(20);
  });

  it('keeps checkpoints scoped to their own session', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 'agent-1:conv-1', 20);
    await seedLongHistory(store, 'agent-1:conv-2', 20);
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: limitsProvider(4096, 512) });

    await brain.compact(await brain.buildContext(options('agent-1:conv-1')));

    const other = await brain.buildContext({ ...options('agent-1:conv-2'), conversationId: 'conv-2' });
    expect(JSON.stringify(other.messages)).not.toContain('Prior discussion summarized.');
    expect(withoutNotes(parseContext(other).messages).filter(message => message.role === 'user').length).toBe(20);
  });

  it('retains the latest complete tool group and never splits a tool pair', async () => {
    const store = createMemoryStore();
    const messages: Message[] = [];
    for (let index = 0; index < 10; index += 1) messages.push(userMessage(LONG));
    messages.push(userMessage('latest question'));
    messages.push(assistantToolCall('call-9', 'search'));
    messages.push(toolResult('search', 'call-9', 'tool output'));
    await seedTranscript(store, 'agent-1:conv-1', messages);
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: limitsProvider(4096, 512) });

    await brain.compact(await brain.buildContext(options('agent-1:conv-1')));

    const rebuilt = await brain.buildContext(options('agent-1:conv-1'));
    expect(withoutNotes(parseContext(rebuilt).messages).slice(-3).map(message => message.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(JSON.stringify(rebuilt.messages)).toContain('Prior discussion summarized.');
  });

  it('leaves history intact when the summarizer fails', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 'agent-1:conv-1', 20);
    const provider: LimitsAwareProvider = {
      getLimits: async () => ({ contextWindow: 4096, maxOutputTokens: 512 }),
      call: async () => {
        throw new Error('model down');
      },
    };
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider });

    await brain.compact(await brain.buildContext(options('agent-1:conv-1')));

    expect((await store.list('compactions')).items.length).toBe(0);
    const rebuilt = await brain.buildContext(options('agent-1:conv-1'));
    expect(withoutNotes(parseContext(rebuilt).messages).filter(message => message.role === 'user').length).toBe(20);
  });

  it('does not invent a threshold when the provider reports no context window', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 'agent-1:conv-1', 200);
    const brain = await createBrain({
      store, blobs: createMemoryBlobStore(),
      provider: {
        call: async () => ({
          text: 'unused',
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
          stopReason: 'stop',
        }),
      },
    });

    const context = await brain.buildContext(options('agent-1:conv-1'));
    expect(context.contextWindow).toBeUndefined();
    expect(contextPressure(context)).toBeUndefined();
    expect(brain.shouldCompact(context)).toBe(false);
  });

  it('computes a per-turn pressure ratio that drives eager compaction: over 1 compacts, under does not, unknown window is undefined', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 'agent-1:conv-1', 20);
    const small = await createBrain({ store, blobs: createMemoryBlobStore(), provider: limitsProvider(4096, 512) });
    const over = await small.buildContext(options('agent-1:conv-1'));
    expect(contextPressure(over)).toBeGreaterThan(1);
    expect(small.shouldCompact(over)).toBe(true);

    const roomy = await createBrain({ store, blobs: createMemoryBlobStore(), provider: limitsProvider(1_000_000, 512) });
    const under = await roomy.buildContext(options('agent-1:conv-1'));
    expect(contextPressure(under)).toBeGreaterThan(0);
    expect(contextPressure(under)).toBeLessThan(1);
    expect(roomy.shouldCompact(under)).toBe(false);
    // A large window does not let a chat grow past the fixed budget: 100k tokens on a 1M window stay, 140k compact.
    const at100k = { ...under, messages: undefined, contextTokens: 100_000 };
    expect(contextPressure(at100k)).toBeLessThan(1);
    expect(roomy.shouldCompact(at100k)).toBe(false);
    expect(roomy.shouldCompact({ ...under, messages: undefined, contextTokens: 140_000 })).toBe(true);

    expect(contextPressure({ sessionKey: 's', agentId: 'a', messages: [] })).toBeUndefined();

    // Compaction starts at 80% of the window: a context filling 85% compacts, one filling 75% does not.
    const tokens = (contextPressure(under) ?? 0) * 128_000;
    const at85 = await createBrain({ store, blobs: createMemoryBlobStore(), provider: limitsProvider(Math.round(tokens / 0.85), 512) });
    expect(at85.shouldCompact(await at85.buildContext(options('agent-1:conv-1')))).toBe(true);
    const at75 = await createBrain({ store, blobs: createMemoryBlobStore(), provider: limitsProvider(Math.round(tokens / 0.75), 512) });
    expect(at75.shouldCompact(await at75.buildContext(options('agent-1:conv-1')))).toBe(false);
  });

  it('re-compacts only past the checkpoint, keeps the boundary monotonic, and folds the prior summary once', async () => {
    const store = createMemoryStore();
    const covered: Message[] = [];
    for (let index = 0; index < 20; index += 1) {
      covered.push(userMessage('covered-' + String(index).padStart(3, '0') + ' ' + LONG));
    }
    await seedTranscript(store, 'agent-1:conv-1', covered, 0);
    const capture = capturingProvider(4096, 512);
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: capture.provider });

    await brain.compact(await brain.buildContext(options('agent-1:conv-1')));
    const firstCompactions = (await store.list('compactions', { limit: 10 })).items;
    const firstUpto = firstCompactions.find(item => item.epoch === 1)?.uptoSeq ?? -1;
    expect(firstUpto).toBeGreaterThanOrEqual(0);

    const fresh: Message[] = [];
    for (let index = 0; index < 20; index += 1) {
      fresh.push(userMessage('fresh-' + String(index).padStart(3, '0') + ' ' + LONG));
    }
    await seedTranscript(store, 'agent-1:conv-1', fresh, 20);

    await brain.compact(await brain.buildContext(options('agent-1:conv-1')));

    const all = (await store.list('compactions', { limit: 10 })).items;
    expect(all.length).toBe(2);
    expect(all.find(item => item.epoch === 2)?.uptoSeq ?? -1).toBeGreaterThan(firstUpto);

    const secondPrompt = capture.prompts.at(-1) ?? '';
    expect(secondPrompt).not.toContain('covered-000');
    expect(secondPrompt.match(/Prior discussion summarized\./g)?.length).toBe(1);
  });

  it('does not immediately re-compact from a retained assistant usage snapshot', async () => {
    const store = createMemoryStore();
    const messages: Message[] = [];
    for (let index = 0; index < 16; index += 1) messages.push(userMessage(LONG));
    messages.push(userMessage('latest question'));
    messages.push(assistantReply('short answer', 5_000_000));
    await seedTranscript(store, 'agent-1:conv-1', messages, 0);
    // The window leaves room for the fixed system prompt (~3k tokens) once the history is summarized.
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: limitsProvider(10_240, 512) });

    const before = await brain.buildContext(options('agent-1:conv-1'));
    expect(brain.shouldCompact(before)).toBe(true);
    await brain.compact(before);

    const rebuilt = await brain.buildContext(options('agent-1:conv-1'));
    // The fresh assistant turn is retained with its pre-compaction usage snapshot intact...
    expect(JSON.stringify(rebuilt.messages)).toContain('"input":5000000');
    // ...but the reduced context must not look oversized because of that stale usage.
    expect(brain.shouldCompact(rebuilt)).toBe(false);
  });
});

describe('compaction summary guards', () => {
  function badSummaryProvider(turn: { text: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; stopReason: 'stop' | 'length' | 'error' | 'aborted' | 'tool_calls' }): LimitsAwareProvider {
    return {
      getLimits: async () => ({ contextWindow: 4096, maxOutputTokens: 512 }),
      call: async () => ({ ...turn, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }),
    };
  }

  it('rejects a truncated (length) summary without advancing the checkpoint', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 'agent-1:conv-1', 20);
    const brain = await createBrain({
      store, blobs: createMemoryBlobStore(),
      provider: badSummaryProvider({ text: 'Incomplete summary', toolCalls: [], stopReason: 'length' }),
    });
    await brain.compact(await brain.buildContext(options('agent-1:conv-1')));
    expect((await store.list('compactions')).items.length).toBe(0);
    const rebuilt = await brain.buildContext(options('agent-1:conv-1'));
    expect(withoutNotes(parseContext(rebuilt).messages).filter(message => message.role === 'user').length).toBe(20);
  });

  it('rejects error/aborted/tool-call/blank summaries without advancing the checkpoint', async () => {
    const cases = [
      { text: 'Incomplete summary', toolCalls: [], stopReason: 'error' as const },
      { text: 'Incomplete summary', toolCalls: [], stopReason: 'aborted' as const },
      {
        text: 'Summary with tools',
        toolCalls: [{ id: 'c1', name: 'search', arguments: {} }],
        stopReason: 'tool_calls' as const,
      },
      { text: '   \n  ', toolCalls: [], stopReason: 'stop' as const },
    ];
    for (const turn of cases) {
      const store = createMemoryStore();
      await seedLongHistory(store, 'agent-1:conv-1', 20);
      const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: badSummaryProvider(turn) });
      await brain.compact(await brain.buildContext(options('agent-1:conv-1')));
      expect((await store.list('compactions')).items.length).toBe(0);
    }
  });

  it('lets a concurrent newer checkpoint win instead of overwriting it', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 'agent-1:conv-1', 20);
    const provider: LimitsAwareProvider = {
      getLimits: async () => ({ contextWindow: 4096, maxOutputTokens: 512 }),
      call: async () => {
        await store.put('compactions', {
          id: 'cmp_concurrent',
          sessionKey: 'agent-1:conv-1',
          epoch: 1,
          summary: 'Concurrent winner',
          uptoSeq: 9,
          createdAt: NOW,
        });
        return {
          text: 'Stale loser summary.',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          stopReason: 'stop' as const,
        };
      },
    };
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider });
    await brain.compact(await brain.buildContext(options('agent-1:conv-1')));
    const items = (await store.list('compactions', { limit: 10 })).items;
    expect(items.length).toBe(1);
    expect(items[0]?.summary).toBe('Concurrent winner');
  });

  it('rejects a summary when a selected row changes message content under the same id', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 'agent-1:conv-1', 20);
    let started = () => {};
    let release = () => {};
    const summaryStarted = new Promise<void>(resolve => { started = resolve; });
    const summaryReleased = new Promise<void>(resolve => { release = resolve; });
    const provider: LimitsAwareProvider = {
      getLimits: async () => ({ contextWindow: 4096, maxOutputTokens: 512 }),
      call: async () => {
        started();
        await summaryReleased;
        return {
          text: 'Summary of the original messages.',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          stopReason: 'stop',
        };
      },
    };
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider });
    const before = await brain.buildContext(options('agent-1:conv-1'));
    const compacting = brain.compact(before);
    await summaryStarted;
    try {
      await store.patch('transcripts', 'tx_agent-1:conv-1_0', {
        message: { ...userMessage('Corrected message while the summary was pending') },
      });
    } finally {
      release();
    }
    await compacting;
    expect((await store.list('compactions')).items).toEqual([]);
    const rebuilt = await brain.buildContext(options('agent-1:conv-1'));
    expect(JSON.stringify(rebuilt.messages)).toContain('Corrected message while the summary was pending');
    expect(withoutNotes(parseContext(rebuilt).messages).filter(message => message.role === 'user')).toHaveLength(20);
  });

  it('preserves transcript rows appended during summarization in the projected context', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 'agent-1:conv-1', 20);
    const provider: LimitsAwareProvider = {
      getLimits: async () => ({ contextWindow: 4096, maxOutputTokens: 512 }),
      call: async () => {
        await store.put('transcripts', {
          id: 'tx_agent-1:conv-1_20',
          sessionKey: 'agent-1:conv-1',
          seq: 20,
          message: { ...userMessage('late tool result arrives during summary') },
          compactionEpoch: 0,
          at: NOW,
        });
        return {
          text: 'Prior discussion summarized.',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
          stopReason: 'stop' as const,
        };
      },
    };
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider });
    const projected = await brain.compact(await brain.buildContext(options('agent-1:conv-1')));
    expect(JSON.stringify(projected.messages)).toContain('late tool result arrives during summary');
    expect((await store.list('compactions')).items.length).toBe(1);
    const rebuilt = await brain.buildContext(options('agent-1:conv-1'));
    expect(JSON.stringify(rebuilt.messages)).toContain('late tool result arrives during summary');
  });
});

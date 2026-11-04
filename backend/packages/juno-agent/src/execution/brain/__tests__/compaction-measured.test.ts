/**
 * Measured-usage compaction regression: content estimates undercount real
 * provider input (images counted as ~1200 tokens, trims shrink the estimate),
 * so a 192k measured prefix must still compact even when chars/4 says <128k.
 * Rewrite boundaries carry stable timestamps (trim stubs stamped with their
 * checkpoint creation, pruned rows with the trigger screenshot, summary with
 * its checkpoint creation), so the SDK timestamp guard accepts a measurement
 * taken after the boundary and drops one taken before it.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store } from '../../../contracts/index.js';
import type { Message } from '@earendil-works/pi-ai';
import { createBrain } from '../index.js';
import { parseContext } from '../context.js';
import { contextPressure } from '../compaction-metrics.js';
import type { LimitsAwareProvider } from '../model-limits.js';

const T_PAST = Date.parse('2026-10-01T00:00:00.000Z');
const T_MID = Date.parse('2026-10-02T00:00:00.000Z');
const SESSION = 'agent-1:conv-1';

function systemMessage(): Message {
  return { role: 'system', content: 'rules', timestamp: T_MID };
}

function userMessage(text: string, timestamp: number): Message {
  return { role: 'user', content: text, timestamp };
}

function assistantWithUsage(inputTokens: number, timestamp: number): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ack' }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'test',
    usage: {
      input: inputTokens, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: inputTokens + 5,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
  };
}

function toolImage(callId: string, timestamp: number): Message {
  return {
    role: 'toolResult', toolCallId: callId, toolName: 'computer.screenshot',
    content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
    isError: false, timestamp,
  };
}

function toolText(callId: string, text: string, timestamp: number): Message {
  return {
    role: 'toolResult', toolCallId: callId, toolName: 'web_fetch',
    content: [{ type: 'text', text }], isError: false, timestamp,
  };
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

function ctxOptions(sessionKey: string) {
  return { agentId: 'agent-1', conversationId: 'conv-1', sessionKey, wake: [] };
}

async function appendMessages(store: Store, sessionKey: string, messages: Message[], at: string): Promise<void> {
  const existing = await store.list('transcripts', { where: { kind: sessionKey }, limit: 500 });
  let seq = existing.items.filter((item) => item.sessionKey === sessionKey).length;
  for (const message of messages) {
    await store.put('transcripts', {
      id: 'tx_' + sessionKey + '_' + String(seq) + '_' + String(message.timestamp),
      sessionKey,
      seq: seq++,
      message: { ...message },
      compactionEpoch: 0,
      at,
    });
  }
}

describe('measured-usage compaction trigger', () => {
  it('compacts when measured input exceeds 128k even though the content estimate is small', () => {
    const messages: Message[] = [
      systemMessage(),
      userMessage('hello', T_MID),
      userMessage('look at these screenshots', T_MID + 1),
      assistantWithUsage(192_149, T_MID + 2),
    ];
    const pressure = contextPressure({
      sessionKey: SESSION,
      agentId: 'agent-1',
      messages,
      contextWindow: 200_000,
      maxOutputTokens: 4096,
    });
    expect(pressure).toBeDefined();
    const value = pressure === undefined ? 0 : pressure;
    expect(value).toBeGreaterThan(1);
  });

  it('ignores measured usage from a different model', () => {
    const messages: Message[] = [
      systemMessage(),
      userMessage('hello', T_MID),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ack' }],
        api: 'openai-completions',
        provider: 'openai',
        model: 'other-model',
        usage: {
          input: 192_149, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 192_154,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: T_MID + 2,
      },
    ];
    const pressure = contextPressure({
      sessionKey: SESSION,
      agentId: 'agent-1',
      messages,
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      modelSelection: { modelId: 'frozen-model', baseUrl: 'http://provider.test/v1', supportsImages: true },
    });
    expect(pressure).toBeDefined();
    const value = pressure === undefined ? 0 : pressure;
    expect(value).toBeLessThan(1);
  });
});

describe('production wiring: stable rewrite boundaries', () => {
  it('(a) old trim stubs and pruned screenshots before the measurement do not suppress a valid recent 192k', async () => {
    const base = Date.now();
    const store = createMemoryStore();
    const oldAt = new Date(base - 100_000).toISOString();
    const images: Message[] = [];
    for (let index = 0; index < 11; index += 1) {
      images.push(toolImage('shot-' + String(index), base - 90_000 + index));
    }
    await appendMessages(store, SESSION, [
      userMessage('look at these', base - 95_000),
      ...images,
      toolText('big-1', 'x'.repeat(9000), base - 80_000),
      userMessage('what do you see?', base - 79_000),
    ], oldAt);
    await store.put('compactions', {
      id: 'cmp_trim3',
      sessionKey: SESSION,
      epoch: 3,
      uptoSeq: -1,
      trims: [{ seq: 12, stub: '[Earlier result trimmed to keep this conversation fast: web_fetch (9000 characters); only its start is kept.]' }],
      createdAt: new Date(base - 50_000).toISOString(),
    });
    const brain = await createBrain({
      store, blobs: createMemoryBlobStore(), provider: limitsProvider(200_000, 4096),
    });
    await brain.buildContext(ctxOptions(SESSION));
    const tRecent = Date.now() + 10_000;
    await appendMessages(store, SESSION, [
      userMessage('follow up', tRecent - 2),
      assistantWithUsage(192_149, tRecent - 1),
      userMessage('and then?', tRecent),
    ], new Date(tRecent).toISOString());
    const built = await brain.buildContext(ctxOptions(SESSION));
    expect(brain.shouldCompact(built)).toBe(true);
  });

  it('(b) a NEW trim after the measurement invalidates the old usage', async () => {
    const base = Date.now();
    const store = createMemoryStore();
    await appendMessages(store, SESSION, [
      userMessage('fetch this', base),
      toolText('big-1', 'y'.repeat(9000), base + 1),
      assistantWithUsage(192_149, base + 1000),
      userMessage('ok', base + 1001),
    ], new Date(base).toISOString());
    await store.put('compactions', {
      id: 'cmp_trim_new',
      sessionKey: SESSION,
      epoch: 1,
      uptoSeq: -1,
      trims: [{ seq: 1, stub: '[Earlier result trimmed to keep this conversation fast: web_fetch (9000 characters); only its start is kept.]' }],
      createdAt: new Date(base + 2000).toISOString(),
    });
    const brain = await createBrain({
      store, blobs: createMemoryBlobStore(), provider: limitsProvider(200_000, 4096),
    });
    const built = await brain.buildContext(ctxOptions(SESSION));
    expect(brain.shouldCompact(built)).toBe(false);
  });

  it('(c) a valid assistant after a SUMMARY is used once its timestamp passes the stable summary', async () => {
    const store = createMemoryStore();
    const seed: Message[] = [];
    for (let index = 0; index < 12; index += 1) {
      seed.push(userMessage('history line ' + String(index) + ' ' + 'x'.repeat(800), T_MID + index));
    }
    await appendMessages(store, SESSION, seed, new Date(T_MID).toISOString());
    const brain = await createBrain({
      store, blobs: createMemoryBlobStore(), provider: limitsProvider(4096, 512),
    });
    const before = await brain.buildContext(ctxOptions(SESSION));
    expect(brain.shouldCompact(before)).toBe(true);
    await brain.compact(before);
    const checkpoints = await store.list('compactions', { limit: 10 });
    const created = checkpoints.items.find((item) => item.epoch === 1);
    expect(created).toBeDefined();
    const boundary = created === undefined ? T_PAST : Date.parse(created.createdAt);
    await appendMessages(store, SESSION, [
      { ...assistantWithUsage(60_000, boundary + 1000) },
    ], new Date(boundary + 1000).toISOString());
    const rebuilt = await brain.buildContext(ctxOptions(SESSION));
    const summaryStamps = parseContext(rebuilt).messages
      .filter((message) => message.role === 'user')
      .map((message) => message.timestamp)
      .filter((timestamp) => timestamp === boundary);
    expect(summaryStamps.length).toBeGreaterThan(0);
    const pressure = contextPressure(rebuilt);
    expect(pressure).toBeDefined();
    const value = pressure === undefined ? 0 : pressure;
    expect(value).toBeGreaterThan(1);
  });
});

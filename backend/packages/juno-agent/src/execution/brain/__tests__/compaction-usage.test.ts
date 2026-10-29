import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMemoryStore } from '../../../testing/store.js';
import type { BrainContext, Store } from '../../../contracts/index.js';
import type { Message } from '@earendil-works/pi-ai';
import { createBrain } from '../index.js';
import type { LimitsAwareProvider } from '../model-limits.js';
import type { ModelSnapshot } from '../model-selection.js';

const NOW = '2026-10-06T00:00:00.000Z';
const LONG = 'history '.repeat(200);
const SESSION = 'agent-1:conv-1';
const REPORTED = { inputTokens: 7, outputTokens: 3, costUsd: 0 };
const STALE = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
const SNAPSHOT: ModelSnapshot = { modelId: 'frozen-model', baseUrl: 'http://provider.test/v1', supportsImages: false };
const metricsSchema = z.object({ durationMs: z.number(), usage: z.unknown().optional() }).passthrough();
function metricsOf(ctx: BrainContext) {
  return metricsSchema.safeParse(ctx['compactionMetrics']);
}
function userMessage(text: string): Message {
  return { role: 'user', content: text, timestamp: 1 };
}
async function seedLongHistory(store: Store, count: number, startSeq = 0): Promise<void> {
  for (let seq = startSeq; seq < startSeq + count; seq += 1) {
    await store.put('transcripts', {
      id: 'tx_' + SESSION + '_' + String(seq),
      sessionKey: SESSION,
      seq,
      message: { ...userMessage(LONG) },
      compactionEpoch: 0,
      at: NOW,
    });
  }
}
function options() {
  return { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: SESSION, wake: [] };
}
interface Seen { frozen: number; bootstrap: number; }
async function makeBrain(store: Store, summary: LimitsAwareProvider, seen: Seen) {
  const frozen: LimitsAwareProvider = {
    getLimits: async () => ({ contextWindow: 4096, maxOutputTokens: 512 }),
    call: async callOptions => {
      seen.frozen += 1;
      return summary.call(callOptions);
    },
  };
  const bootstrap: LimitsAwareProvider = {
    getLimits: async () => ({ contextWindow: 4096, maxOutputTokens: 512 }),
    call: async () => {
      seen.bootstrap += 1;
      return { text: 'bootstrap never summarizes', toolCalls: [], usage: STALE, stopReason: 'stop' };
    },
  };
  const selection = { resolve: async () => SNAPSHOT, providerFor: () => frozen };
  return createBrain({ store, blobs: createMemoryBlobStore(), provider: bootstrap, modelSelection: selection });
}
function summaryProvider(text: string, stopReason: 'stop' | 'length', pauseMs = 0): LimitsAwareProvider {
  return {
    call: async () => {
      if (pauseMs > 0) await new Promise<void>(resolve => { setTimeout(resolve, pauseMs); });
      return { text, toolCalls: [], usage: REPORTED, stopReason };
    },
  };
}
describe('compaction usage producer', () => {
  it('forwards reported usage on success and keeps history plus the frozen model', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 20);
    const seen: Seen = { frozen: 0, bootstrap: 0 };
    const brain = await makeBrain(store, summaryProvider('Handoff summary.', 'stop', 20), seen);
    const before = await brain.buildContext(options());
    const after = await brain.compact({ ...before, compactionMetrics: { durationMs: 1, usage: STALE } });
    const parsed = metricsOf(after);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.usage).toEqual(REPORTED);
      expect(parsed.data.durationMs).toBeGreaterThanOrEqual(10);
    }
    expect(seen).toEqual({ frozen: 1, bootstrap: 0 });
    expect(after['modelSelection']).toEqual(SNAPSHOT);
    const saved = await store.list('compactions');
    expect(saved.items.length).toBe(1);
    expect(saved.items[0]?.summary).toBe('Handoff summary.');
    expect(JSON.stringify(after.messages)).toContain('Handoff summary.');
    const rebuilt = await brain.buildContext(options());
    expect(JSON.stringify(rebuilt.messages)).toContain('Handoff summary.');
    expect((await store.list('transcripts', { limit: 500 })).items.filter(row => row.message['role'] !== 'system' && !String(row.message['content']).startsWith('<context_update>')).length).toBe(20);
  });
  it('forwards usage for a truncated summary and writes no checkpoint', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 20);
    const seen: Seen = { frozen: 0, bootstrap: 0 };
    const brain = await makeBrain(store, summaryProvider('Cut off mid-sentence', 'length'), seen);
    const before = await brain.buildContext(options());
    const after = await brain.compact({ ...before, compactionMetrics: { durationMs: 1, usage: STALE } });
    const parsed = metricsOf(after);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.usage).toEqual(REPORTED);
      expect(parsed.data.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(seen).toEqual({ frozen: 1, bootstrap: 0 });
    expect((await store.list('compactions')).items.length).toBe(0);
  });
  it('forwards usage when a concurrent checkpoint wins and keeps the winner', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 20);
    const seen: Seen = { frozen: 0, bootstrap: 0 };
    const racer: LimitsAwareProvider = {
      call: async () => {
        await store.put('compactions', {
          id: 'cmp_concurrent', sessionKey: SESSION, epoch: 1,
          summary: 'Concurrent winner', uptoSeq: 9, createdAt: NOW,
        });
        return { text: 'Stale loser summary.', toolCalls: [], usage: REPORTED, stopReason: 'stop' };
      },
    };
    const brain = await makeBrain(store, racer, seen);
    const after = await brain.compact(await brain.buildContext(options()));
    const parsed = metricsOf(after);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.usage).toEqual(REPORTED);
    const saved = await store.list('compactions', { limit: 10 });
    expect(saved.items.length).toBe(1);
    expect(saved.items[0]?.summary).toBe('Concurrent winner');
  });
  it('forwards usage when the selected prefix changes and writes no checkpoint', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 20);
    const seen: Seen = { frozen: 0, bootstrap: 0 };
    const drifter: LimitsAwareProvider = {
      call: async () => {
        await store.patch('transcripts', 'tx_' + SESSION + '_0', {
          message: { ...userMessage('Corrected while the summary was pending') },
        });
        return { text: 'Summary of the original rows.', toolCalls: [], usage: REPORTED, stopReason: 'stop' };
      },
    };
    const brain = await makeBrain(store, drifter, seen);
    const after = await brain.compact(await brain.buildContext(options()));
    const parsed = metricsOf(after);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.usage).toEqual(REPORTED);
    expect((await store.list('compactions')).items.length).toBe(0);
  });
  it('drops a previous measurement on a true no-op without calling the provider', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 1);
    const seen: Seen = { frozen: 0, bootstrap: 0 };
    const brain = await makeBrain(store, summaryProvider('Never used.', 'stop'), seen);
    const before = await brain.buildContext(options());
    const after = await brain.compact({ ...before, compactionMetrics: { durationMs: 5, usage: STALE } });
    expect(after['compactionMetrics']).toBeUndefined();
    expect(seen).toEqual({ frozen: 0, bootstrap: 0 });
    expect((await store.list('compactions')).items.length).toBe(0);
  });
  it('charges only the failed attempt instead of repeating a previous measurement', async () => {
    const store = createMemoryStore();
    await seedLongHistory(store, 20);
    const seen: Seen = { frozen: 0, bootstrap: 0 };
    const failing: LimitsAwareProvider = {
      call: async () => { throw new Error('model down'); },
    };
    const brain = await makeBrain(store, failing, seen);
    const before = await brain.buildContext(options());
    const after = await brain.compact({ ...before, compactionMetrics: { durationMs: 5, usage: STALE } });
    const parsed = metricsOf(after);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.usage).toBeUndefined();
      expect(parsed.data.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(seen).toEqual({ frozen: 1, bootstrap: 0 });
    expect((await store.list('compactions')).items.length).toBe(0);
  });
  it('compacts a quiet chat in the background only above 128k tokens, asking for the topics index', async () => {
    const store = createMemoryStore();
    const requests: string[] = [];
    const provider: LimitsAwareProvider = {
      getLimits: async () => ({ contextWindow: 1_000_000, maxOutputTokens: 4096 }),
      call: async callOptions => {
        requests.push(JSON.stringify(callOptions.messages));
        return { text: 'Idle summary.', toolCalls: [], usage: REPORTED, stopReason: 'stop' };
      },
    };
    const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider, modelSelection: { resolve: async () => SNAPSHOT, providerFor: () => provider } });
    const input = { agentId: 'agent-1', conversationId: 'conv-1', sessionKey: SESSION };
    await seedLongHistory(store, 20);
    await brain.compactIdle?.(input);
    expect(requests).toEqual([]);
    expect((await store.list('compactions')).items).toEqual([]);
    // Above 32k but below 128k: still nothing.
    await seedLongHistory(store, 100, 20);
    await brain.compactIdle?.(input);
    expect(requests).toEqual([]);
    await seedLongHistory(store, 300, 120);
    await brain.compactIdle?.(input);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('Topics by date');
    const saved = await store.list('compactions');
    expect(saved.items.map(item => item.summary)).toEqual(['Idle summary.']);
  });
});

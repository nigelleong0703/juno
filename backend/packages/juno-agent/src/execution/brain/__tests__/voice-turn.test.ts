// Voice is a conversation channel, not a different prompt: a spoken turn says how to answer in its own run-start note, and the
// system row, the tool list and every earlier message stay byte-identical (the provider's cache prefix). The warm-up call sends that
// same prefix and writes nothing.
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import type { Tool, WakeEvent } from '../../../contracts/index.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { VOICE_TURN_HINT } from '../../voice-channel.js';
import { assistantMessage } from '../messages.js';
import { ModelTurnError } from '../model-turn-error.js';
import { createBrain, type ModelProvider } from '../index.js';
import { findSystemEntry } from '../context-notes.js';
import { readTranscript } from '../transcript.js';
import { orderTools } from '../tool-order.js';
import { AGENT, seed, wakeFor } from './agent-resources.fixtures.js';

const KEY = AGENT + ':conv-1';
const base = { agentId: AGENT, conversationId: 'conv-1', sessionKey: KEY };
const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
const tool = (name: string): Tool => ({ name, description: name + ' tool', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [] }) }) as unknown as Tool;
const wire = (messages: Message[]): string[] => messages.map((message) => JSON.stringify({ ...message, timestamp: 0 }));
const voiceWake = (extra: Record<string, unknown>): WakeEvent => ({ ...wakeFor(AGENT), payload: { text: 'hi', ...extra } });

async function brainOver(store: Awaited<ReturnType<typeof seed>>) {
  const call = vi.fn<ModelProvider['call']>().mockResolvedValue({ text: 'ok', toolCalls: [], usage, stopReason: 'stop' });
  const brain = await createBrain({ store, blobs: createMemoryBlobStore(), provider: { call } });
  return { brain, call };
}

describe('the voice turn hint', () => {
  it('rides the run-start note of an explicit voice wake only, and leaves the system row, tools order and earlier messages untouched', async () => {
    const store = await seed();
    const { brain } = await brainOver(store);
    const text = await brain.buildContext({ ...base, wake: [wakeFor(AGENT)], toolNames: ['a', 'b'] });
    const systemBefore = findSystemEntry(await readTranscript(store, KEY));
    const { appendToTranscript } = await import('../transcript.js');
    await appendToTranscript(store, KEY, [assistantMessage({ text: 'ok', toolCalls: [], usage, stopReason: 'stop' })], 'turn-0');
    const spoken = await brain.buildContext({ ...base, wake: [voiceWake({ channel: 'voice' })], toolNames: ['a', 'b'] });
    const systemAfter = findSystemEntry(await readTranscript(store, KEY));

    expect(systemAfter).toEqual(systemBefore);
    expect(spoken.systemPrompt).toBe(text.systemPrompt);
    expect(spoken.toolOrder).toEqual(text.toolOrder);
    // Everything the text turn sent is still the front of the voice turn's request.
    const textMessages = text.messages as Message[];
    const spokenMessages = spoken.messages as Message[];
    expect(wire(spokenMessages).slice(0, textMessages.length)).toEqual(wire(textMessages));
    expect(JSON.stringify(textMessages)).not.toContain(VOICE_TURN_HINT);
    expect(JSON.stringify(spokenMessages.at(-1))).toContain(VOICE_TURN_HINT);
  });

  it('is not added by a voice- id prefix alone (only the explicit channel makes a voice turn)', async () => {
    const store = await seed();
    const { brain } = await brainOver(store);
    const ctx = await brain.buildContext({ ...base, wake: [voiceWake({ itemId: 'voice-abc' })] });
    expect(JSON.stringify(ctx.messages)).not.toContain(VOICE_TURN_HINT);
  });
});

describe('warming the prompt cache', () => {
  it('sends the prefix the next run will send (same system row, tool order, history, cache key), tiny output, and writes nothing', async () => {
    const store = await seed();
    const { brain, call } = await brainOver(store);
    const tools = [tool('b'), tool('a')];
    const first = await brain.buildContext({ ...base, wake: [wakeFor(AGENT)], toolNames: ['a', 'b'] });
    await brain.step(first, tools, { signal: new AbortController().signal });
    const { appendToTranscript } = await import('../transcript.js');
    await appendToTranscript(store, KEY, [assistantMessage({ text: 'ok', toolCalls: [], usage, stopReason: 'stop' })], 'turn-0');
    const rowsBefore = (await readTranscript(store, KEY)).length;
    call.mockClear();

    expect(await brain.warmPrefix?.({ agentId: AGENT, sessionKey: KEY, tools, signal: new AbortController().signal })).toBe('warmed');
    expect(await readTranscript(store, KEY)).toHaveLength(rowsBefore);
    const warmed = call.mock.calls[0]?.[0];

    // The next real run builds its context and calls the model.
    const next = await brain.buildContext({ ...base, wake: [voiceWake({ channel: 'voice' })], toolNames: ['a', 'b'] });
    call.mockClear();
    // The harness orders the tools by the session's stored order before every model call.
    await brain.step(next, orderTools(tools, next.toolOrder as string[]), { signal: new AbortController().signal });
    const real = call.mock.calls[0]?.[0];

    expect(warmed?.maxOutputTokens).toBeLessThanOrEqual(32);
    expect(warmed?.sessionKey).toBe(real?.sessionKey);
    expect(warmed?.tools.map((t) => t.name)).toEqual(real?.tools.map((t) => t.name));
    const sentByWarm = wire(warmed?.messages ?? []);
    expect(wire(real?.messages ?? []).slice(0, sentByWarm.length - 1)).toEqual(sentByWarm.slice(0, -1));
  });

  it('counts a reply the model never produced (output budget spent on reasoning) as warmed, and still fails a real provider error', async () => {
    const store = await seed();
    const { brain, call } = await brainOver(store);
    await brain.buildContext({ ...base, wake: [wakeFor(AGENT)] });
    const run = () => brain.warmPrefix?.({ agentId: AGENT, sessionKey: KEY, tools: [], signal: new AbortController().signal });
    call.mockRejectedValueOnce(new ModelTurnError('output_budget', 'Model exhausted its output budget without a reply or tool action. Please retry.'));
    expect(await run()).toBe('warmed');
    call.mockRejectedValueOnce(new ModelTurnError('auth', 'bad key'));
    await expect(run()).rejects.toThrow('bad key');
  });

  it('says cold, without a model call, for a session that has no stored system row yet', async () => {
    const store = await seed();
    const { brain, call } = await brainOver(store);
    expect(await brain.warmPrefix?.({ agentId: AGENT, sessionKey: KEY, tools: [], signal: new AbortController().signal })).toBe('cold');
    expect(call).not.toHaveBeenCalled();
  });
});

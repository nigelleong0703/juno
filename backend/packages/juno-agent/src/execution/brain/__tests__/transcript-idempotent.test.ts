import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { appendToTranscript, toolMessage } from '../index.js';
import { readTranscript } from '../transcript.js';

const sessionKey = 'agent-1:conv-1';

describe('appendToTranscript with a key', () => {
  it('a replayed journaled write appends the tool result once', async () => {
    const store = createMemoryStore();
    const message = toolMessage('shell', 'call-1', { content: [{ type: 'text', text: 'ok' }] });
    await appendToTranscript(store, sessionKey, [message], 'step-1');
    await appendToTranscript(store, sessionKey, [message], 'step-1');
    await appendToTranscript(store, sessionKey, [message], 'step-2');
    const entries = await readTranscript(store, sessionKey);
    expect(entries.map((entry) => entry.seq)).toEqual([0, 1]);
  });
});

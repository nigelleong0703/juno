/**
 * A wake written into a pinned session reads the version its frozen system row names (BACKEND §11.2), not the active one.
 */
import { describe, expect, it } from 'vitest';
import type { WakeEvent } from '../../../contracts/index.js';
import { createBrain } from '../../../execution/brain/index.js';
import { systemMessage } from '../../../execution/brain/context-notes.js';
import { appendWakeEvents, readTranscript } from '../../../execution/brain/transcript.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore } from '../../../testing/store.js';
import { compileHarnessVersion, harnessSeedVersion } from '../loader.js';
import { HarnessPins, type HarnessVersionStore } from '../store.js';

const timer = (id: string): WakeEvent => ({
  id, agentId: 'agent', conversationId: 'conversation', sessionKey: 'session', ownerId: 'owner', kind: 'timer',
  origin: { type: 'system' }, trusted: true, priority: 'background', payload: { text: 'stretch' }, at: '2026-10-26T00:00:00.000Z', status: 'accepted',
});

describe('wake text pinning', () => {
  it('the wake of a pinned session is the pinned version\'s text, and a session with no frozen row reads the active one', async () => {
    const files: Record<string, string> = { ...harnessSeedVersion().files };
    files['wake.timer'] = (files['wake.timer'] ?? '').replace('[scheduled wake-up you set earlier]', '[altered timer]');
    const altered = compileHarnessVersion(files);
    const versions: HarnessVersionStore = {
      async row(id) { return id === altered.id ? { id, parentId: null, files: { ...altered.files }, origin: 'seed', status: 'retired', note: '', createdAt: '2026-10-26T00:00:00.000Z' } : undefined; },
      async active() { return undefined; },
      async seedActive() { throw new Error('not used'); },
    };
    const store = createMemoryStore();
    const blobs = createMemoryBlobStore();
    const brain = await createBrain({ store, blobs, harness: new HarnessPins(versions) });

    await appendWakeEvents(store, blobs, 'fresh', [timer('w0')], undefined, brain);
    await store.put('transcripts', { id: 'tx_sys', sessionKey: 'session', seq: 0, message: { ...systemMessage('rules', 'p', undefined, undefined, undefined, altered.id) }, compactionEpoch: 0, at: '2026-10-26T00:00:00.000Z' });
    await appendWakeEvents(store, blobs, 'session', [timer('w1')], undefined, brain);

    const text = async (sessionKey: string): Promise<string> => String((await readTranscript(store, sessionKey)).at(-1)?.message['content']);
    expect(await text('session')).toMatch(/^\[altered timer\] stretch\n/);
    expect(await text('fresh')).toMatch(/^\[scheduled wake-up you set earlier\] stretch\n/);
  });
});

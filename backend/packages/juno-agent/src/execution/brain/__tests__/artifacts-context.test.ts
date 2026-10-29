// Every artifact published in the chat reaches the model as an append-only context note, and a new version
// appends one more note; earlier messages stay byte-identical and a compaction-free rebuild adds nothing.
import { describe, expect, it } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import type { LibraryDocument } from '../../../contracts/index.js';
import { buildContext } from '../context.js';
import { AGENT, seed, wakeFor } from './agent-resources.fixtures.js';

const KEY = AGENT + ':conv-1';
const base = { agentId: AGENT, conversationId: 'conv-1', sessionKey: KEY, wake: [wakeFor(AGENT)] };

function row(version: number): LibraryDocument {
  return {
    id: 'lib_kl', name: 'KL long weekend for 2', kind: 'canvas', mimeType: 'text/html', sizeBytes: 10, shared: 'private', source: 'agent',
    tags: [], createdAt: '2026-10-18T01:00:00.000Z', updatedAt: '2026-10-18T01:0' + String(version) + ':00.000Z', pinned: false, render: 'html', version,
    versions: [], createdByAgentId: AGENT, conversationId: 'conv-1', sourcePath: '/workspace/kl-weekend-plan.html',
  };
}

const notes = (messages: Message[]) => messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<context_update>')).map((m) => String(m.content));

describe('published artifacts in the context', () => {
  it('names title, artifactId, file and version, and appends a note when a version is added', async () => {
    const store = await seed();
    await store.put('library', row(1), { conversationId: 'conv-1' });
    const first = await buildContext(store, { ...base, noteKey: 'ctx0:r1' });
    const text = notes(first.messages).join('\n');
    expect(text).toContain('"KL long weekend for 2" (artifactId lib_kl, /workspace/kl-weekend-plan.html, v1)');

    await store.put('library', row(2), { conversationId: 'conv-1' });
    const second = await buildContext(store, { ...base, previousContext: first, noteKey: 'ctxN:r1:1' });
    const added = notes(second.messages).slice(notes(first.messages).length);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain('artifactId lib_kl, /workspace/kl-weekend-plan.html, v2');
    expect(JSON.stringify(second.messages.slice(0, first.messages.length).map((m) => ({ ...m, timestamp: 0 })))).toBe(JSON.stringify(first.messages.map((m) => ({ ...m, timestamp: 0 }))));

    const third = await buildContext(store, { ...base, previousContext: second, noteKey: 'ctxN:r1:2' });
    expect(notes(third.messages)).toHaveLength(notes(second.messages).length);
  });
});

// Past the memory section's limit (BACKEND §5.3, batch 5a), the items that match a run's first message come in that run's note, once per
// session: the note records their ids in its meta, and the next run does not repeat them.
import { describe, expect, it } from 'vitest';
import type { WakeEvent } from '../../../contracts/index.js';
import { portOf, startMemoryGraph } from '../../../modules/memory/__tests__/memory-graph-fixture.js';
import { buildContext } from '../context.js';
import { metaOf } from '../context-notes.js';
import { readTranscript } from '../transcript.js';
import { AGENT, conversationDoc, seed, wakeFor } from './agent-resources.fixtures.js';

const OWNER = 'owner-1';
const CONVERSATION = 'conv-relevant';
const SESSION = AGENT + ':' + CONVERSATION;

function wakeWith(text: string): WakeEvent {
  return { ...wakeFor(AGENT), conversationId: CONVERSATION, sessionKey: SESSION, origin: { type: 'user', id: OWNER }, trusted: true, payload: { text } };
}

describe('relevant memory in the run\'s note', () => {
  it('is delivered once: the first run\'s note holds it with its ids in the meta, the next run\'s note does not repeat it', async () => {
    const store = await seed();
    await store.patch('agents', AGENT, { createdBy: OWNER });
    await store.put('conversations', { ...conversationDoc(CONVERSATION, [AGENT]), memberIds: [] } as never);
    const graph = await startMemoryGraph();
    try {
      for (let i = 0; i < 45; i += 1) {
        await graph.graph.items.addItem(OWNER, { text: 'Fact number ' + String(i) + ' about the owner.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner', createdAt: '2026-01-01T00:00:' + String(10 + i) + 'Z' });
      }
      const utrecht = await graph.graph.items.addItem(OWNER, { text: 'Trains to Utrecht every Monday.', kind: 'fact', file: 'memory', saidIn: 'app', audience: 'owner', createdAt: '2025-06-01T00:00:00Z' });

      await buildContext(store, { agentId: AGENT, conversationId: CONVERSATION, sessionKey: SESSION, wake: [wakeWith('when do I go to Utrecht?')], home: { memory: portOf(graph, store) }, noteKey: 'run1' });
      const afterFirst = await readTranscript(store, SESSION);
      const firstNote = afterFirst.find((entry) => String(entry.message['content'] ?? '').includes('Memory relevant to this message'));
      expect(String(firstNote?.message['content'])).toContain('- Trains to Utrecht every Monday. (said by');
      expect(metaOf(firstNote?.message ?? {})?.items).toEqual([utrecht?.id]);

      await buildContext(store, { agentId: AGENT, conversationId: CONVERSATION, sessionKey: SESSION, wake: [wakeWith('when do I go to Utrecht?')], home: { memory: portOf(graph, store) }, noteKey: 'run2' });
      const afterSecond = await readTranscript(store, SESSION);
      const repeated = afterSecond.filter((entry) => String(entry.message['content'] ?? '').includes('Trains to Utrecht every Monday.'));
      expect(repeated).toHaveLength(1);
    } finally {
      await graph.close();
    }
  }, 60_000);
});

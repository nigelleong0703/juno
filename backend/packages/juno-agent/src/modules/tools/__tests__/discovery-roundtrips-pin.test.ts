import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import type { SystemOne, SystemOneAnswers } from '../../../ports/system-one/index.js';
import { createJevSystemOne } from '../../../execution/brain/system-one-jev.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createToolSearchTool } from '../tools/toolSearch.js';
import { createToolPreparer } from '../tools/prepareTools.js';

function tool(name: string, app: string, description: string, parameter: string): Tool {
  return { name, description, mcp: true, replay: 'safe', sideEffect: false,
    origin: { connectionId: app, connectionName: app, toolName: name, access: 'read' },
    parameters: { type: 'object', properties: { [parameter]: { type: 'string' } }, required: [parameter] },
    execute: vi.fn(async () => ({ content: [] })),
  };
}
function context(text: string, systemOne?: SystemOne): ToolContext {
  return { ownerId: 'owner-roundtrip', agentId: 'agent-roundtrip', conversationId: 'chat-roundtrip', runId: 'run-roundtrip',
    store: createMemoryStore(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
    wake: wakeEventSchema.parse({ id: 'wake', ownerId: 'owner-roundtrip', agentId: 'agent-roundtrip', conversationId: 'chat-roundtrip', sessionKey: 'agent-roundtrip:chat-roundtrip', kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: { text }, at: '2026-10-20T00:00:00Z' }),
    step: async (_name, fn) => fn(), signal: new AbortController().signal,
    ...(systemOne === undefined ? {} : { systemOne }),
  };
}
const textOf = (result: ToolResult): string => result.content.map((part) => part.type === 'text' ? part.text : '').join('\n');

describe('discovery round trip pins', () => {
  it('returns both complete schemas for search then create in one discovery', async () => {
    const tools = [tool('search_notes', 'Notes', 'Search saved notes before creating notes.', 'needle'), tool('create_note', 'Notes', 'Create saved notes from a title and body.', 'titleAndBody')];
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set() });
    const result = await search.execute({ namespace: 'notes', query: 'search create notes' }, context('Search then create notes'));
    for (const entry of tools) expect(textOf(result)).toContain(JSON.stringify(entry.parameters));
    for (const entry of tools) expect(entry.execute).not.toHaveBeenCalled();
  });

  it('namespace-only lookup uses task context to return a useful full schema beyond filler', async () => {
    const useful = tool('search_notes', 'Notes', 'Search saved notes for the current meeting code.', 'meetingNeedle');
    const tools = [...Array.from({ length: 12 }, (_, i) => tool('label_' + i, 'Notes', 'List a label.', 'label')), useful];
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set() });
    const result = await search.execute({ query: '', namespace: 'notes' }, context('Search Notes for the current meeting code'));
    expect(textOf(result)).toContain(JSON.stringify(useful.parameters));
  });

  it('exact canonical name fetch never pays a relevance decision', async () => {
    const ask = vi.fn(async () => null);
    const useful = tool('mcp__notes__search_notes', 'Notes', 'Search notes', 'needle');
    const search = createToolSearchTool({ all: async () => [useful], visible: async () => new Set() });
    const result = await search.execute({ query: useful.name }, context('Find notes', { ask }));
    expect(textOf(result)).toContain(JSON.stringify(useful.parameters));
    expect(ask).not.toHaveBeenCalled();
  });

  it('explicit Notes preselection does not score a mostly unrelated full catalog', async () => {
    const useful = tool('search_notes', 'Notes', 'Search saved Notes meeting code.', 'needle');
    const tools = [useful, ...Array.from({ length: 11 }, (_, i) => tool('note_label_' + i, 'Notes', 'List a label', 'label')),
      ...Array.from({ length: 90 }, (_, i) => tool('gmail_folder_' + i, 'Gmail', 'List mail folders', 'folder'))];
    let count = 0;
    const systemOne: SystemOne = { ask: async (_state, questions) => {
      count = Object.keys(questions).length;
      const answers: SystemOneAnswers = {};
      for (const [key, question] of Object.entries(questions)) {
        const yes = question.instructions.includes('search_notes');
        answers[key] = { type: 'score', score: yes ? 3 : 0, probabilities: yes ? [0, 0, 0, 1] : [1, 0, 0, 0], confidence: 1 };
      }
      return answers;
    } };
    const result = await createToolPreparer({ all: async () => tools })('Use the connected Notes app to search the meeting code', context('Notes meeting code', systemOne));
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(24);
    expect(textOf(result)).toContain(JSON.stringify(useful.parameters));
  });

  it('native request accepts hashed session attribution outside model state', async () => {
    let headers = new Headers();
    const fetcher: typeof fetch = async (_input, init) => {
      headers = new Headers(init?.headers);
      return Response.json({ answers: { fit: { type: 'noul', noul: 0.9 } } });
    };
    const native = createJevSystemOne({ baseUrl: 'https://example.invalid', apiKey: 'test-only', modelId: 'jev' }, fetcher);
    const sessionId = 'juno-' + createHash('sha256').update('agent-roundtrip:chat-roundtrip').digest('hex').slice(0, 32);
    const options = { allowEmulation: false, sessionId };
    await native.ask('task only', { fit: { type: 'noul', instructions: 'Does it fit?' } }, new AbortController().signal, options);
    expect(headers.get('session-id')).toBe(sessionId);
  });
});

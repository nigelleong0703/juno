import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-desktop/public-contracts';
import type { Enqueuer, Store, ToolContext, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { createTranscriptReadTool } from '../tools/transcriptRead.js';
import { createTranscriptSearchTool } from '../tools/transcriptSearch.js';

const AGENT = 'agent-1';
const CONV = 'conv-1';
const KEY = `${AGENT}:${CONV}`;
const OTHER_KEY = `${AGENT}:conv-other`;
const NOW_ISO = '2026-10-06T00:00:00.000Z';

type StoredAgent = Agent & { ownerId?: string };

class StubEnqueuer implements Enqueuer {
  async enqueue(): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }

  async stopRun(): Promise<void> {}

  async resolveAwakeable(): Promise<void> {}

  async scheduleRoutine(): Promise<void> {}
}

function makeWake(overrides?: Partial<WakeEvent>): WakeEvent {
  return {
    id: 'wke-1',
    ownerId: 'owner-1',
    agentId: AGENT,
    sessionKey: KEY,
    conversationId: CONV,
    kind: 'user_message',
    origin: { type: 'user' },
    trusted: true,
    priority: 'user',
    payload: {},
    at: new Date().toISOString(),
    status: 'accepted',
    ...overrides,
  };
}

function makeCtx(store: Store, wake?: WakeEvent, agentId = AGENT, conversationId = CONV): ToolContext {
  return {
    ownerId: 'owner-1',
    agentId,
    conversationId,
    runId: 'run-1',
    store, blobs: createMemoryBlobStore(),
    enqueuer: new StubEnqueuer(),
    wake: wake ?? makeWake(),
    step: async (name, fn) => fn(),
    signal: new AbortController().signal,
  };
}

function textOf(result: ToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') throw new Error('expected a text result');
  return first.text;
}

function ownerScoped(store: Store, ownerId: string): Store {
  const scope = store.forOwner;
  if (scope === undefined) throw new Error('store must support owner scoping');
  return scope(ownerId);
}

async function seedRoomFixtures(store: Store, ownerId: string): Promise<void> {
  const scoped = ownerScoped(store, ownerId);
  const model = {
    planner: { provider: 'test', model: 'test' },
    computer: { provider: 'test', model: 'test' },
    fast: { provider: 'test', model: 'test' },
  };
  const members: [string, string, string][] = [
    [AGENT, 'Aurora', 'aurora'],
    ['agent-2', 'Bram', 'bram'],
  ];
  for (const [id, name, handle] of members) {
    const agent: StoredAgent = {
      id,
      name,
      handle,
      avatar: { shape: 'circle', color: 1, eyes: 'happy' },
      title: 'New agent',
      status: 'idle',
      section: 'Agents',
      pinned: false,
      lastActivity: 'idle',
      unreadCount: 0,
      model,
      channels: [],
      macAccess: false,
      skillIds: [],
      pluginIds: [],
      sharing: { publishedToTeam: false },
      createdBy: ownerId,
      ownerId,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
    await scoped.put('agents', agent);
  }
  await scoped.put('conversations', {
    id: CONV,
    kind: 'room',
    title: 'Lab',
    agentIds: [AGENT, 'agent-2'],
    memberIds: [ownerId],
    unreadCount: 0,
    lastItemAt: NOW_ISO,
    createdAt: NOW_ISO,
  });
  await scoped.put('items', { id: 'itm-user', conversationId: CONV, type: 'user_message', at: NOW_ISO, authorId: ownerId, text: 'USER-ROOM-ASK', attachments: [], mentions: [] }, { conversationId: CONV });
  await scoped.put('items', { id: 'itm-peer', conversationId: CONV, type: 'agent_message', agentId: 'agent-2', markdown: 'PEER-ROOM-REPLY', citations: [], at: NOW_ISO }, { conversationId: CONV });
  await scoped.put('runs', {
    id: 'run-peer',
    agentId: 'agent-2',
    conversationId: CONV,
    title: 'run',
    status: 'completed',
    kind: 'chat',
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: NOW_ISO,
    lastActivityAt: NOW_ISO,
  }, { conversationId: CONV });
}

let seedCounter = 0;

async function seedUserTexts(store: Store, sessionKey: string, texts: string[]): Promise<void> {
  for (const text of texts) {
    seedCounter += 1;
    await store.put('transcripts', {
      id: `tx-seed-${seedCounter}`,
      sessionKey,
      seq: seedCounter,
      message: { role: 'user', content: text, timestamp: Date.now() },
      compactionEpoch: 0,
      at: new Date().toISOString(),
    });
  }
}

describe('transcript_read', () => {
  it('returns stored user, assistant and tool-result turns in seq order', async () => {
    const store = createMemoryStore();
    const tool = createTranscriptReadTool({ store });
    const ctx = makeCtx(store);
    await store.put('transcripts', {
      id: 'tx-b',
      sessionKey: KEY,
      seq: 2,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ASSISTANT-TWO' },
          { type: 'toolCall', id: 'call-1', name: 'shell.run', arguments: { cmd: 'ls' } },
        ],
      },
      compactionEpoch: 0,
      at: new Date().toISOString(),
    });
    await store.put('transcripts', {
      id: 'tx-a',
      sessionKey: KEY,
      seq: 0,
      message: { role: 'user', content: 'USER-ZERO', timestamp: Date.now() },
      compactionEpoch: 0,
      at: new Date().toISOString(),
    });
    await store.put('transcripts', {
      id: 'tx-c',
      sessionKey: KEY,
      seq: 1,
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'shell.run',
        content: [{ type: 'text', text: 'TOOL-ONE-OUTPUT' }],
        isError: false,
        timestamp: Date.now(),
      },
      compactionEpoch: 0,
      at: new Date().toISOString(),
    });
    const text = textOf(await tool.execute({}, ctx));
    expect(text).toContain('USER-ZERO');
    expect(text).toContain('ASSISTANT-TWO');
    expect(text).toContain('shell.run');
    expect(text).toContain('TOOL-ONE-OUTPUT');
    expect(text).not.toContain('Retrieved transcript');
    expect(text.indexOf('USER-ZERO')).toBeLessThan(text.indexOf('TOOL-ONE-OUTPUT'));
    expect(text.indexOf('TOOL-ONE-OUTPUT')).toBeLessThan(text.indexOf('ASSISTANT-TWO'));
  });

  it('stays in the current session by default', async () => {
    const store = createMemoryStore();
    const tool = createTranscriptReadTool({ store });
    await seedUserTexts(store, KEY, ['CURRENT-HELLO']);
    await seedUserTexts(store, OTHER_KEY, ['OTHER-SESSION-PRIVATE']);
    const text = textOf(await tool.execute({}, makeCtx(store)));
    expect(text).toContain('CURRENT-HELLO');
    expect(text).not.toContain('OTHER-SESSION-PRIVATE');
  });

  it('accepts an explicit sessionKey only when it matches the current session', async () => {
    const store = createMemoryStore();
    const tool = createTranscriptReadTool({ store });
    await seedUserTexts(store, KEY, ['CURRENT-HELLO']);
    const same = await tool.execute({ sessionKey: KEY }, makeCtx(store));
    expect(same.isError).not.toBe(true);
    expect(textOf(same)).toContain('CURRENT-HELLO');
  });

  it('rejects cross-session reads without leaking the other session', async () => {
    const store = createMemoryStore();
    const tool = createTranscriptReadTool({ store });
    await seedUserTexts(store, KEY, ['CURRENT-HELLO']);
    await seedUserTexts(store, OTHER_KEY, ['OTHER-SESSION-PRIVATE']);
    const result = await tool.execute({ sessionKey: OTHER_KEY }, makeCtx(store));
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('OTHER-SESSION-PRIVATE');
    expect(textOf(result)).not.toContain('CURRENT-HELLO');
  });

  it('reports an empty session instead of a placeholder', async () => {
    const store = createMemoryStore();
    const tool = createTranscriptReadTool({ store });
    const result = await tool.execute({}, makeCtx(store));
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain(KEY);
    expect(result.details).toMatchObject({ total: 0, hasMore: false });
  });

  it('pages 0-based positions with from inclusive and to exclusive', async () => {
    const store = createMemoryStore();
    const tool = createTranscriptReadTool({ store });
    await seedUserTexts(store, KEY, ['T0', 'T1', 'T2', 'T3', 'T4']);
    const result = await tool.execute({ range: { from: 1, to: 3 } }, makeCtx(store));
    const text = textOf(result);
    expect(text).toContain('T1');
    expect(text).toContain('T2');
    expect(text).not.toContain('T0');
    expect(text).not.toContain('T3');
    expect(result.details).toMatchObject({ total: 5, from: 1, to: 3, hasMore: true, nextFrom: 3 });
  });

  it('rejects invalid ranges', async () => {
    const store = createMemoryStore();
    const tool = createTranscriptReadTool({ store });
    await seedUserTexts(store, KEY, ['T0']);
    const ctx = makeCtx(store);
    for (const args of [{ range: { from: -1 } }, { range: { from: 1.5 } }, { range: { from: 3, to: 2 } }]) {
      const result = await tool.execute(args, ctx);
      expect(result.isError).toBe(true);
    }
  });

  it('scans beyond one store page and pages without loss', async () => {
    const store = createMemoryStore();
    const tool = createTranscriptReadTool({ store });
    const other: string[] = [];
    for (let i = 0; i < 650; i += 1) other.push(`NOISE-${i}`);
    await seedUserTexts(store, OTHER_KEY, other);
    const current: string[] = [];
    for (let i = 0; i < 120; i += 1) current.push(`CURRENT-${i}`);
    await seedUserTexts(store, KEY, current);
    const first = await tool.execute({}, makeCtx(store));
    expect(first.details).toMatchObject({ total: 120, from: 0, to: 50, hasMore: true, nextFrom: 50 });
    expect(textOf(first)).toContain('CURRENT-0');
    expect(textOf(first)).not.toContain('CURRENT-50');
    expect(textOf(first)).not.toContain('NOISE-0');
    const rest = await tool.execute({ range: { from: 50, to: 200 } }, makeCtx(store));
    expect(rest.details).toMatchObject({ total: 120, from: 50, to: 120, hasMore: false });
    expect(textOf(rest)).toContain('CURRENT-50');
    expect(textOf(rest)).toContain('CURRENT-119');
    expect(textOf(rest)).not.toContain('NOISE-649');
  });

  it('filters wake-style ids that contain colons within one page', async () => {
    const store = createMemoryStore();
    const tool = createTranscriptReadTool({ store });
    await store.put('transcripts', {
      id: `tx_wake_${KEY}_wke-1`,
      sessionKey: KEY,
      seq: 0,
      message: { role: 'user', content: 'WAKE-HELLO', timestamp: Date.now() },
      compactionEpoch: 0,
      at: new Date().toISOString(),
    });
    await store.put('transcripts', {
      id: 'tx_wake_other:private_wke-9',
      sessionKey: 'other:private',
      seq: 0,
      message: { role: 'user', content: 'WAKE-OTHER-PRIVATE', timestamp: Date.now() },
      compactionEpoch: 0,
      at: new Date().toISOString(),
    });
    const text = textOf(await tool.execute({}, makeCtx(store)));
    expect(text).toContain('WAKE-HELLO');
    expect(text).not.toContain('WAKE-OTHER-PRIVATE');
  });

  it('omits hidden thinking and signatures but keeps public text and tool calls', async () => {
    const store = createMemoryStore();
    const tool = createTranscriptReadTool({ store });
    await store.put('transcripts', {
      id: 'tx-think',
      sessionKey: KEY,
      seq: 0,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'SECRET-PLAN-XYZ', thinkingSignature: 'SIG-SECRET' },
          { type: 'text', text: 'PUBLIC-ANSWER-HERE', textSignature: 'SIG-TEXT' },
          { type: 'toolCall', id: 'call-9', name: 'files.read', arguments: { path: 'notes.md' } },
        ],
      },
      compactionEpoch: 0,
      at: new Date().toISOString(),
    });
    const text = textOf(await tool.execute({}, makeCtx(store)));
    expect(text).toContain('PUBLIC-ANSWER-HERE');
    expect(text).toContain('files.read');
    expect(text).not.toContain('SECRET-PLAN-XYZ');
    expect(text).not.toContain('SIG-SECRET');
    expect(text).not.toContain('SIG-TEXT');
  });

  it('labels tool results with the tool name and error flag', async () => {
    const store = createMemoryStore();
    const tool = createTranscriptReadTool({ store });
    await store.put('transcripts', {
      id: 'tx-err',
      sessionKey: KEY,
      seq: 0,
      message: {
        role: 'toolResult',
        toolCallId: 'call-2',
        toolName: 'shell.run',
        content: [{ type: 'text', text: 'BOOM-OUTPUT' }],
        isError: true,
        timestamp: Date.now(),
      },
      compactionEpoch: 0,
      at: new Date().toISOString(),
    });
    const text = textOf(await tool.execute({}, makeCtx(store)));
    expect(text).toContain('shell.run');
    expect(text).toContain('BOOM-OUTPUT');
    expect(text).toContain('(error)');
  });

  it('rejects readers that are not conversation participants', async () => {
    const store = createMemoryStore();
    const tool = createTranscriptReadTool({ store });
    await seedUserTexts(store, KEY, ['CURRENT-HELLO']);
    await store.put('conversations', {
      id: CONV,
      kind: 'direct',
      agentIds: ['agent-9'],
      memberIds: ['owner-1'],
      unreadCount: 0,
      lastItemAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    const result = await tool.execute({}, makeCtx(store));
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('CURRENT-HELLO');
  });

  it('allows readers that belong to the conversation', async () => {
    const store = createMemoryStore();
    const tool = createTranscriptReadTool({ store });
    await seedUserTexts(store, KEY, ['CURRENT-HELLO']);
    await store.put('conversations', {
      id: CONV,
      kind: 'direct',
      agentIds: [AGENT],
      memberIds: ['owner-1'],
      unreadCount: 0,
      lastItemAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    const result = await tool.execute({}, makeCtx(store));
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('CURRENT-HELLO');
  });

  it('returns shared room data with author names instead of per-agent turns', async () => {
    const store = createMemoryStore();
    await seedRoomFixtures(store, 'owner-1');
    await seedUserTexts(store, KEY, ['ISOLATED-TURN']);
    const tool = createTranscriptReadTool({ store });
    const result = await tool.execute({}, makeCtx(store));
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain('PEER-ROOM-REPLY');
    expect(text).toContain('"Bram"');
    expect(text).not.toContain('(run ');
    expect(text).toContain('USER-ROOM-ASK');
    expect(text).not.toContain('ISOLATED-TURN');
  });
});

describe('transcript_read around', () => {
  it('returns a window centred on the first entry at or after the time and keeps paging', async () => {
    const store = createMemoryStore();
    for (let seq = 0; seq < 100; seq += 1) {
      await store.put('transcripts', {
        id: `tx-around-${seq}`, sessionKey: KEY, seq,
        message: { role: 'user', content: `ENTRY-${seq}`, timestamp: 1 },
        compactionEpoch: 0, at: new Date(Date.UTC(2026, 9, 1, 0, seq)).toISOString(),
      });
    }
    const tool = createTranscriptReadTool({ store });
    const result = await tool.execute({ around: '2026-10-01T00:50:00Z' }, makeCtx(store));
    const text = textOf(result);
    expect(text).toContain('ENTRY-30');
    expect(text).toContain('ENTRY-50');
    expect(text).not.toContain('ENTRY-29\n');
    expect(text).not.toContain('ENTRY-70');
    expect(result.details).toMatchObject({ total: 100, from: 30, to: 70, hasMore: true, nextFrom: 70 });
    const last = await tool.execute({ around: '2027-01-01' }, makeCtx(store));
    expect(last.details).toMatchObject({ from: 60, to: 100, hasMore: false });
  });
});

describe('transcript_search', () => {
  async function seedChat(store: Store): Promise<void> {
    await store.put('conversations', { id: CONV, kind: 'direct', agentIds: [AGENT], memberIds: ['owner-1'], unreadCount: 0, lastItemAt: NOW_ISO, createdAt: NOW_ISO }, { conversationId: CONV });
    const rows: Array<[string, string, string]> = [
      ['i1', '2026-09-01T10:00:00.000Z', 'We booked the Lisbon flight for March'],
      ['i2', '2026-09-20T10:00:00.000Z', 'Lisbon hotel is near the river'],
      ['i3', '2026-10-02T10:00:00.000Z', 'Tokyo flight prices are up'],
    ];
    for (const [id, at, text] of rows) {
      await store.put('items', { id, conversationId: CONV, type: 'user_message', at, authorId: 'owner-1', text, attachments: [], mentions: [] }, { conversationId: CONV });
    }
    await store.put('items', { id: 'other', conversationId: 'conv-other', type: 'user_message', at: NOW_ISO, authorId: 'owner-1', text: 'Lisbon flight elsewhere', attachments: [], mentions: [] }, { conversationId: 'conv-other' });
  }

  it('finds messages containing all words, newest first, within the time range', async () => {
    const store = createMemoryStore();
    await seedChat(store);
    const tool = createTranscriptSearchTool();
    const all = textOf(await tool.execute({ query: 'flight lisbon' }, makeCtx(store)));
    expect(all).toContain('i1');
    expect(all).not.toContain('i2');
    expect(all).not.toContain('i3');
    expect(all).not.toContain('elsewhere');
    const either = textOf(await tool.execute({ query: 'lisbon' }, makeCtx(store)));
    expect(either.indexOf('i2')).toBeLessThan(either.indexOf('i1'));
    const bounded = textOf(await tool.execute({ query: 'lisbon', after: '2026-09-10' }, makeCtx(store)));
    expect(bounded).toContain('i2');
    expect(bounded).not.toContain('i1');
    const before = textOf(await tool.execute({ query: 'flight', before: '2026-10-01' }, makeCtx(store)));
    expect(before).toContain('i1');
    expect(before).not.toContain('i3');
  });

  it('refuses agents that are not participants of the conversation', async () => {
    const store = createMemoryStore();
    await seedChat(store);
    const result = await createTranscriptSearchTool().execute({ query: 'lisbon' }, makeCtx(store, undefined, 'agent-intruder'));
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('Lisbon');
  });
});

/**
 * LOOP-ROUTINE1 read evidence: mark-read clears the conversation counter and delivers one
 * authorized read receipt per actually-delivering routine (explicit target or resolved actual
 * chat), carrying the cutoff plus history-anchored result ids. Foreign chats stay refused.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { type Hono } from 'hono';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import type { Agent, Conversation, Routine } from '@agent-desktop/public-contracts';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';

const OWNER = getConfig().OWNER_ID;
const OTHER = 'member-other-owner';
const NOW = '2026-10-09T00:10:00.000Z';

interface Receipt {
  routineId: string;
  conversationId: string;
  readCutoff: string;
  resultIds: string[];
}

class ReadEnqueuer {
  receipts: Receipt[] = [];
  async enqueue(): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
  async routineResultsRead(receipt: Receipt): Promise<void> {
    this.receipts.push(receipt);
  }
}

function makeAgent(id: string): Agent & { ownerId: string } {
  const now = new Date().toISOString();
  return {
    id, name: id, handle: id,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't',    status: 'idle', section: 'Inbox', pinned: false, lastActivity: now,
    unreadCount: 0, channels: [], macAccess: false, skillIds: [], pluginIds: [],
    sharing: { publishedToTeam: false }, createdBy: OWNER, createdAt: now, updatedAt: now,
    ownerId: OWNER,
  };
}

function makeConversation(id: string, agentIds: string[], owner: string): Conversation & { ownerId: string } {
  const now = new Date().toISOString();
  return {
    id, kind: 'direct', agentIds, memberIds: [owner],
    unreadCount: 3, lastItemAt: now, createdAt: now, ownerId: owner,
  };
}

function makeRoutine(id: string, agentId: string, target: string | undefined): Routine & { ownerId: string } {
  return {
    id, agentId, name: id, instructions: 'Summarize',
    trigger: { kind: 'schedule', human: 'Daily', tz: 'UTC' },
    delivery: target === undefined ? { channel: 'chat' } : { channel: 'chat', target },
    notify: { mode: 'always' },
    enabled: true,
    status: 'active',
    runs: [{
      id: 'rr-1', routineId: id, status: 'completed', summary: 'latest', runId: 'run-1',
      outputIds: ['out-1', 'out-2'], startedAt: '2026-10-07T00:05:00.000Z', finishedAt: '2026-10-07T00:06:00.000Z',
    }],
    createdAt: NOW,
    ownerId: OWNER,
  };
}

describe('routine read evidence on mark-read', () => {
  let store: Store;
  let app: Hono;
  let enqueuer: ReadEnqueuer;

  async function call(path: string, method: string, owner: string = OWNER): Promise<Response> {
    // As production: the owner travels as x-owner-id, so another owner is a real, different caller.
    return app.request(path, { method, headers: ownerHeaders(owner) });
  }

  beforeEach(async () => {
    const mem = createMemoryStore();
    store = withDefaultOwner(mem, OWNER);
    enqueuer = new ReadEnqueuer();
    app = createTestApp({ store, bus: mem.eventBus, enqueuer });
    await store.put('agents', makeAgent('agt-1'));
  });

  it('sends one receipt with history result ids for the delivering routine', async () => {
    await store.put('conversations', makeConversation('conv-1', ['agt-1'], OWNER));
    await store.put('routines', makeRoutine('rtn-1', 'agt-1', 'conv-1'));
    await store.put('routines', makeRoutine('rtn-elsewhere', 'agt-1', 'conv-9'));
    const res = await call('/v1/conversations/conv-1/mark-read', 'POST');
    expect(res.status).toBe(200);
    expect(enqueuer.receipts).toHaveLength(1);
    expect(enqueuer.receipts[0]?.routineId).toBe('rtn-1');
    expect(enqueuer.receipts[0]?.conversationId).toBe('conv-1');
    expect(enqueuer.receipts[0]?.resultIds).toEqual(['out-1', 'out-2']);
  });

  it('matches a target-less routine through its actual resolved chat', async () => {
    await store.put('conversations', makeConversation('conv-1', ['agt-1'], OWNER));
    await store.put('routines', makeRoutine('rtn-plain', 'agt-1', undefined));
    const res = await call('/v1/conversations/conv-1/mark-read', 'POST');
    expect(res.status).toBe(200);
    expect(enqueuer.receipts.map((receipt) => receipt.routineId)).toEqual(['rtn-plain']);
  });

  it('sends nothing for a foreign chat', async () => {
    await store.put('conversations', makeConversation('conv-x', ['agt-1'], OTHER));
    const res = await call('/v1/conversations/conv-x/mark-read', 'POST');
    // Another owner's chat is invisible in production (404), never revealed with a 403.
    expect(res.status).toBe(404);
    expect(enqueuer.receipts).toHaveLength(0);
  });
});

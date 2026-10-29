/**
 * H-71/H-75: report_to_parent lets a child task send its parent a progress update or question while it
 * keeps working. The parent session gets a hand_back (system-origin, untrusted, background) whose id
 * comes from the step, so a replay is deduped; a non-child run cannot use it.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import type { Enqueuer, Store, ToolContext, ToolResult, WakeEvent } from '../../../contracts/index.js';
import type { Agent, Conversation, Run } from '@agent-desktop/public-contracts';
import { spawnChildTask, type ChildDispatchAdapter } from '../child.js';
import { createReportToParentTool } from '../childReport.js';

const OWNER = 'owner-rp';
const AGENT = 'agent-rp';
const CONV = 'conv-rp';
const PARENT = 'run-parent-rp';
const AT = '2026-10-09T00:00:00.000Z';
const usage = { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 };

class RecordingEnqueuer implements Enqueuer {
  readonly wakes: WakeEvent[] = [];
  accept = true;
  async enqueue(wake: WakeEvent): Promise<{ accepted: boolean }> {
    this.wakes.push(wake);
    return { accepted: this.accept };
  }
  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}

const adapter: ChildDispatchAdapter = { startChildRun: async () => {} };

async function seedWorld(): Promise<Store> {
  const raw = createMemoryStore();
  const store = raw.forOwner === undefined ? raw : raw.forOwner(OWNER);
  const agent: Agent = { id: AGENT, name: AGENT, handle: AGENT, avatar: { shape: 'circle', color: 1, eyes: 'dot' }, title: 't', status: 'idle', section: 'Work', pinned: false, lastActivity: '', unreadCount: 0, model: { planner: { provider: 'scripted', model: 't' }, computer: { provider: 'scripted', model: 't' }, fast: { provider: 'scripted', model: 't' } }, channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdBy: OWNER, createdAt: AT, updatedAt: AT };
  const conversation: Conversation = { id: CONV, kind: 'direct', title: 'p', agentIds: [AGENT], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT };
  const parent: Run = { id: PARENT, agentId: AGENT, conversationId: CONV, title: 'parent', status: 'running', kind: 'chat', steps: [], usage, startedAt: AT, lastActivityAt: AT };
  await store.put('agents', agent);
  await store.put('conversations', conversation);
  await store.put('runs', parent, { agentId: AGENT, conversationId: CONV });
  return store;
}

async function spawn(store: Store, notify?: { chainId: string; generation: number }): Promise<string> {
  const spawned = await spawnChildTask(store, { ownerId: OWNER, agentId: AGENT, parentRunId: PARENT, conversationId: CONV, callId: 'stp-1', prompt: 'work', targetAgentId: AGENT, ...(notify === undefined ? {} : { notify }) }, adapter);
  if (!spawned.ok) throw new Error(spawned.reason);
  return spawned.child.runId;
}

function ctxFor(store: Store, enqueuer: Enqueuer, runId: string): ToolContext {
  const wake: WakeEvent = {
    id: 'w', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV, kind: 'child_task',
    origin: { type: 'system' }, trusted: true, priority: 'background', payload: {}, hop: { chainId: 'chain-r', depth: 1 }, at: AT, status: 'accepted',
  };
  return { ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId, stepId: 'stp-r', store, blobs: createMemoryBlobStore(), enqueuer, wake, step: async (_name, fn) => fn(), signal: new AbortController().signal };
}

function text(result: ToolResult): string {
  const part = result.content[0];
  return part !== undefined && part.type === 'text' ? part.text : '';
}

describe('report_to_parent', () => {
  it('wakes the parent session with an untrusted hand_back', async () => {
    const store = await seedWorld();
    const childId = await spawn(store);
    const enqueuer = new RecordingEnqueuer();
    const result = await createReportToParentTool().execute({ text: 'halfway: 3 of 6 fares checked' }, ctxFor(store, enqueuer, childId));
    expect(result.isError).not.toBe(true);
    expect(enqueuer.wakes).toHaveLength(1);
    expect(enqueuer.wakes[0]).toMatchObject({
      id: childId + ':report:stp-r', kind: 'hand_back', sessionKey: AGENT + ':' + CONV, origin: { type: 'system' },
      trusted: false, priority: 'background', hop: { chainId: 'chain-r', depth: 1 },
      payload: { text: 'halfway: 3 of 6 fares checked', taskId: childId },
    });
  });

  it('reports a background child to its recorded reporting session', async () => {
    const store = await seedWorld();
    const childId = await spawn(store, { chainId: 'chain-bg', generation: 1 });
    const enqueuer = new RecordingEnqueuer();
    await createReportToParentTool().execute({ text: 'update' }, ctxFor(store, enqueuer, childId));
    expect(enqueuer.wakes[0]?.sessionKey).toBe(AGENT + ':' + CONV);
  });

  it('is refused for a run that is not a child task', async () => {
    const store = await seedWorld();
    const enqueuer = new RecordingEnqueuer();
    const result = await createReportToParentTool().execute({ text: 'hi' }, ctxFor(store, enqueuer, PARENT));
    expect(result.isError).toBe(true);
    expect(enqueuer.wakes).toEqual([]);
  });

  it('reports an error when the parent session did not accept the report', async () => {
    const store = await seedWorld();
    const childId = await spawn(store);
    const enqueuer = new RecordingEnqueuer();
    enqueuer.accept = false;
    const result = await createReportToParentTool().execute({ text: 'x' }, ctxFor(store, enqueuer, childId));
    expect(result.isError).toBe(true);
  });
});

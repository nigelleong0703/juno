/**
 * H-99: child_spawn `fast`. The flag is validated, fixed on the child's reserved row (so a retry, a rebuilt
 * run row and a child_message continuation keep it), and the tool says plainly what it does.
 */
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import type { Enqueuer, Store, Tool, ToolContext, ToolResult, WakeEvent } from '../../../contracts/index.js';
import type { Agent, Conversation, Run } from '@agent-desktop/public-contracts';
import { createToolRegistry } from '../../tools/index.js';
import { harnessToolView } from '../../tools/harness-view.js';
import { activeHarnessVersion } from '../../harness/loader.js';
import type { ChildDispatchAdapter } from '../child.js';
import type { ChildRun } from '../childRead.js';
import { putRunPreservingChild } from '../../../execution/harness/services/run-reservation.js';

const OWNER = 'owner-fast';
const AGENT = 'agent-fast';
const CONV = 'conv-fast';
const PARENT = 'run-parent-fast';
const AT = '2026-10-22T00:00:00.000Z';
const usage = { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 };

const adapter: ChildDispatchAdapter = { async startChildRun() {} };
const enqueuer: Enqueuer = { enqueue: async () => ({ accepted: true }), stopRun: async () => {}, resolveAwakeable: async () => {}, scheduleRoutine: async () => {} };

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

function ctxFor(store: Store, stepId: string): ToolContext {
  const wake: WakeEvent = { id: 'w', ownerId: OWNER, agentId: AGENT, sessionKey: AGENT + ':' + CONV, conversationId: CONV, kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: AT, status: 'accepted' };
  return { ownerId: OWNER, agentId: AGENT, conversationId: CONV, runId: PARENT, stepId, store, blobs: createMemoryBlobStore(), enqueuer, wake, step: async (_name, fn) => fn(), signal: new AbortController().signal };
}

async function tool(store: Store, name: string): Promise<Tool> {
  const found = (await createToolRegistry({ store, enqueuer, childDispatch: adapter })).get(name);
  if (found === undefined) throw new Error(name + ' missing');
  // The model-facing view: the description and parameter texts are harness units (tools/harness-view.ts).
  return harnessToolView(found, activeHarnessVersion());
}

const spawnedId = (result: ToolResult): string => {
  const part = result.content[0];
  return part !== undefined && part.type === 'text' ? (part.text.split(' ')[3] ?? '') : '';
};

describe('child_spawn fast', () => {
  it('describes the option as what it does, without rules for when to use it', async () => {
    const spawn = await tool(await seedWorld(), 'child_spawn');
    expect(spawn.description).toContain('fast (optional) runs the child on a quicker, cheaper model that reasons less carefully');
    expect(spawn.parameters).toMatchObject({ properties: { fast: { type: 'boolean' } }, additionalProperties: false });
  });

  it('accepts only a boolean', async () => {
    const store = await seedWorld();
    const spawn = await tool(store, 'child_spawn');
    await expect(spawn.execute({ prompt: 'p', fast: 'yes' }, ctxFor(store, 's-bad'))).rejects.toThrow();
    await expect(spawn.execute({ prompt: 'p', fast: 'gpt-5' }, ctxFor(store, 's-bad2'))).rejects.toThrow();
  });

  it('fixes fast on the reserved row; absent or false leaves the row without it', async () => {
    const store = await seedWorld();
    const spawn = await tool(store, 'child_spawn');
    const fast: ChildRun | null = await store.get('runs', spawnedId(await spawn.execute({ prompt: 'a', fast: true }, ctxFor(store, 's-1'))));
    const off: ChildRun | null = await store.get('runs', spawnedId(await spawn.execute({ prompt: 'b', fast: false }, ctxFor(store, 's-2'))));
    const none: ChildRun | null = await store.get('runs', spawnedId(await spawn.execute({ prompt: 'c' }, ctxFor(store, 's-3'))));
    expect(fast?.fastModel).toBe(true);
    expect(off?.fastModel).toBeUndefined();
    expect(none?.fastModel).toBeUndefined();
  });

  it('keeps narrowing by tools beside fast', async () => {
    const store = await seedWorld();
    const spawn = await tool(store, 'child_spawn');
    const row: ChildRun | null = await store.get('runs', spawnedId(await spawn.execute({ prompt: 'a', fast: true, tools: ['web_search'] }, ctxFor(store, 's-1'))));
    expect(row).toMatchObject({ fastModel: true, allowedTools: ['web_search'] });
  });

  it('a rebuilt run row keeps fast', async () => {
    const store = await seedWorld();
    const spawn = await tool(store, 'child_spawn');
    const id = spawnedId(await spawn.execute({ prompt: 'a', fast: true }, ctxFor(store, 's-1')));
    const row: ChildRun | null = await store.get('runs', id);
    if (row === null) throw new Error('child missing');
    const { fastModel: _dropped, ...fresh } = row;
    const rebuilt: ChildRun = await putRunPreservingChild(store, fresh, true);
    expect(rebuilt.fastModel).toBe(true);
  });

  it('a continuation of a finished fast child stays fast', async () => {
    const store = await seedWorld();
    const spawn = await tool(store, 'child_spawn');
    const message = await tool(store, 'child_message');
    const id = spawnedId(await spawn.execute({ prompt: 'a', fast: true }, ctxFor(store, 's-1')));
    await store.patch('runs', id, { status: 'completed', childResult: 'done' });
    const continued = await message.execute({ runId: id, text: 'and one more thing' }, ctxFor(store, 's-2'));
    expect(continued.isError).not.toBe(true);
    const next: ChildRun | null = await store.get('runs', String(Reflect.get(Reflect.get(continued.details ?? {}, 'spawned') ?? {}, 'runId')));
    expect(next?.fastModel).toBe(true);
  });
});

describe('child_spawn deep', () => {
  it('says what it does and costs, validates a boolean, and fixes deep on the row beside fast', async () => {
    const store = await seedWorld();
    const spawn = await tool(store, 'child_spawn');
    expect(spawn.description).toContain('deep (optional) makes the child think much longer');
    expect(spawn.parameters).toMatchObject({ properties: { deep: { type: 'boolean' } }, additionalProperties: false });
    await expect(spawn.execute({ prompt: 'p', deep: 'yes' }, ctxFor(store, 's-bad'))).rejects.toThrow();
    const both: ChildRun | null = await store.get('runs', spawnedId(await spawn.execute({ prompt: 'a', deep: true, fast: true }, ctxFor(store, 's-1'))));
    const off: ChildRun | null = await store.get('runs', spawnedId(await spawn.execute({ prompt: 'b', deep: false }, ctxFor(store, 's-2'))));
    expect(both).toMatchObject({ deepEffort: true, fastModel: true });
    expect(off?.deepEffort).toBeUndefined();
  });

  it('a rebuilt run row and a continuation keep deep', async () => {
    const store = await seedWorld();
    const spawn = await tool(store, 'child_spawn');
    const message = await tool(store, 'child_message');
    const id = spawnedId(await spawn.execute({ prompt: 'a', deep: true }, ctxFor(store, 's-1')));
    const row: ChildRun | null = await store.get('runs', id);
    if (row === null) throw new Error('child missing');
    const { deepEffort: _dropped, ...fresh } = row;
    const rebuilt: ChildRun = await putRunPreservingChild(store, fresh, true);
    expect(rebuilt.deepEffort).toBe(true);
    await store.patch('runs', id, { status: 'completed', childResult: 'done' });
    const continued = await message.execute({ runId: id, text: 'and one more thing' }, ctxFor(store, 's-2'));
    const next: ChildRun | null = await store.get('runs', String(Reflect.get(Reflect.get(continued.details ?? {}, 'spawned') ?? {}, 'runId')));
    expect(next?.deepEffort).toBe(true);
  });
});

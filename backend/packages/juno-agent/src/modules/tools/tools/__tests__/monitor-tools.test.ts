import { describe, expect, it } from 'vitest';
import type { Agent, Conversation } from '@agent-desktop/public-contracts';
import type { Enqueuer, Store, Tool, ToolContext, ToolResult, WakeEvent } from '../../../../contracts/index.js';
import { createMemoryBlobStore } from '../../../../testing/blobs.js';
import { createMemoryStore } from '../../../../testing/store.js';
import { MONITOR_MAX_ACTIVE } from '../../../tasks/routines/monitor.js';
import { createMonitorCreateTool, createMonitorManageTool } from '../monitorTools.js';
import { createStateUpdateTool } from '../stateUpdate.js';

const OWNER = 'owner-mon';
const NOW = '2026-10-22T10:00:00.000Z';

class Scheduled implements Enqueuer {
  scheduled: string[] = [];
  async enqueue(): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(routineId: string): Promise<void> { this.scheduled.push(routineId); }
}

const agent = (id: string): Agent & { ownerId: string } => ({
  id, ownerId: OWNER, createdBy: OWNER, name: id, handle: id, avatar: { shape: 'circle', color: 1, eyes: 'happy' }, title: 'QA', status: 'idle', section: 'Agents',
  pinned: false, lastActivity: 'idle', unreadCount: 0,
  model: { planner: { provider: 'f', model: 'f' }, computer: { provider: 'f', model: 'f' }, fast: { provider: 'f', model: 'f' } },
  channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdAt: NOW, updatedAt: NOW,
});
const conversation: Conversation = { id: 'chat', kind: 'direct', agentIds: ['juno'], memberIds: [OWNER], unreadCount: 0, lastItemAt: NOW, createdAt: NOW };

const issues = (...ids: number[]): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify({ issues: ids.map((id) => ({ id, title: 'Issue ' + String(id) })) }) }] });
const readTool = (calls: unknown[], result: ToolResult = issues(1, 2), access: 'read' | 'action' = 'read'): Tool => ({
  name: 'list_issues', description: 'List issues', parameters: { type: 'object', properties: {} }, replay: 'never', sideEffect: true, mcp: true,
  origin: { connectionId: 'con', connectionName: 'Tracker', toolName: 'list_issues', access },
  execute: async (args) => { calls.push(args); return result; },
});

const wakeOf = (change: Partial<WakeEvent>): WakeEvent => ({
  id: 'w', ownerId: OWNER, agentId: 'juno', sessionKey: 'juno:chat', conversationId: 'chat', kind: 'user_message', origin: { type: 'user', id: OWNER },
  trusted: true, priority: 'user', payload: {}, at: NOW, status: 'accepted', ...change,
});

async function setup(tools: Tool[] = []) {
  const store = createMemoryStore();
  const enqueuer = new Scheduled();
  await store.put('agents', agent('juno'));
  await store.put('conversations', conversation);
  const create = createMonitorCreateTool({ store, enqueuer, tools: { forAgent: async () => tools } });
  const manage = createMonitorManageTool({ store, enqueuer });
  const ctx = (wake: WakeEvent = wakeOf({})): ToolContext => ({
    ownerId: OWNER, agentId: 'juno', conversationId: 'chat', runId: 'run', store, blobs: createMemoryBlobStore(), enqueuer, wake,
    step: async (_name, fn) => fn(), signal: new AbortController().signal,
  });
  return { store, enqueuer, create, manage, ctx };
}

const spec = { name: 'New issues', prompt: 'tell me about new issues', tool: 'list_issues', args: { repo: 'acme/app' }, items: 'issues', id: 'id' };
const monitors = async (store: Store) => (await store.list('routines', { limit: 100 })).items.filter((routine) => routine.trigger.kind === 'check');
const messageOf = (result: ToolResult): string => result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');

describe('monitor_create', () => {
  it('checks once to prove the spec, records what exists as seen, and schedules the monitor', async () => {
    const calls: unknown[] = [];
    const { store, enqueuer, create, ctx } = await setup([readTool(calls)]);
    const result = await create.execute(spec, ctx());
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([{ repo: 'acme/app' }]);
    const [routine] = await monitors(store);
    expect(routine).toMatchObject({
      name: 'New issues', instructions: 'tell me about new issues', enabled: true, delivery: { channel: 'chat', target: 'chat' },
      trigger: { kind: 'check', tool: 'list_issues', items: 'issues', id: 'id', everyMinutes: 30 }, monitor: { failures: 0 },
    });
    expect(Date.parse(routine?.monitor?.expiresAt ?? '') - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect((await store.get('monitorState', routine?.id ?? ''))?.seen).toEqual(['1', '2']);
    expect(enqueuer.scheduled).toEqual([routine?.id]);
    expect(messageOf(result)).toContain('2 item(s)');
  });

  it('refuses a spec that cannot work, or a failing first check, without creating anything', async () => {
    const calls: unknown[] = [];
    const { store, create, ctx } = await setup([readTool(calls)]);
    expect(messageOf(await create.execute({ ...spec, id: undefined }, ctx()))).toContain('`id` is required');
    expect(calls).toHaveLength(0);
    const wrongPath = await create.execute({ ...spec, items: 'data.issues' }, ctx());
    expect(wrongPath.isError).toBe(true);
    expect(messageOf(wrongPath)).toContain('not a list');
    expect(await monitors(store)).toHaveLength(0);
  });

  it('only watches with a tool that reads', async () => {
    const calls: unknown[] = [];
    const { store, create, ctx } = await setup([readTool(calls, issues(1), 'action'), { ...readTool([]), name: 'files.read', origin: undefined, mcp: undefined, sideEffect: false }]);
    expect(messageOf(await create.execute(spec, ctx()))).toContain('changes things');
    expect(messageOf(await create.execute({ ...spec, tool: 'files.read' }, ctx()))).toContain('only use a connector read tool or web_fetch');
    expect(messageOf(await create.execute({ ...spec, tool: 'nothing' }, ctx()))).toContain('not available');
    expect(calls).toHaveLength(0);
    expect(await monitors(store)).toHaveLength(0);
  });

  it('checks at most every fifteen minutes and keeps ten active at most', async () => {
    const { store, create, ctx } = await setup([readTool([])]);
    expect(messageOf(await create.execute({ ...spec, everyMinutes: 5 }, ctx()))).toContain('at most every 15 minutes');
    for (let i = 0; i < MONITOR_MAX_ACTIVE; i += 1) expect((await create.execute({ ...spec, name: 'm' + String(i) }, ctx())).isError).toBeUndefined();
    const eleventh = await create.execute(spec, ctx());
    expect(eleventh.isError).toBe(true);
    expect(messageOf(eleventh)).toContain('10 active monitors');
    expect(await monitors(store)).toHaveLength(MONITOR_MAX_ACTIVE);
  });

  it('is for the owner asking live, never a routine, a monitor run or a stranger', async () => {
    const { store, create, manage, ctx } = await setup([readTool([])]);
    const routineRun = wakeOf({ kind: 'routine', origin: { type: 'automation', id: 'rtn' }, priority: 'background' });
    const monitorRun = wakeOf({ kind: 'monitor', origin: { type: 'automation', id: 'mon' }, trusted: false, priority: 'background' });
    const stranger = wakeOf({ trusted: false, payload: { speakerName: 'Mallory' } });
    for (const wake of [routineRun, monitorRun, stranger]) {
      expect((await create.execute(spec, ctx(wake))).isError).toBe(true);
      expect((await manage.execute({ action: 'list' }, ctx(wake))).isError).toBe(true);
    }
    expect(await monitors(store)).toHaveLength(0);
  });

  it('cannot make a routine from a run a monitor started either', async () => {
    const { store, enqueuer, ctx } = await setup();
    const result = await createStateUpdateTool({ store, enqueuer }).execute(
      { target: 'routine', action: 'create', name: 'x', prompt: 'y', schedule: '0 9 * * *' },
      ctx(wakeOf({ kind: 'monitor', origin: { type: 'automation', id: 'mon' }, trusted: false })),
    );
    expect(result.isError).toBe(true);
    expect((await store.list('routines', { limit: 10 })).items).toHaveLength(0);
  });
});

describe('monitor_manage', () => {
  it('lists, pauses, resumes, renews and stops the agent\'s monitors', async () => {
    const { store, enqueuer, create, manage, ctx } = await setup([readTool([])]);
    await create.execute(spec, ctx());
    const [routine] = await monitors(store);
    const id = routine?.id ?? '';
    expect(messageOf(await manage.execute({ action: 'list' }, ctx()))).toContain('"New issues"');
    await manage.execute({ action: 'pause', id }, ctx());
    expect(await store.get('routines', id)).toMatchObject({ enabled: false, status: 'paused' });
    await manage.execute({ action: 'resume', id }, ctx());
    expect(await store.get('routines', id)).toMatchObject({ enabled: true, status: 'active' });
    await store.patch('routines', id, { enabled: false, status: 'paused', monitor: { expiresAt: '2026-10-01T00:00:00.000Z', failures: 0, stoppedReason: 'expired' } });
    await manage.execute({ action: 'renew', id }, ctx());
    const renewed = await store.get('routines', id);
    expect(renewed).toMatchObject({ enabled: true });
    expect(renewed?.monitor?.stoppedReason).toBeUndefined();
    expect(Date.parse(renewed?.monitor?.expiresAt ?? '')).toBeGreaterThan(Date.now());
    expect(enqueuer.scheduled.filter((scheduled) => scheduled === id).length).toBeGreaterThanOrEqual(4);
    await manage.execute({ action: 'stop', id }, ctx());
    expect(await store.get('routines', id)).toBeNull();
    expect(await store.get('monitorState', id)).toBeNull();
    expect((await manage.execute({ action: 'stop', id }, ctx())).isError).toBe(true);
  });
});

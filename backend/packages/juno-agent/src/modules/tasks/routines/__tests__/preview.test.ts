import { describe, expect, it } from 'vitest';
import type { Agent, Conversation, Routine } from '@agent-desktop/public-contracts';
import type { Enqueuer, Tool, ToolContext, WakeEvent } from '../../../../contracts/index.js';
import { createMemoryBlobStore } from '../../../../testing/blobs.js';
import { createMemoryStore } from '../../../../testing/store.js';
import { createStateUpdateTool } from '../../../tools/tools/stateUpdate.js';
import { PREVIEW_CHOICES_ID, PREVIEW_OFF, PREVIEW_ON, describeWouldHave, finishTrialRun, previewKind, previewLine, previewOfWake, previewRefusal, raisePreviewCard, settlePreviewQuestion } from '../preview.js';

const OWNER = 'owner-prev';
const NOW = '2026-11-01T10:00:00.000Z';

const enqueuer: Enqueuer = { enqueue: async () => ({ accepted: true }), stopRun: async () => {}, resolveAwakeable: async () => {}, scheduleRoutine: async () => {} };
const agent: Agent & { ownerId: string } = {
  id: 'juno', ownerId: OWNER, createdBy: OWNER, name: 'Juno', handle: 'juno', avatar: { shape: 'circle', color: 1, eyes: 'happy' }, title: 'QA', status: 'idle', section: 'Agents',
  pinned: false, lastActivity: 'idle', unreadCount: 0,
  model: { planner: { provider: 'f', model: 'f' }, computer: { provider: 'f', model: 'f' }, fast: { provider: 'f', model: 'f' } },
  channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdAt: NOW, updatedAt: NOW,
};
const conversation: Conversation = { id: 'chat', kind: 'direct', agentIds: ['juno'], memberIds: [OWNER], unreadCount: 0, lastItemAt: NOW, createdAt: NOW };
const routine = (change: Partial<Routine> = {}): Routine => ({
  id: 'rtn', agentId: 'juno', name: 'AI news', instructions: 'post news', trigger: { kind: 'schedule', cron: '0 9 * * *', human: 'daily', tz: 'UTC' },
  delivery: { channel: 'chat', target: 'chat' }, notify: { mode: 'always' }, enabled: true, status: 'active', runs: [], createdAt: NOW, ...change,
});
const run = (id: string, change: Record<string, unknown> = {}) => ({
  id, agentId: 'juno', conversationId: 'chat', title: 't', status: 'running' as const, kind: 'routine' as const, steps: [],
  usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 }, startedAt: NOW, lastActivityAt: NOW, ...change,
});
const wakeOf = (change: Partial<WakeEvent>): WakeEvent => ({
  id: 'w', ownerId: OWNER, agentId: 'juno', sessionKey: 'juno:chat', conversationId: 'chat', kind: 'user_message', origin: { type: 'user', id: OWNER },
  trusted: true, priority: 'user', payload: {}, at: NOW, status: 'accepted', ...change,
});
const mcp = (access: 'read' | 'action'): Pick<Tool, 'name' | 'mcp' | 'origin'> => ({ name: 'mail_send', mcp: true, origin: { connectionId: 'c', connectionName: 'Gmail', toolName: 'send_email', title: 'Send email', access } });

async function setup() {
  const store = createMemoryStore();
  await store.put('agents', agent);
  await store.put('conversations', conversation);
  return store;
}

describe('which calls a trial run does not make', () => {
  it('stops the speaking tools and connector changes, and lets reads and the agent’s own notes through', () => {
    for (const name of ['send_message', 'feed_post', 'post_to_room', 'message_agent', 'send_file']) expect(previewKind({ name })).toBe('say');
    expect(previewKind({ name: 'artifact_publish' })).toBe('do');
    expect(previewKind(mcp('action'))).toBe('do');
    expect(previewKind(mcp('read'))).toBeUndefined();
    for (const name of ['web_fetch', 'memory_note', 'todo_write', 'computer_shell']) expect(previewKind({ name })).toBeUndefined();
  });

  it('says in one plain line what each call would have done', () => {
    expect(describeWouldHave({ name: 'send_message' }, { kind: 'text', text: 'Chip launch   moved to Friday' })).toBe('a message "Chip launch moved to Friday"');
    expect(describeWouldHave({ name: 'feed_post' }, { title: 'AI news today' })).toBe('a Feed post "AI news today"');
    expect(describeWouldHave(mcp('action'), {})).toBe('Gmail · Send email');
    expect(previewLine('AI news', [{ tool: 'send_message', kind: 'say', summary: 'a message "hi"', at: NOW }, { tool: 'feed_post', kind: 'say', summary: 'a Feed post "x"', at: NOW }])).toBe('Trial run of AI news: it would have sent a message "hi" (and 1 more). Turn it on?');
    expect(previewLine('AI news', [])).toBe('Trial run of AI news: nothing to send this time. Turn it on?');
  });
});

describe('a routine made by the agent on its own starts on trial', () => {
  const create = async (sendOnly: boolean) => {
    const store = await setup();
    const tool = createStateUpdateTool({ store, enqueuer });
    const ctx: ToolContext = {
      ownerId: OWNER, agentId: 'juno', conversationId: 'chat', runId: 'run', store, blobs: createMemoryBlobStore(), enqueuer, wake: wakeOf({}),
      step: async (_name, fn) => fn(), signal: new AbortController().signal, ...(sendOnly ? { sendOnly } : {}),
    };
    const result = await tool.execute({ target: 'routine', action: 'create', name: 'News', prompt: 'post news', schedule: '0 9 * * *' }, ctx);
    return { result, routines: (await store.list('routines', { limit: 10 })).items };
  };

  it('is on trial when the run nobody waits on made it, and the model is told', async () => {
    const { result, routines } = await create(true);
    expect(routines[0]?.preview).toEqual({});
    expect(JSON.stringify(result.content)).toContain('starts on trial');
  });

  it('is not on trial when the person was in the run', async () => {
    const { result, routines } = await create(false);
    expect(routines[0]?.preview).toBeUndefined();
    expect(JSON.stringify(result.content)).not.toContain('trial');
  });
});

describe('a run on trial', () => {
  it('belongs to a routine still on trial, and so do the runs that continue it', async () => {
    const store = await setup();
    await store.put('routines', { ...routine(), preview: {} });
    await store.put('runs', run('parent', { preview: true }));
    const routineWake = wakeOf({ kind: 'routine', origin: { type: 'automation', id: 'rtn' }, payload: { routineId: 'rtn' } });
    expect(await previewOfWake(store, routineWake)).toBe(true);
    expect(await previewOfWake(store, wakeOf({ kind: 'subagent_task', payload: { parentRunId: 'parent' } }))).toBe(true);
    expect(await previewOfWake(store, wakeOf({ kind: 'task_done', payload: { originRunId: 'parent' } }))).toBe(true);
    expect(await previewOfWake(store, wakeOf({ kind: 'user_message' }))).toBe(false);
    await store.patch('routines', 'rtn', { preview: undefined });
    expect(await previewOfWake(store, routineWake)).toBe(false);
  });

  it('records what it would have done on the run that started the work, and runs everything else', async () => {
    const store = await setup();
    await store.put('runs', run('root', { preview: true }));
    await store.put('runs', run('child', { preview: true, rootRunId: 'root' }));
    await store.put('runs', run('plain'));
    const send = { name: 'send_message' };
    expect(await previewRefusal(store, 'root', send, { kind: 'text', purpose: 'result', text: 'hello' })).toMatchObject({ details: { previewed: true } });
    expect(await previewRefusal(store, 'child', mcp('action'), {})).not.toBeNull();
    expect(await previewRefusal(store, 'root', { name: 'web_fetch' }, {})).toBeNull();
    expect(await previewRefusal(store, 'plain', send, { text: 'hello' })).toBeNull();
    expect((await store.get('runs', 'root'))?.wouldHave?.map((entry) => [entry.kind, entry.summary])).toEqual([['say', 'a message "hello"'], ['do', 'Gmail · Send email']]);
    expect((await store.get('runs', 'plain'))?.wouldHave).toBeUndefined();
  });
});

describe('the trial card', () => {
  const trial = async () => {
    const store = await setup();
    await store.put('routines', { ...routine(), preview: {} });
    await store.put('runs', run('r1', { preview: true, wouldHave: [{ tool: 'send_message', kind: 'say', summary: 'a message "hi"', at: NOW }] }));
    await store.put('runs', run('r2', { preview: true }));
    return store;
  };

  it('is one plain question in the routine’s chat, and a second trial run does not stack another', async () => {
    const store = await trial();
    expect(await finishTrialRun(store, OWNER, 'rtn', 'r1')).toBe('Trial run: 1 thing recorded, not done');
    expect(await finishTrialRun(store, OWNER, 'rtn', 'r2')).toBe('Trial run: nothing to send');
    const requests = (await store.list('requests', { limit: 10 })).items;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: 'question', status: 'pending', conversationId: 'chat', summary: 'Trial run of AI news: it would have sent a message "hi". Turn it on?', previewQuestion: { routineId: 'rtn' } });
    expect((await store.list('items', { limit: 10 })).items.filter((item) => item.type === 'request')).toHaveLength(1);
    // Once that card is answered, the next trial run asks again.
    await store.patch('requests', requests[0]?.id ?? '', { status: 'denied' });
    await raisePreviewCard(store, 'rtn', OWNER, 'r2');
    expect((await store.list('requests', { limit: 10 })).items).toHaveLength(2);
  });

  it('is not raised for a run that was not on trial', async () => {
    const store = await trial();
    await store.put('runs', run('plain'));
    expect(await finishTrialRun(store, OWNER, 'rtn', 'plain')).toBeUndefined();
    expect((await store.list('requests', { limit: 10 })).items).toHaveLength(0);
  });

  it.each([[PREVIEW_ON, true], [PREVIEW_OFF, false]])('answer %s ends the trial and leaves the routine enabled=%s', async (answer, enabled) => {
    const store = await trial();
    await finishTrialRun(store, OWNER, 'rtn', 'r1');
    const card = (await store.list('requests', { limit: 10 })).items[0];
    if (card === undefined || card.payload.kind !== 'question') throw new Error('no card');
    const answered = await store.patch('requests', card.id, { status: 'answered', payload: { ...card.payload, answers: { [PREVIEW_CHOICES_ID]: answer } } });
    await settlePreviewQuestion(store, answered);
    await settlePreviewQuestion(store, answered);
    const stored = await store.get('routines', 'rtn');
    expect(stored?.preview).toBeUndefined();
    expect(stored?.enabled).toBe(enabled);
  });

  it('keeps the routine on trial when the card is dismissed', async () => {
    const store = await trial();
    await finishTrialRun(store, OWNER, 'rtn', 'r1');
    const card = (await store.list('requests', { limit: 10 })).items[0];
    if (card === undefined) throw new Error('no card');
    await settlePreviewQuestion(store, await store.patch('requests', card.id, { status: 'denied' }));
    expect((await store.get('routines', 'rtn'))?.preview).toBeDefined();
    expect((await store.get('routines', 'rtn'))?.enabled).toBe(true);
  });
});

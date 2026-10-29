import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, insertDocRow, listenEvents, runReport, toolActivity, transcriptMessages, type Account, type EventListener } from '../harness/client';

/**
 * Posting to the Feed from routines with a real model (BACKEND §3.6.1, §10.10). The agent, not the server, does the right
 * thing: it declares what a routine needs, tells the user what to connect, and posts one digest of new stories only.
 * Assertions check behaviour (routine state, requests, posts, tool calls), never exact wording.
 */

const NOW = new Date().toISOString();
/** E2E_VERBOSE=1 prints what the agent did, to read a run by eye. */
const note = (label: string, value: unknown): void => { if (process.env['E2E_VERBOSE'] === '1') console.info(`[feed-e2e] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`); };

async function agentWithChat(account: Account, name: string): Promise<{ agentId: string; conversationId: string; sessionKey: string }> {
  const agent = await account.api('POST', '/v1/agents', { name });
  expect(agent.status).toBe(201);
  const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
  expect(chat.status).toBe(201);
  return { agentId: agent.body.id, conversationId: chat.body.id, sessionKey: `${agent.body.id}:${chat.body.id}` };
}

const finishedRuns = (events: EventListener, conversationId: string) =>
  events.events.filter((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId);

/** Waits for the next top-level run of the chat (any kind) that finished after `seen` runs had. */
async function nextRun(events: EventListener, account: Account, conversationId: string, seen: number, timeoutMs = 300_000): Promise<{ id: string; kind: string; title: string; status: string }> {
  const hit = await events.waitFor(() => finishedRuns(events, conversationId).length > seen, timeoutMs);
  void hit;
  const run = finishedRuns(events, conversationId)[seen]!.data.metadata.juno.run;
  expect(run.status, await runReport(account, run.id)).toBe('completed');
  return run;
}

const agentTexts = async (account: Account, conversationId: string): Promise<string[]> => {
  const items = await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`);
  return (items.body.items as Array<{ type: string; markdown?: string }>).filter((item) => item.type === 'agent_message').map((item) => item.markdown ?? '');
};

describe('real model: a routine that needs an app the owner has not connected', () => {
  it('is saved as needs_setup with a Connect card and the user is told what to connect; connecting starts it and wakes the agent; disconnecting holds it once', async () => {
    const account = await createAccount('real-gate');
    const events = await listenEvents(account.cookie);
    try {
      const { conversationId, sessionKey } = await agentWithChat(account, 'Mira');
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'Every morning at 8 send me a brief of my day.' }));
      expect(sent.status).toBe(202);
      const first = await nextRun(events, account, conversationId, 0);
      const activity = await toolActivity(sessionKey);

      // The agent saved a routine and declared what it needs; the server held it.
      const routines = (await account.api('GET', '/v1/routines')).body.items as Array<{ id: string; status: string; requires?: unknown[]; missing?: Array<{ options: string[]; label: string }> }>;
      expect(routines, JSON.stringify(activity)).toHaveLength(1);
      const routine = routines[0]!;
      expect(routine.status, JSON.stringify(activity)).toBe('needs_setup');
      expect(routine.requires?.length, JSON.stringify(activity)).toBeGreaterThan(0);
      expect(routine.missing?.length).toBeGreaterThan(0);
      const pending = (await account.api('GET', '/v1/requests?status=pending')).body.items as Array<{ id: string; kind: string; agentId: string; payload: { appIds: string[]; routineId: string } }>;
      const card = pending.find((request) => request.kind === 'connect');
      expect(card?.payload.routineId).toBe(routine.id);
      expect(card?.payload.appIds.length).toBeGreaterThan(0);

      // The user was told what is missing, in the chat; nothing was posted to the Feed.
      const stateUpdate = activity.results.find((result) => result.toolName === 'state_update');
      note('state_update call', activity.calls.filter((call) => call.name === 'state_update'));
      note('state_update result', stateUpdate?.text ?? '');
      expect(stateUpdate?.text).toMatch(/needs_setup/);
      const told = (await agentTexts(account, conversationId)).join('\n');
      note('agent told the user', told);
      expect(told, `run ${first.id}`).toMatch(/calendar|gmail|mail|connect/i);
      expect((await account.api('GET', '/v1/feed')).body.items).toHaveLength(0);

      // Add the first app the card offers (a stored connection), then turn it on for the agent: that change tells the capability gate.
      const catalogId = card!.payload.appIds[0]!;
      const connectionId = `con-e2e-${catalogId}`;
      await insertDocRow('connections', account.userId, { id: connectionId, kind: 'mcp', name: catalogId, status: 'connected', enabled: true, catalogId, createdAt: NOW });
      expect((await account.api('PUT', `/v1/agents/${card!.agentId}/apps/${catalogId}`, { enabled: true, actionsPolicy: 'off' })).status).toBe(200);
      const ready = await nextRun(events, account, conversationId, 1);
      expect(ready.title).toMatch(/^Routine ready/);
      const active = await account.api('GET', `/v1/routines/${routine.id}`);
      expect(active.body.status).toBe('active');
      expect(active.body.missing).toBeUndefined();
      const resolved = await account.api('GET', `/v1/requests/${card!.id}`);
      expect(resolved.body.status).toBe('approved');
      expect((await agentTexts(account, conversationId)).length).toBeGreaterThan(1);
      note('after connect, agent said', (await agentTexts(account, conversationId)).slice(1).join('\n---\n'));

      // Remove it: the routine is on hold again with one new card, and the agent says so.
      expect((await account.api('DELETE', `/v1/apps/${catalogId}/installations/${connectionId}`)).status).toBe(204);
      const lost = await nextRun(events, account, conversationId, 2);
      expect(lost.title).toMatch(/^Routine on hold/);
      expect((await account.api('GET', `/v1/routines/${routine.id}`)).body.status).toBe('needs_setup');
      note('after disconnect, agent said', (await agentTexts(account, conversationId)).slice(2).join('\n---\n'));
      const cards = ((await account.api('GET', '/v1/requests?status=pending')).body.items as Array<{ kind: string }>).filter((request) => request.kind === 'connect');
      expect(cards).toHaveLength(1);
      expect((await account.api('GET', '/v1/feed')).body.items).toHaveLength(0);
    } finally {
      events.close();
    }
  }, 900_000);
});

interface Post { id: string; routineId?: string; title: string; summary: string; body?: string; sourceUrl?: string; imageUrl?: string; imageCaption?: string; createdAt: string }

const feed = async (account: Account): Promise<Post[]> => ((await account.api('GET', '/v1/feed?limit=50')).body.items as Post[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const links = (post: Post): string[] => [...new Set(`${post.body ?? ''}\n${post.sourceUrl ?? ''}`.match(/https?:\/\/[^\s)>\]]+/g) ?? [])];

describe('real model: a news routine', () => {
  it('posts one digest with a source link and several stories, and does not repeat them on the next run', async () => {
    const account = await createAccount('real-news');
    const events = await listenEvents(account.cookie);
    try {
      const { agentId, conversationId } = await agentWithChat(account, 'Newsie');
      const created = await account.api('POST', '/v1/routines', {
        name: 'Tech news', agentId, enabled: true,
        instructions: 'Find the top stories on the Hacker News front page (fetch https://news.ycombinator.com/ with web_fetch, then read the stories you pick) and post one digest to the Feed if there is something new worth seeing.',
        trigger: { kind: 'schedule', cron: '0 * * * * *', human: 'every minute', tz: 'UTC' },
        delivery: { channel: 'chat', target: conversationId }, notify: { mode: 'never' },
      });
      expect(created.status).toBe(201);
      const routineId: string = created.body.id;
      const routineRuns = (): number => finishedRuns(events, conversationId).filter((e) => e.data.metadata.juno.run.kind === 'routine').length;

      await events.waitFor(() => routineRuns() >= 1, 360_000);
      await account.api('POST', `/v1/routines/${routineId}/toggle`, { enabled: false });
      const firstPosts = await feed(account);
      expect(firstPosts, 'exactly one digest post for the first run').toHaveLength(1);
      const digest = firstPosts[0]!;
      note('first digest', digest);
      expect(digest.routineId).toBe(routineId);
      expect(digest.sourceUrl, JSON.stringify(digest)).toMatch(/^https?:\/\//);
      expect(links(digest).length, 'a digest links its stories: ' + (digest.body ?? '')).toBeGreaterThanOrEqual(2);
      expect(digest.title.length).toBeLessThanOrEqual(80);
      if (digest.imageUrl !== undefined) expect(digest.imageCaption, 'a picture comes with a caption').toBeTruthy();

      // Second run: whatever it posts must be new.
      await account.api('POST', `/v1/routines/${routineId}/toggle`, { enabled: true });
      await events.waitFor(() => routineRuns() >= 2, 360_000);
      await account.api('POST', `/v1/routines/${routineId}/toggle`, { enabled: false });
      const all = await feed(account);
      note('second run posts', all.slice(1));
      // The second run was told what the first one posted (that list is what keeps a real model from repeating itself).
      const wakes = (await transcriptMessages(`${agentId}:${conversationId}`)).filter((message) => message.role === 'user').map((message) => message.text);
      expect(wakes.some((text) => text.includes('do not repeat these stories') && text.includes(JSON.stringify(digest.title).slice(1, -1))), 'the second run note lists the first digest').toBe(true);
      const earlier = new Set(links(digest));
      for (const post of all.slice(1)) {
        expect(post.sourceUrl === undefined || !earlier.has(post.sourceUrl), `repeated lead story ${post.sourceUrl}`).toBe(true);
        expect(post.title).not.toBe(digest.title);
      }
      const repeated = all.slice(1).flatMap((post) => links(post)).filter((url) => earlier.has(url));
      expect(repeated, 'links already posted by the first run').toEqual([]);
    } finally {
      events.close();
    }
  }, 900_000);
});

describe('real model: a routine with genuinely nothing to report (BACKEND §3.3b)', () => {
  it('ends quietly: no message in the chat, no unread, no post, and the task says why', async () => {
    const account = await createAccount('real-quiet');
    const events = await listenEvents(account.cookie);
    try {
      const { agentId, conversationId, sessionKey } = await agentWithChat(account, 'Watcher');
      const created = await account.api('POST', '/v1/routines', {
        name: 'Product watch', agentId, enabled: true,
        instructions: 'Fetch https://example.com/ with web_fetch. Only if that page announces a product called "Zephyrite 9", post it to the Feed. Otherwise there is nothing to report, and I do not want to be disturbed.',
        trigger: { kind: 'schedule', cron: '0 * * * * *', human: 'every minute', tz: 'UTC' },
        delivery: { channel: 'chat', target: conversationId }, notify: { mode: 'always' },
      });
      expect(created.status).toBe(201);
      const routineId: string = created.body.id;
      await events.waitFor(() => finishedRuns(events, conversationId).some((e) => e.data.metadata.juno.run.kind === 'routine'), 360_000);
      await account.api('POST', `/v1/routines/${routineId}/toggle`, { enabled: false });
      const run = finishedRuns(events, conversationId).find((e) => e.data.metadata.juno.run.kind === 'routine')!.data.metadata.juno.run;
      expect(run.status, await runReport(account, run.id)).toBe('completed');

      const activity = await toolActivity(sessionKey);
      const quiet = activity.results.filter((result) => result.toolName === 'finish_quietly');
      note('tool calls', activity.calls.map((call) => call.name === 'tool_call' ? String(call.arguments['name']) : call.name));
      note('finish_quietly results', quiet);
      expect(quiet.length, JSON.stringify(activity.calls)).toBeGreaterThan(0);
      expect(quiet.every((result) => !result.isError), JSON.stringify(quiet)).toBe(true);
      // Nothing reached the person: no message of any kind from the agent, no post, nothing unread.
      expect(await agentTexts(account, conversationId), await runReport(account, run.id)).toEqual([]);
      expect((await account.api('GET', '/v1/feed')).body.items).toHaveLength(0);
      expect((await account.api('GET', `/v1/conversations/${conversationId}`)).body.unreadCount).toBe(0);
      // The task list says why.
      const tasks = (await account.api('GET', '/v1/tasks?routineId=' + routineId)).body.items as Array<{ id: string; status: string; resultLine?: string }>;
      const ended = tasks.find((task) => task.id === run.id);
      note('task result', ended?.resultLine ?? '');
      expect(ended?.resultLine ?? '', JSON.stringify(tasks)).toMatch(/^Nothing to report: \S/);
    } finally {
      events.close();
    }
  }, 900_000);
});

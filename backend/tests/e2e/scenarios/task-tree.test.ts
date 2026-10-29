import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, execStack, listenEvents, scriptedChat, scriptModel, toolCall, type Account } from '../harness/client';

/**
 * The task tree (BACKEND 6.5), end to end: an owner message that starts a delegated child and a background shell command is ONE tree
 * under its chat run with the owner's message as origin; a background connector call whose stop never reached the call reads as
 * `unknown_effect`; a routine's run is a task of its own, started by the routine and delivered to its chat; and the statuses a client
 * rebuilds by replaying `/v1/events` from the start are the statuses the list reports.
 */
interface Task {
  id: string; kind: string; status: string; outcome?: string; outcomeDetail?: string; parentId?: string; rootRunId: string; depth: number;
  origin: { type: string; conversationId?: string; routineId?: string }; mode: string; replyTo: { type: string; channel?: string; target?: string };
  routineId?: string; title: string;
}
interface Tree { rootRunId: string; origin: Task['origin']; items: Task[]; subtreeUsage: { steps: number } }

async function tasksOf(account: Account, query: string): Promise<Task[]> {
  const res = await account.api('GET', '/v1/tasks?' + query);
  expect(res.status).toBe(200);
  return res.body.items as Task[];
}

describe('task tree', () => {
  it('shows a chat, its child, command, connector call and a routine run as trees, and replaying the events reaches the same statuses', async () => {
    const account = await createAccount('task-tree');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Planner' });
      expect(agent.status).toBe(201);
      expect((await account.api('POST', '/v1/computers/ensure', { agentId: agent.body.id })).status).toBeLessThan(300);

      // 1. One owner message: a child that reports back by itself, and a command that keeps running.
      const ack = `TREE-ACK-${randomUUID().slice(0, 8)}`;
      const { conversationId } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-spawn', 'child_spawn', { prompt: 'look up fares', title: 'Look up fares', notify: true }), toolCall('call-shell', 'shell.start', { command: 'fake:exit 0 after 600000', title: 'Dev server' })] },
        { text: ack },
        { text: ack },
      ], 'find me fares and start the dev server');
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.kind === 'background' && String(e.data.metadata.juno.run.title) === 'Look up fares', 45_000);

      let mine: Task[] = [];
      for (let i = 0; i < 40 && !(mine.some((t) => t.kind === 'subagent' && t.status === 'ended') && mine.some((t) => t.kind === 'command')); i += 1) {
        mine = await tasksOf(account, 'conversationId=' + conversationId);
        if (i > 0) await new Promise((r) => setTimeout(r, 250));
      }
      const child = mine.find((t) => t.kind === 'subagent');
      const command = mine.find((t) => t.kind === 'command');
      expect(child).toMatchObject({ title: 'Look up fares', status: 'ended', outcome: 'done', depth: 1, mode: 'background', replyTo: { type: 'session' } });
      expect(command).toMatchObject({ title: 'Dev server', status: 'running', depth: 1, mode: 'background', replyTo: { type: 'none' } });
      expect(command?.parentId).toBeDefined();
      expect(child?.rootRunId).toBe(command?.rootRunId);
      expect(child?.parentId).toBe(command?.parentId);
      expect(child?.origin).toEqual({ type: 'owner_message', conversationId, itemId: expect.any(String) });
      expect(command?.origin).toEqual(child?.origin);

      // 2. A background connector call that was only marked stopped (nothing cancelled it): the effect is unknown, not "cancelled".
      const at = new Date().toISOString();
      const mcpId = 'mcp-tree-' + randomUUID().slice(0, 8);
      const job = { id: mcpId, ownerId: account.userId, agentId: agent.body.id, conversationId, runId: command?.parentId, rootRunId: command?.rootRunId, kind: 'mcp', label: 'crm.update_deal', title: 'Update the deal', notify: false, chainId: 'chain', generation: 0, status: 'running', startedAt: at };
      await execStack('INSERT INTO background_tasks (id, owner_id, agent_id, conversation_id, run_id, status, kind, at, doc) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::text::jsonb)',
        [mcpId, account.userId, agent.body.id, conversationId, String(command?.parentId), 'running', 'mcp', at, JSON.stringify(job)]);
      const stopped = await account.api('POST', `/v1/tasks/${mcpId}/stop`);
      expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
      expect(stopped.body).toMatchObject({ id: mcpId, kind: 'connector', status: 'ended', outcome: 'unknown_effect', outcomeDetail: 'stop_unconfirmed' });

      // 3. One tree under the chat run, reachable from any task in it, with the owner's message as its origin. The plain chat run is not a task.
      const treeRes = await account.api('GET', `/v1/tasks/${child?.id}/tree`);
      expect(treeRes.status).toBe(200);
      const tree = treeRes.body as Tree;
      expect(tree.rootRunId).toBe(child?.rootRunId);
      expect(tree.origin).toEqual(child?.origin);
      expect(tree.items.map((t) => [t.kind, t.id]).sort()).toEqual([['command', command?.id], ['connector', mcpId], ['subagent', child?.id]].sort());
      expect(tree.subtreeUsage.steps).toBeGreaterThan(0);
      expect((await account.api('GET', `/v1/tasks/${mcpId}/tree`)).body.rootRunId).toBe(tree.rootRunId);

      // 4. A routine run is a task of its own: started by the routine, delivered to its chat.
      const delivery = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      const digest = `TREE-DIGEST-${randomUUID().slice(0, 8)}`;
      scriptModel(`${agent.body.id}:${delivery.body.id}`, [{ text: digest }, { text: digest }, { text: digest }]);
      const routine = await account.api('POST', '/v1/routines', {
        name: 'Tree digest', agentId: agent.body.id, instructions: 'post the digest', enabled: true,
        trigger: { kind: 'schedule', cron: '*/5 * * * * *', human: 'every 5 seconds', tz: 'UTC' },
        delivery: { channel: 'chat', target: delivery.body.id }, notify: { mode: 'never' },
      });
      expect(routine.status).toBe(201);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === delivery.body.id && String(e.data.item.markdown).includes(digest), 45_000);
      expect((await account.api('POST', `/v1/routines/${routine.body.id}/toggle`, { enabled: false })).status).toBeLessThan(300);
      let fired: Task[] = [];
      for (let i = 0; i < 40 && !fired.some((t) => t.status === 'ended'); i += 1) {
        fired = await tasksOf(account, 'routineId=' + routine.body.id);
        if (i > 0) await new Promise((r) => setTimeout(r, 250));
      }
      const routineRun = fired.find((t) => t.status === 'ended');
      expect(routineRun).toMatchObject({
        kind: 'routine', mode: 'scheduled', outcome: 'done', depth: 0, routineId: routine.body.id,
        origin: { type: 'routine', routineId: routine.body.id }, replyTo: { type: 'delivery', channel: 'chat', target: delivery.body.id },
      });
      expect(routineRun?.parentId).toBeUndefined();
      expect((await account.api('GET', `/v1/tasks/${routineRun?.id}/tree`)).body.items.map((t: Task) => t.id)).toContain(routineRun?.id);

      // 5. Another owner sees none of it.
      const stranger = await createAccount('task-tree-other');
      expect(await tasksOf(stranger, '')).toEqual([]);
      expect((await stranger.api('GET', `/v1/tasks/${child?.id}/tree`)).status).toBe(404);

      // 6. Replaying /v1/events from the start rebuilds the same statuses the list reports.
      const everything = await tasksOf(account, 'limit=200');
      const replay = await listenEvents(account.cookie, undefined, 0);
      try {
        const lastSeen = (): Map<string, string> => {
          const seen = new Map<string, string>();
          for (const e of replay.events) if (e.data.type === 'task.updated') seen.set(e.data.task.id, `${e.data.task.status}/${e.data.task.outcome ?? ''}/${e.data.task.outcomeDetail ?? ''}`);
          return seen;
        };
        const expected = everything.map((t) => [t.id, `${t.status}/${t.outcome ?? ''}/${t.outcomeDetail ?? ''}`] as const);
        for (let i = 0; i < 60 && !expected.every(([id, status]) => lastSeen().get(id) === status); i += 1) await new Promise((r) => setTimeout(r, 250));
        const seen = lastSeen();
        for (const [id, status] of expected) expect(seen.get(id), id).toBe(status);
        expect(expected.length).toBeGreaterThanOrEqual(4);
      } finally {
        replay.close();
      }
    } finally {
      events.close();
    }
  });
});

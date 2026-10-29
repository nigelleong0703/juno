import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createAccount, insertDocRow, listenEvents, modelCalls, queryStack, scriptedChat, toolActivity, toolCall, transcriptTexts } from '../harness/client';

/**
 * Agent-created monitors (BACKEND 3.6.3): the owner asks, the agent makes a watch with monitor_create on a read-only connector
 * tool, the creation check records what exists silently, and the server (not the model) checks from then on. A new item wakes
 * the agent once in the chat where the monitor was made, with the item as untrusted data; a check with nothing new wakes nobody.
 * The checks are driven with "check now" so the test does not wait for a timer.
 */

interface Issue { id: number; title: string }

/** A minimal streamable-HTTP MCP server with one read tool, `list_issues`, over a list the test can grow. */
async function fakeTracker(issues: Issue[], calls: { list: number }): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method !== 'POST') { response.statusCode = 204; response.end(); return; }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string; params?: { name?: string } };
      const reply = (result: unknown): void => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); };
      if (message.method === 'initialize') return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'tracker', version: '1' } });
      if (message.method === 'tools/list') {
        return reply({ tools: [{ name: 'list_issues', description: 'List the open issues of a repository.', inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] }, annotations: { readOnlyHint: true } }] });
      }
      if (message.method === 'tools/call') {
        calls.list += 1;
        return reply({ content: [{ type: 'text', text: JSON.stringify({ issues }) }] });
      }
      response.statusCode = 202;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp` };
}

describe('monitor', () => {
  it('baselines silently, wakes the agent once for a new item in the creating chat, and stays quiet when nothing changed', async () => {
    const account = await createAccount('monitor');
    const events = await listenEvents(account.cookie);
    const issues: Issue[] = [{ id: 1, title: 'Old issue one' }, { id: 2, title: 'Old issue two' }];
    const calls = { list: 0 };
    const tracker = await fakeTracker(issues, calls);
    try {
      await insertDocRow('connections', account.userId, {
        id: `con-e2e-tracker-${account.userId.slice(0, 12)}`, kind: 'mcp', name: 'Tracker', status: 'connected', enabled: true, permission: 'full',
        endpoint: tracker.url, transport: 'http', createdAt: new Date().toISOString(),
      });
      const agent = await account.api('POST', '/v1/agents', { name: 'Watcher' });
      expect(agent.status).toBe(201);
      const alert = `ALERT-${randomUUID().slice(0, 8)}`;
      const { conversationId, sessionKey } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-monitor', 'monitor_create', {
          name: 'New issues in acme/app', prompt: 'Tell me about any new issue', tool: 'tracker_list_issues', args: { repo: 'acme/app' }, items: 'issues', id: 'id',
        })] },
        { text: 'I am watching acme/app and will only message you when a new issue appears.' },
        { text: alert },
      ], 'tell me when a new issue appears in acme/app');

      // Creation: one proving check, nothing fired, a monitor routine that points back at this chat.
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId, 60_000);
      const created = await toolActivity(sessionKey);
      const result = created.results.find((entry) => entry.toolName === 'monitor_create');
      expect(result?.isError, result?.text).toBe(false);
      expect(calls.list).toBe(1);
      const listed = (await account.api('GET', '/v1/routines')).body.items as Array<{ id: string; trigger: { kind: string; tool: string; items: string; id: string }; delivery: { target: string }; monitor: { failures: number; lastMatchAt?: string } }>;
      const monitor = listed.find((routine) => routine.trigger.kind === 'check');
      expect(monitor?.trigger).toMatchObject({ tool: 'tracker_list_issues', items: 'issues', id: 'id' });
      expect(monitor?.delivery.target).toBe(conversationId);
      expect(monitor?.monitor.lastMatchAt).toBeUndefined();
      const id = monitor?.id ?? '';
      // The next check is already scheduled with the routine timer (30 minutes out), not waiting on the model.
      let scheduled = false;
      for (let attempt = 0; attempt < 20 && !scheduled; attempt += 1) {
        const pending = await queryStack("SELECT key, not_before FROM invocations WHERE service = 'RoutineTimer' AND handler = 'fire' AND status = 'pending'");
        scheduled = pending.some((row) => row['key'] === id && Number(row['not_before']) - Date.now() > 20 * 60_000);
        if (!scheduled) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(scheduled, 'the next check is armed about 30 minutes out').toBe(true);
      const callsAfterCreate = modelCalls(sessionKey);

      // Nothing new: the check runs, the agent is not woken.
      const quiet = await account.api('POST', `/v1/routines/${id}/check`);
      expect(quiet.status, JSON.stringify(quiet.body)).toBe(200);
      expect(quiet.body.outcome).toBe('nothing_new');
      expect(calls.list).toBe(2);

      // A new issue appears: one wake into this chat, and the agent's reply is the one message.
      issues.unshift({ id: 3, title: `Login page crashes ${alert}` });
      const found = await account.api('POST', `/v1/routines/${id}/check`);
      expect(found.body.outcome).toBe('woke');
      const reply = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(alert), 60_000);
      const run = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === reply.data.item.runId, 60_000);
      expect(run.data.metadata.juno.run.kind).toBe('routine');
      expect(String(run.data.metadata.juno.run.title)).toMatch(/^Monitor:/);
      // The model saw the new item (and only it) as untrusted data.
      const transcript = (await transcriptTexts(sessionKey)).join('\n');
      expect(transcript).toContain('<untrusted>');
      expect(transcript).toContain('Login page crashes');
      expect(transcript).not.toContain('Old issue one');
      expect(found.body.routine.monitor.lastMatchAt).toBeDefined();

      // The same list again: nothing new, so no second wake and no further model call.
      const callsAfterWake = modelCalls(sessionKey);
      expect(callsAfterWake).toBeGreaterThan(callsAfterCreate);
      const again = await account.api('POST', `/v1/routines/${id}/check`);
      expect(again.body.outcome).toBe('nothing_new');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(modelCalls(sessionKey)).toBe(callsAfterWake);
      const started = events.events.filter((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.kind === 'routine');
      expect(started).toHaveLength(1);
      expect(events.events.filter((e) => e.data.type === 'item.added' && String(e.data.item.markdown ?? '').includes(alert))).toHaveLength(1);

      // The owner can pause it, and a paused monitor is not checked.
      expect((await account.api('POST', `/v1/routines/${id}/toggle`, { enabled: false })).status).toBe(200);
      expect((await account.api('POST', `/v1/routines/${id}/check`)).status).toBe(409);
      // A monitor is made by the agent: creating one through the routine API is refused.
      const direct = await account.api('POST', '/v1/routines', {
        name: 'x', agentId: agent.body.id, trigger: { kind: 'check', everyMinutes: 30, human: 'Every 30 minutes', tool: 'tracker_list_issues', args: {} },
      });
      expect(direct.status).toBe(400);
    } finally {
      events.close();
      await new Promise<void>((resolve) => tracker.server.close(() => resolve()));
    }
  }, 180_000);
});

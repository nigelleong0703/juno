import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, request, scriptModel, scriptedChat, toolCall } from '../harness/client';

/**
 * Agent status is computed, never stored (BACKEND §10.7): working (with a "doing" line from the in-progress
 * todo) / needs_you / paused / idle come from the agent's runs, pending requests and pause, are returned by
 * GET /v1/agents[/:id], and are pushed as `agent.status` snapshots. Pause drops automation wakes but not the
 * user's messages; stop-all stops every active run of the agent.
 */
describe('agent status', () => {
  it('shows working with the in-progress todo, and stop-all returns the agent to idle', async () => {
    const account = await createAccount('status-working');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Busy' });
      expect(agent.status).toBe(201);
      expect(agent.body.status).toBe('idle');
      const agentId: string = agent.body.id;
      const isStatus = (status: string) => (e: { data: { type: string; agentId?: string; status?: string } }) =>
        e.data.type === 'agent.status' && e.data.agentId === agentId && e.data.status === status;

      await scriptedChat(account, agentId, [
        { toolCalls: [toolCall('call-plan', 'todo_write', { todos: [{ id: 'draft', content: 'Draft the quarterly report', status: 'in_progress' }] })] },
        { toolCalls: [toolCall('call-wait', 'wake_at', { when: '+30s' })] },
        { text: 'never' },
      ], 'start the quarterly report');

      const working = await events.waitFor((e) => isStatus('working')(e) && e.data.doing === 'Draft the quarterly report', 30_000);
      expect(working.data.doing).toBe('Draft the quarterly report');
      const read = await account.api('GET', `/v1/agents/${agentId}`);
      expect(read.body.status).toBe('working');
      expect(read.body.doing).toBe('Draft the quarterly report');
      const listed = (await account.api('GET', '/v1/agents')).body.items.find((a: { id: string }) => a.id === agentId);
      expect(listed.status).toBe('working');

      // A PATCH cannot set the derived status.
      const patched = await account.api('PATCH', `/v1/agents/${agentId}`, { status: 'error', title: 'Reporter' });
      expect(patched.status).toBe(200);
      expect(patched.body.title).toBe('Reporter');
      expect(patched.body.status).toBe('working');

      const stop = await account.api('POST', `/v1/agents/${agentId}/stop`);
      expect(stop.status).toBe(200);
      expect(stop.body.stopped).toBe(1);
      await events.waitFor((e) => isStatus('idle')(e) && e.id > working.id, 30_000);
      const after = await account.api('GET', `/v1/agents/${agentId}`);
      expect(after.body.status).toBe('idle');
      expect(after.body.doing).toBeUndefined();
      expect((await account.api('POST', `/v1/agents/${agentId}/stop`)).body.stopped).toBe(0);
    } finally {
      events.close();
    }
  });

  it('shows needs_you while a request is pending and idle once it is decided', async () => {
    const account = await createAccount('status-needs-you');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Careful' });
      const agentId: string = agent.body.id;
      await account.api('POST', '/v1/rules', {
        description: 'Ask before listing agents', scope: 'action', behavior: 'ask', subject: 'agent_directory', enabled: true,
      });
      const done = `DONE-${randomUUID().slice(0, 8)}`;
      await scriptedChat(account, agentId, [
        { toolCalls: [toolCall('call-dir', 'agent_directory')] },
        { text: done },
      ], 'who else is on the team?');

      const needsYou = await events.waitFor((e) => e.data.type === 'agent.status' && e.data.agentId === agentId && e.data.status === 'needs_you', 30_000);
      const read = await account.api('GET', `/v1/agents/${agentId}`);
      expect(read.body.status).toBe('needs_you');
      expect(read.body.needsYou).toBe(1);

      const created = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.agentId === agentId, 30_000);
      expect((await account.api('POST', `/v1/requests/${created.data.request.id}/resolve`, { action: 'approve' })).status).toBe(200);
      await events.waitFor((e) => e.data.type === 'agent.status' && e.data.agentId === agentId && e.data.status === 'idle' && e.id > needsYou.id, 30_000);
      const after = await account.api('GET', `/v1/agents/${agentId}`);
      expect(after.body.status).toBe('idle');
      expect(after.body.needsYou).toBe(0);
    } finally {
      events.close();
    }
  });

  it('pauses: automation wakes are dropped, the user still gets answers, resume restores it', async () => {
    const account = await createAccount('status-pause');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Pausable' });
      const agentId: string = agent.body.id;
      const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agentId] });
      const conversationId: string = chat.body.id;
      const userReply = `USER-${randomUUID().slice(0, 8)}`;
      scriptModel(`${agentId}:${conversationId}`, [{ text: userReply }, { text: 'routine ran' }]);
      const routine = await account.api('POST', '/v1/routines', {
        name: 'Inbound', agentId, instructions: 'react', enabled: true,
        trigger: { kind: 'webhook', url: 'pending', secretMasked: '' },
        delivery: { channel: 'chat', target: conversationId }, notify: { mode: 'never' },
      });
      expect(routine.status).toBe(201);
      const issued = await account.api('POST', `/v1/routines/${routine.body.id}/webhook`);
      const hook = () => request('POST', `/v1/hooks/${routine.body.id}?key=${issued.body.secret}`, { type: 'ping' });

      const other = await createAccount('status-pause-other');
      expect((await other.api('POST', `/v1/agents/${agentId}/pause`)).status).toBe(404);
      expect((await other.api('POST', `/v1/agents/${agentId}/resume`)).status).toBe(404);
      expect((await other.api('POST', `/v1/agents/${agentId}/stop`)).status).toBe(404);

      const paused = await account.api('POST', `/v1/agents/${agentId}/pause`);
      expect(paused.status).toBe(200);
      expect(paused.body.status).toBe('paused');
      expect(typeof paused.body.pausedAt).toBe('string');
      await events.waitFor((e) => e.data.type === 'agent.status' && e.data.agentId === agentId && e.data.status === 'paused', 30_000);
      expect((await account.api('GET', `/v1/agents/${agentId}`)).body.status).toBe('paused');

      // The webhook is accepted by the gateway but the paused agent's session drops it: no run starts (its creation greeting aside).
      expect((await hook()).status).toBe(202);
      await new Promise((r) => setTimeout(r, 4_000));
      expect(events.events.some((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.agentId === agentId && e.data.metadata.juno.run.title !== 'Getting started')).toBe(false);

      // The user's own message still runs, and the agent is paused again afterwards.
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'are you there?' }));
      expect(sent.status).toBe(202);
      const reply = await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes(userReply), 30_000);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === reply.data.item.runId, 30_000);
      await events.waitFor((e) => e.data.type === 'agent.status' && e.data.agentId === agentId && e.data.status === 'paused' && e.id > reply.id, 30_000);

      const resumed = await account.api('POST', `/v1/agents/${agentId}/resume`);
      expect(resumed.status).toBe(200);
      expect(resumed.body.status).toBe('idle');
      expect(resumed.body.pausedAt).toBeUndefined();
      const resumedAt = events.events.at(-1)?.id ?? 0;
      expect((await hook()).status).toBe(202);
      // After resume the same webhook starts a run in the delivery chat.
      await events.waitFor((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId && e.id > resumedAt, 30_000);
    } finally {
      events.close();
    }
  });
});

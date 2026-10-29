import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { childSessionKey, createAccount, listenEvents, listItems, listRuns, runReport, toolActivity, transcriptMessages, type Account } from '../harness/client';

/**
 * Sub-tasks with a real model (product form A): the main agent dispatches helpers with child_spawn,
 * the results come back to the main agent, and a child can never reach the user. Assertions check
 * run rows, events, items and tool calls, never wording.
 */
/** Everything needed to see why a parent run did not complete: its own report plus each child's report and transcript. */
async function parentDiagnosis(account: Account, agentId: string, conversationId: string, parentRunId: string): Promise<string> {
  const children = (await listRuns(account, conversationId)).filter((run) => run.parentRunId === parentRunId);
  const parts = [await runReport(account, parentRunId)];
  for (const child of children) {
    parts.push(`child ${await runReport(account, child.id)} transcript ${JSON.stringify(await transcriptMessages(childSessionKey(agentId, conversationId, child.id)))}`);
  }
  return parts.join('\n');
}

describe('real model: sub-tasks', () => {
  it('runs two sub-tasks in parallel and the main agent posts the final reply', async () => {
    const account = await createAccount('real-sub-a1');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Lead' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, {
        text:
          'I need two independent lookups done in parallel by sub-tasks. Do exactly this and nothing else: ' +
          '(1) call the child_spawn tool twice in your very first turn, before anything else: once with prompt "Reply with the single word ALPHA and nothing else." ' +
          'and once with prompt "Reply with the single word BETA and nothing else."; ' +
          '(2) call the child_wait tool to wait for both; ' +
          '(3) when both are done, write me one short sentence that mentions both words. Do the work through the sub-tasks, do not answer them yourself.',
      }));
      expect(sent.status).toBe(202);

      const parentStarted = await events.waitFor(
        (e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId,
        60_000,
      );
      const parentRunId: string = parentStarted.data.metadata.juno.run.id;
      const parentFinished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === parentRunId, 200_000);
      expect(parentFinished.data.metadata.juno.run.status, await parentDiagnosis(account, agent.body.id, conversationId, parentRunId)).toBe('completed');

      const runs = await listRuns(account, conversationId);
      const children = runs.filter((run) => run.parentRunId === parentRunId);
      expect(children.length).toBeGreaterThanOrEqual(2);
      for (const child of children) {
        expect(child.status, await runReport(account, child.id)).toBe('completed');
        expect(String(child.childResult ?? '').length).toBeGreaterThan(0);
      }

      // The results came back to the main agent: it spawned through the tool and then posted its own reply.
      const calls = (await toolActivity(`${agent.body.id}:${conversationId}`)).calls.filter((call) => call.name === 'child_spawn');
      expect(calls.length).toBeGreaterThanOrEqual(2);
      const items = await listItems(account, conversationId);
      const childIds = new Set(children.map((c) => c.id));
      const replies = items.filter((item) => item.type === 'agent_message');
      expect(replies.some((item) => item.runId === parentRunId)).toBe(true);
      expect(replies.some((item) => (item.runId !== undefined && childIds.has(item.runId)))).toBe(false);
    } finally {
      events.close();
    }
  });

  it('keeps a child from reaching the user, a room or another agent', async () => {
    const account = await createAccount('real-sub-a2');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Lead' });
      const other = await account.api('POST', '/v1/agents', { name: 'Peer' });
      expect(agent.status).toBe(201);
      expect(other.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      const conversationId: string = created.body.id;
      // The parent refuses to hand a child an explicit "message the user" order (it knows the boundary), so the
      // child gets a job that can only be finished by asking the user, the peer agent or the chat.
      const childPrompt =
        `Find out which day of the week suits the user for the team lunch, and report the day. The only way to learn it is to ask: the user, the colleague agent ${other.body.id}, or the chat ${conversationId}.`;
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, {
        text:
          'Delegate this to a sub-task: call the child_spawn tool exactly once with this prompt (copy it verbatim between the triple quotes): """' + childPrompt + '""". ' +
          'Then call child_wait to wait for it. After it finished, answer me with one short sentence about what it found.',
      }));
      expect(sent.status).toBe(202);

      const parentStarted = await events.waitFor(
        (e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId,
        60_000,
      );
      const parentRunId: string = parentStarted.data.metadata.juno.run.id;
      const parentFinished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === parentRunId, 200_000);
      // The child's job cannot be finished without asking someone, so it blocks; the parent then ends done or blocked on that child.
      expect(['completed', 'blocked'], await runReport(account, parentRunId)).toContain(parentFinished.data.metadata.juno.run.status);

      const children = (await listRuns(account, conversationId)).filter((run) => run.parentRunId === parentRunId);
      expect(children.length, JSON.stringify([await toolActivity(`${agent.body.id}:${conversationId}`), await listItems(account, conversationId), await transcriptMessages(`${agent.body.id}:${conversationId}`)])).toBeGreaterThanOrEqual(1);
      const child = children[0];
      if (child === undefined) throw new Error('no child run');
      // The child ends either done or blocked ("my instructions forbid this"); both are fine, it must not hang.
      expect(['completed', 'blocked'], await runReport(account, child.id)).toContain(child.status);

      // The child's own working instructions already forbid reaching out, so a real model usually
      // never tries; when it does try, every outbound attempt must come back as a refusal.
      const activity = await toolActivity(childSessionKey(agent.body.id, conversationId, child.id));
      const attempts = activity.results.filter((r) => ['send_message', 'message_agent', 'post_to_room'].includes(r.toolName));
      for (const attempt of attempts) expect(attempt.isError, JSON.stringify(activity)).toBe(true);

      // Nothing the child tried reached anyone: no bubble from the child run, no question request,
      // no run for the other agent, no extra conversation.
      const items = await listItems(account, conversationId);
      const childIds = new Set(children.map((c) => c.id));
      expect(items.filter((item) => item.type === 'agent_message' && (item.runId !== undefined && childIds.has(item.runId)))).toHaveLength(0);
      expect(items.filter((item) => item.type === 'request')).toHaveLength(0);
      // (Creating an agent opens its own direct chat and it greets there, so the other agent ran only its greeting.)
      const otherRuns = await account.api('GET', `/v1/runs?agentId=${other.body.id}&limit=50`);
      expect(otherRuns.body.items.filter((run: { title: string }) => run.title !== 'Getting started')).toHaveLength(0);
      const conversations = await account.api('GET', '/v1/conversations?limit=100');
      expect(conversations.body.items.every((c: { kind: string }) => c.kind === 'direct')).toBe(true);
    } finally {
      events.close();
    }
  });
});

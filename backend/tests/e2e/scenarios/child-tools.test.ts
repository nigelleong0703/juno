import { aguiInput } from '../../agui-input.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { childSessionKey, createAccount, listenEvents, scriptModel, stackUrls, toolActivity, toolCall, waitForToolActivity } from '../harness/client';

/** One offered-tools record per model call, written beside the scripted model file. */
function offeredTools(): Array<{ sessionKey: string; tools: string[] }> {
  try {
    return readFileSync(stackUrls().scriptFile + '.tools.jsonl', 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * child_spawn `tools` narrows the child: the model is offered only the named tools, and a call to a tool
 * it was not given is refused (here the model calls web_fetch anyway, which the child does not have).
 */
describe('child_spawn tools narrowing', () => {
  it('offers the child only its allowed tools and refuses a removed one', async () => {
    const account = await createAccount('child-tools');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Narrow' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const sessionKey = `${agent.body.id}:${conversationId}`;
      scriptModel(`${sessionKey}::child:*`, [
        { toolCalls: [{ id: 'call-fetch', name: 'web_fetch', arguments: { url: 'https://example.com' } }] },
        { text: 'child finished without fetching' },
      ]);
      scriptModel(sessionKey, [
        { toolCalls: [toolCall('call-spawn', 'child_spawn', { prompt: 'check the list only', tools: ['tasks_list'] })] },
        { toolCalls: [toolCall('call-wait', 'child_wait')] },
        { text: 'child is done' },
      ]);
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'check it' }))).status).toBe(202);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.parentRunId === undefined, 45_000);

      const spawn = (await waitForToolActivity(sessionKey, (a) => a.results.some((r) => r.toolName === 'child_spawn'))).results.find((r) => r.toolName === 'child_spawn');
      const childRunId = /Spawned child task (\S+)/.exec(spawn?.text ?? '')?.[1];
      expect(childRunId).toBeDefined();
      const childKey = childSessionKey(agent.body.id, conversationId, childRunId ?? '');

      // Every model call the child made was offered exactly the allowed tool, never the parent's full list.
      const childCalls = offeredTools().filter((call) => call.sessionKey === childKey);
      expect(childCalls.length).toBeGreaterThan(0);
      for (const call of childCalls) expect(call.tools).toEqual(['tasks_list']);
      // The parent is not offered child_spawn directly: it reaches it through tool_call.
      expect(offeredTools().some((call) => call.sessionKey === sessionKey && call.tools.includes('tool_call'))).toBe(true);

      // The removed tool is refused, not run.
      const childActivity = await waitForToolActivity(childKey, (a) => a.results.some((r) => r.toolName === 'web_fetch'));
      const fetch = childActivity.results.find((r) => r.toolName === 'web_fetch');
      expect(fetch?.isError).toBe(true);
      expect((await toolActivity(childKey)).calls.map((c) => c.name)).toEqual(['web_fetch']);
    } finally {
      events.close();
    }
  });
});

/**
 * child_spawn `fast`: the child runs to completion. This stack configures no fast model, so the child falls back to
 * the run's normal model and its run record names the same model as its parent's (the fast-model choice itself is
 * covered by the brain unit tests).
 */
describe('child_spawn fast', () => {
  // The scripted stack has no model selection, so runs carry no model here; which model `fast` picks is unit-tested
  // (child-fast-model.test.ts). This checks the parameter is accepted and the child runs to completion.
  it('accepts fast and runs the child to completion', async () => {
    const account = await createAccount('child-fast');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Quick' });
      expect(agent.status).toBe(201);
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      const sessionKey = `${agent.body.id}:${conversationId}`;
      scriptModel(`${sessionKey}::child:*`, [{ text: 'quick lookup done' }]);
      scriptModel(sessionKey, [
        { toolCalls: [toolCall('call-spawn', 'child_spawn', { prompt: 'quick lookup', fast: true, notify: false })] },
        { toolCalls: [toolCall('call-wait', 'child_wait')] },
        { text: 'lookup is done' },
      ]);
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'look it up' }))).status).toBe(202);
      const parent = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.parentRunId === undefined, 45_000);
      const child = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.parentRunId !== undefined, 45_000);
      expect(child.data.metadata.juno.run.status).toBe('completed');
      expect(parent.data.metadata.juno.run.status).toBe('completed');
    } finally {
      events.close();
    }
  });
});

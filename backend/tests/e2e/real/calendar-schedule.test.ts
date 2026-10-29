import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, runReport, toolActivity } from '../harness/client';

/**
 * A future time for something the agent must do puts an item in its OWN schedule in that turn (so it wakes then), instead of
 * asking the owner to come back. Checks the tool calls and arguments, never the wording.
 */
describe('real model: schedules what it is told for later', () => {
  async function ask(text: string) {
    const account = await createAccount('real-calendar');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Lead' });
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      const conversationId: string = created.body.id;
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }))).status).toBe(202);
      const started = await events.waitFor((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId, 60_000);
      const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === started.data.metadata.juno.run.id, 200_000);
      expect(finished.data.metadata.juno.run.status, await runReport(account, finished.data.metadata.juno.run.id)).toBe('completed');
      const activity = await toolActivity(`${agent.body.id}:${conversationId}`);
      // schedule_add is a hidden tool: the model finds it with tool_search and runs it through tool_call.
      const adds = activity.calls.flatMap((call) => {
        if (call.name === 'schedule_add') return [call];
        const inner = call.arguments['arguments'];
        return call.name === 'tool_call' && call.arguments['name'] === 'schedule_add' && typeof inner === 'object' && inner !== null
          ? [{ name: 'schedule_add', arguments: inner as Record<string, unknown> }] : [];
      });
      // What it did instead, for the failure message.
      Object.assign(adds, { seen: activity.calls.map((call) => call.name).join(', ') + ' | ' + activity.results.map((r) => r.text.slice(0, 160)).join(' | ')
        + ' | asked: ' + activity.calls.filter((call) => call.name === 'send_message').map((call) => JSON.stringify(call.arguments).slice(0, 500)).join(' ; ') });
      return adds;
    } finally {
      events.close();
    }
  }
  const seen = (adds: unknown): string => String((adds as { seen?: string }).seen);

  it('schedules a meeting given as "10 min later"', async () => {
    const adds = await ask('starting this meeting 10 min later, https://meet.google.com/fxc-zdap-bah');
    expect(adds.length, seen(adds)).toBe(1);
    const call = adds[0]!;
    expect(call.arguments['kind']).toBe('meeting');
    const at = Date.parse(String(call.arguments['at']));
    expect(at).toBeGreaterThan(Date.now());
    expect(at).toBeLessThan(Date.now() + 30 * 60_000);
    expect(JSON.stringify(call.arguments)).toContain('fxc-zdap-bah');
  });

  it('schedules a meeting given a clock time tomorrow', async () => {
    const adds = await ask('please join this google meet tomorrow at 3pm: https://meet.google.com/abc-defg-hij');
    expect(adds.length, seen(adds)).toBe(1);
    expect(adds[0]!.arguments['kind']).toBe('meeting');
    expect(Date.parse(String(adds[0]!.arguments['at']))).toBeGreaterThan(Date.now() + 3 * 3_600_000);
  });

  it('schedules a follow-up it was asked to make later', async () => {
    // A weekday two days ahead is never "today": on the day itself ("Thursday" said on a Thursday evening) asking which Thursday is the right behaviour.
    const weekday = new Date(Date.now() + 2 * 86_400_000).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
    const adds = await ask(`check back with me about the flight prices on ${weekday} morning`);
    expect(adds.length, seen(adds)).toBe(1);
    expect(['follow_up', 'task']).toContain(adds[0]!.arguments['kind']);
  });

  it('does not schedule anything for a plain question', async () => {
    expect((await ask('what is 2 + 3?')).length).toBe(0);
  });
});

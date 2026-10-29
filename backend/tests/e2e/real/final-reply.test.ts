import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, diagnose, listenEvents, listItems, runReport, toolActivity, type Account, type EventListener } from '../harness/client';

/**
 * One exit for every run (BACKEND §3.7): the final reply is the message the people in the chat see, whatever woke the agent. With a real
 * model: a calendar reminder posts the reminder itself once (no "sent" line after it), a routine with nothing new posts nothing, a routine
 * with something new posts one message or one Feed post, and a finished child task is told to the user once as the answer, not as news
 * that a task finished. Assertions check what was posted and which tools ran, never exact wording.
 */

/** E2E_VERBOSE=1 prints what the agent said, to read a run by eye. */
const note = (label: string, value: unknown): void => { if (process.env['E2E_VERBOSE'] === '1') console.info(`[final-reply-e2e] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`); };

async function agentWithChat(account: Account, name: string): Promise<{ agentId: string; conversationId: string; sessionKey: string }> {
  const agent = await account.api('POST', '/v1/agents', { name });
  expect(agent.status).toBe(201);
  const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
  expect(chat.status).toBe(201);
  return { agentId: agent.body.id, conversationId: chat.body.id, sessionKey: `${agent.body.id}:${chat.body.id}` };
}

/** What a run said in the chat: its agent bubbles. */
async function saidBy(account: Account, conversationId: string, runId: string): Promise<string[]> {
  return (await listItems(account, conversationId)).filter((item) => item.type === 'agent_message' && item.runId === runId).map((item) => item.markdown ?? '');
}

/** The run of this chat that starts with a wake whose run title begins with `prefix`, and its end. */
async function runTitled(events: EventListener, account: Account, conversationId: string, prefix: string, timeoutMs: number): Promise<{ id: string; title: string }> {
  const started = await events.waitFor((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId && String(e.data.metadata.juno.run.title).startsWith(prefix), timeoutMs);
  const id: string = started.data.metadata.juno.run.id;
  const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === id, 240_000);
  expect(finished.data.metadata.juno.run.status, await runReport(account, id)).toBe('completed');
  return { id, title: String(finished.data.metadata.juno.run.title) };
}

/** A line that only reports delivery: "Reminder sent.", "Done.", "Posted to the feed". */
const STATUS_ONLY = /^\W*(?:[\w' ]{0,24}\b)?(?:sent|done|delivered|posted|finished|completed)\b\W*$/i;

describe('real model: the final reply is the one exit', () => {
  it('a calendar reminder posts exactly one message: the reminder itself, no "sent" line after it', async () => {
    const account = await createAccount('real-reminder');
    const events = await listenEvents(account.cookie);
    let where: { conversationId: string; sessionKey: string } | undefined;
    try {
      const { conversationId, sessionKey } = await agentWithChat(account, 'Lead');
      where = { conversationId, sessionKey };
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'Remind me in 1 minute to do my stretches.' }));
      expect(sent.status).toBe(202);
      // The agent puts it in its own schedule (a hidden tool: found with tool_search, run through tool_call).
      const due = await runTitled(events, account, conversationId, 'Calendar:', 300_000);
      const activity = await toolActivity(sessionKey);
      const scheduled = activity.calls.some((call) => call.name === 'schedule_add' || (call.name === 'tool_call' && call.arguments['name'] === 'schedule_add'));
      expect(scheduled, JSON.stringify(activity.calls.map((call) => call.name))).toBe(true);

      const said = await saidBy(account, conversationId, due.id);
      note('calendar run said', said);
      expect(said, `the due run ${due.id} posts one message: ${JSON.stringify(said)}`).toHaveLength(1);
      expect(said[0], 'the reminder itself').toMatch(/stretch/i);
      expect(said[0], 'not a delivery note').not.toMatch(STATUS_ONLY);
    } catch (error) {
      if (where) await diagnose('final-reply-e2e', account, where.conversationId, where.sessionKey);
      throw error;
    } finally {
      events.close();
    }
  }, 600_000);

  /** One scheduled fire of a routine with these instructions; the routine is switched off as soon as its run starts. */
  async function fireRoutine(label: string, instructions: string) {
    const account = await createAccount(label);
    const events = await listenEvents(account.cookie);
    const { agentId, conversationId } = await agentWithChat(account, 'Routiner');
    const created = await account.api('POST', '/v1/routines', {
      name: 'Check', agentId, enabled: true, instructions,
      trigger: { kind: 'schedule', cron: '*/20 * * * * *', human: 'every 20 seconds', tz: 'UTC' },
      delivery: { channel: 'chat', target: conversationId }, notify: { mode: 'never' },
    });
    expect(created.status).toBe(201);
    const routineId: string = created.body.id;
    const started = await events.waitFor((e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === conversationId && e.data.metadata.juno.run.kind === 'routine', 120_000);
    await account.api('POST', `/v1/routines/${routineId}/toggle`, { enabled: false });
    const runId: string = started.data.metadata.juno.run.id;
    const finished = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.id === runId, 300_000);
    expect(finished.data.metadata.juno.run.status, await runReport(account, runId)).toBe('completed');
    const posts = ((await account.api('GET', '/v1/feed?limit=50')).body.items as Array<{ id: string; routineId?: string; title: string }>).filter((post) => post.routineId === routineId);
    const said = await saidBy(account, conversationId, runId);
    note(label + ' said', { said, posts: posts.map((post) => post.title) });
    events.close();
    return { account, conversationId, runId, said, posts };
  }

  it('a routine with nothing new posts nothing: no chat message, no Feed post', async () => {
    const { said, posts, runId } = await fireRoutine('real-routine-quiet',
      'Check my mail for a message from my landlord about the rent and brief me on it. (If you cannot reach my mail, or there is no such message, there is nothing to report.)');
    expect(said, `the run ${runId} said ${JSON.stringify(said)}`).toEqual([]);
    expect(posts.map((post) => post.title)).toEqual([]);
  }, 600_000);

  it('a routine with something new posts one message or one Feed post, and no delivery note after it', async () => {
    const { said, posts, runId } = await fireRoutine('real-routine-news',
      'Tell me the word of the day. Today\'s word is "petrichor" (the smell of rain on dry ground). That is new for me: let me see it.');
    expect(said.length + posts.length, `the run ${runId} said ${JSON.stringify(said)} and posted ${JSON.stringify(posts.map((post) => post.title))}`).toBe(1);
    for (const line of said) expect(line, 'not a delivery note').not.toMatch(STATUS_ONLY);
  }, 600_000);

  it('a finished child task is told once as the answer, not as news that a task finished', async () => {
    const account = await createAccount('real-child-done');
    const events = await listenEvents(account.cookie);
    try {
      const { conversationId } = await agentWithChat(account, 'Lead');
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, {
        text: 'Please hand this to a background helper (child_spawn with notify true) and tell me what it finds when it is done: what is the capital city of Australia, and in which year did it become the capital?',
      }));
      expect(sent.status).toBe(202);
      const wrap = await runTitled(events, account, conversationId, 'Wrapping up', 400_000);
      note('completion run title', wrap.title);
      // The run is named after the task, never after its raw result.
      expect(wrap.title).not.toMatch(/^Task finished/i);
      expect(wrap.title).not.toMatch(/report path|\.md\b|\//i);

      // The completion wake is automatic: its reply is ONE message (never split by paragraph), and the result is told once in the whole chat.
      const said = await saidBy(account, conversationId, wrap.id);
      const everything = (await listItems(account, conversationId)).filter((item) => item.type === 'agent_message').map((item) => item.markdown ?? '');
      note('completion run said', said);
      expect(said.length, `the completion run ${wrap.id} answers in one message: ${JSON.stringify(said)}`).toBe(1);
      expect(everything.filter((line) => /canberra/i.test(line)), `the result is told once: ${JSON.stringify(everything)}`).toHaveLength(1);
      expect(said.join('\n'), 'it carries the answer').toMatch(/canberra/i);
      expect(said.join('\n'), 'no "task finished" phrasing').not.toMatch(/\b(?:task|job|sub-?task|helper|child)\b.{0,40}\b(?:finished|completed|done|came back)\b|\b(?:finished|completed)\b.{0,20}\b(?:task|job)\b/i);
    } finally {
      events.close();
    }
  }, 900_000);
});

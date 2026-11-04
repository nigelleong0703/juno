/**
 * BACKEND §3.3d.5: an outside action whose outcome nobody can tell is the AGENT's to check. It is told as the tool result, the run goes on, an
 * identical call is held back until it has read, and only an agent that cannot tell asks the person one plain question. No card shows tool names,
 * parameters or ids. Driven through the production run loop.
 */
import { describe, expect, it } from 'vitest';
import type { Tool, ToolResult } from '../../../contracts/index.js';
import { toPublicRequest } from '../../../contracts/index.js';
import { createAskAboutUncertainActionTool } from '../../../modules/tools/tools/askAboutUncertainAction.js';
import { call, driveTools, turn } from '../../../testing/drive-tools.js';

const timedOut: ToolResult = { content: [{ type: 'text', text: 'Timed out after the request was sent.' }], isError: true, details: { errorKind: 'timeout' } };
const sent: ToolResult = { content: [{ type: 'text', text: 'Mail sent.' }] };

/** A send that times out on its first execution and works afterwards, and a read that only looks. */
function mailTools(): { tools: (store: Parameters<typeof createAskAboutUncertainActionTool>[0]['store']) => Tool[]; sends: () => number } {
  let sends = 0;
  const send: Tool = {
    name: 'mail_send', description: 'Send a mail', parameters: { type: 'object', properties: { to: { type: 'string' } } }, replay: 'never', sideEffect: true,
    async execute() { sends += 1; return sends === 1 ? timedOut : sent; },
  };
  const look: Tool = { name: 'mail_search', description: 'Look in sent mail', parameters: { type: 'object', properties: {} }, replay: 'safe', sideEffect: false, async execute() { return { content: [{ type: 'text', text: 'Nothing sent to Bob.' }] }; } };
  return { tools: (store) => [send, look, createAskAboutUncertainActionTool({ store })], sends: () => sends };
}

const text = (steps: Array<{ output?: { summary?: string } }>, index: number): string => steps[index]?.output?.summary ?? '';

describe('an action whose outcome is unknown', () => {
  it('tells the agent, raises no card, holds an identical call until the agent has read, then lets it through', async () => {
    const mail = mailTools();
    const bob = { to: 'bob@example.com' };
    const { outcome, requests, steps } = await driveTools([
      turn('', call('s1', 'mail_send', bob)),
      turn('', call('s2', 'mail_send', bob)),
      turn('', call('l1', 'mail_search', {})),
      turn('', call('s3', 'mail_send', bob)),
      turn('Checked sent mail and sent it once more.'),
    ], mail.tools);
    expect(outcome).toBe('completed');
    expect(requests).toEqual([]);
    // 1: the unknown outcome becomes the notice (the step records the interruption); 2: the same call before any read is not made.
    expect(steps[0]).toMatchObject({ status: 'failed', errorKind: 'harness' });
    expect(steps[1]).toMatchObject({ status: 'skipped' });
    expect(text(steps, 1)).toContain('This call was not made');
    expect(steps[3]).toMatchObject({ status: 'completed' });
    // The sends: the first (timed out), none for the held call, one after the read.
    expect(mail.sends()).toBe(2);
  });

  it('what the agent reads names the action in plain words and says to check before repeating, with no instruction to make the exact same call', async () => {
    const { store } = await driveTools([turn('', call('s1', 'mail_send', { to: 'bob@example.com' })), turn('I will look in sent mail first.')], mailTools().tools);
    const transcripts = JSON.stringify((await store.list('transcripts', { limit: 50 })).items);
    expect(transcripts).toContain('may or may not have happened (the request was sent but no answer came back)');
    expect(transcripts).toContain('Check with a read tool before doing it again');
    expect(transcripts).not.toContain('exact same call');
  });

  it('the one question to the person has a plain card (question and two buttons), keeps the link to the step private, and is refused when nothing is uncertain', async () => {
    const mail = mailTools();
    const { outcome, requests, items } = await driveTools([
      turn('', call('s1', 'mail_send', { to: 'bob@example.com' })),
      turn('', call('q1', 'ask_about_uncertain_action', { question: 'The email to Bob may already have gone out and I cannot see it. Send it again?', redoLabel: 'Send again', skipLabel: "Don't send" })),
      turn('Asked.'),
    ], mail.tools);
    expect(requests).toHaveLength(1);
    const asked = requests[0]!;
    const card = JSON.stringify(toPublicRequest(asked));
    expect(card).toContain('Send it again?');
    expect(card).toContain('Send again');
    for (const internal of ['mail_send', 'bob@example.com', 'fingerprint', 'stepId', 'Timed out', 'receipt', 'verify', asked.reconciliation?.fingerprint ?? 'x']) expect(card.toLowerCase()).not.toContain(internal.toLowerCase());
    expect(asked.reconciliation).toMatchObject({ state: 'pending', tool: 'mail_send', stepId: expect.any(String) });
    expect(items.some((item) => item.type === 'request')).toBe(true);
    // The run is not left waiting: the question is the end of the turn, the answer comes back as a message.
    expect(outcome).toBe('completed');

    const nothing = await driveTools([turn('', call('q1', 'ask_about_uncertain_action', { question: 'Anything?' })), turn('ok')], mailTools().tools);
    expect(nothing.requests).toEqual([]);
    expect(text(nothing.steps, 0)).toContain('no uncertain action in this run');
  });
});

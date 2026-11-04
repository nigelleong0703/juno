import { writeFileSync } from 'node:fs';
import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, runReport, type Account } from '../harness/client';
import { DECLARATION, openPhone } from '../harness/phone';

/**
 * Replies that read like a person (BACKEND.md 3.5 "Replying like a person"). Real model, five threads: the Fitness Tracker
 * conversation that went wrong in production (a health tool that fails because this build has no HealthKit entitlement), the Cue
 * questions, a task request, thanks, and a casual Chinese thread. Nothing is scored: E2E_EVAL_OUT=<file> writes each turn (what the
 * person said, the tools the run called, the tapback on their message, the reply bubbles) so a person reads the transcripts.
 * The assertions stay loose: a tapback on the task request, no "the app looks closed" while the person is chatting from the app,
 * and a health failure that does not blame the phone.
 */
interface Turn { thread: string; user: string; tools: string[]; tapback: string | null; bubbles: string[] }

/** Every string in a card, in order. */
const cardText = (node: unknown): string => (typeof node === 'string' ? node : Array.isArray(node) ? node.map(cardText).join(' | ') : typeof node === 'object' && node !== null ? Object.entries(node).filter(([key]) => !['type', 'id', 'url', 'kind'].includes(key)).map(([, value]) => cardText(value)).filter((part) => part !== '').join(' · ') : '');

const NO_ENTITLEMENT = new Error('The iPhone could not do that: Missing com.apple.developer.healthkit entitlement.');

describe('real model: replies like a person', () => {
  it('reacts to a task, never says the app is closed mid-chat, and owns a failure without blaming the phone', async () => {
    const account = await createAccount('real-human-replies');
    const events = await listenEvents(account.cookie);
    const phone = await openPhone(account, () => 'answer', (action) => (action === 'health.query' ? NO_ENTITLEMENT : {}), { ...DECLARATION, actions: [...DECLARATION.actions, 'health.read'] });
    const turns: Turn[] = [];
    const seenRuns = new Set<string>();
    try {
      const thread = async (name: string, agentInput: Record<string, unknown>, prompts: string[]): Promise<void> => {
        const agent = await account.api('POST', '/v1/agents', agentInput);
        expect(agent.status).toBe(201);
        const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
        expect(created.status).toBe(201);
        const conversationId: string = created.body.id;
        for (const text of prompts) {
          const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text }));
          expect(sent.status).toBe(202);
          const finished = await events.waitFor(
            (e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId && !seenRuns.has(e.data.metadata.juno.run.id),
            240_000,
          );
          const runId: string = finished.data.metadata.juno.run.id;
          seenRuns.add(runId);
          expect(finished.data.metadata.juno.run.status, await runReport(account as Account, runId)).toBe('completed');
          const items = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=200`)).body.items as Array<{ type: string; runId?: string; markdown?: string; text?: string; reaction?: string; ui?: unknown }>;
          const steps = (await account.api('GET', `/v1/runs/${runId}/steps`)).body.items as Array<{ target: string; internal?: boolean }>;
          const userItem = items.filter((item) => item.type === 'user_message' && item.text === text).pop();
          turns.push({
            thread: name, user: text,
            tools: steps.map((step) => step.target),
            tapback: userItem?.reaction ?? null,
            // A card under the text (ui) is part of what the person reads: show its text parts too.
            bubbles: items.filter((item) => item.type === 'agent_message' && item.runId === runId).map((item) => [item.markdown ?? '', ...(item.ui === undefined ? [] : ['[card] ' + cardText(item.ui)])].filter((part) => part !== '').join('\n')),
          });
        }
      };

      await thread('fitness', { name: 'Fitness Tracker', personality: 'You help the person work out more and build muscle with less sugar along the way.' }, ['What health data can u access to?', 'check for me']);
      await thread('cue', { name: 'Tavi' }, ['你怎么发回复的呢', '没看懂 解释给我看', '调用聊天的发送功能是什么意思']);
      await thread('task', { name: 'Pip' }, ['find me a cafe near Tanjong Pagar open now', 'thanks']);
      await thread('chinese', { name: 'Mochi' }, ['今天好累啊', '周末想去海边走走', '哈哈你说得对']);

      const out = process.env.E2E_EVAL_OUT;
      if (out !== undefined && out !== '') writeFileSync(out, JSON.stringify(turns, null, 1));
      // eslint-disable-next-line no-console
      console.log('human-replies transcript', JSON.stringify(turns, null, 1));

      const fitness = turns.filter((turn) => turn.thread === 'fitness');
      for (const turn of fitness) {
        expect(turn.bubbles.join('\n'), 'says the app is closed while the person is chatting in it').not.toMatch(/looks closed|app is closed|isn't open|not open|open Juno|reopen/i);
      }
      const failure = fitness.at(-1)?.bubbles.join('\n') ?? '';
      expect(failure, 'blames the phone for a build without the capability').not.toMatch(/(?<!not )(blocked|denied)|(go to|check)( in)?( your)?( iPhone)? Settings/i);
      const task = turns.find((turn) => turn.user.startsWith('find me a cafe'));
      expect(task?.tools, 'the task request gets a tapback').toContain('react');
    } finally {
      phone.close();
      events.close();
    }
  }, 1_800_000);
});

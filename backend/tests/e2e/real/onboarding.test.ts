import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listItems, listRuns, toolActivity } from '../harness/client';

/**
 * Onboarding with a real model (BACKEND §8.7): every new agent speaks first, with the guidance attached to its first wake. A new account's
 * default agent opens the first chat with a short welcome as plain text in the person's language (no card, no buttons): who it is, what it can
 * do for them, an invitation to say what they need. A first message that is a concrete request is worked on with tools before any setup card.
 * An agent the owner creates later with a name welcomes first and never asks for the owner's name again. Assertions check tool calls, saved
 * state and item order, never wording; every output is printed.
 */
/** The arguments of every call of `name`, made directly or through tool_call (hidden tools are reached through it). */
function callsOf(activity: { calls: Array<{ name: string; arguments: Record<string, unknown> }> }, name: string): Array<Record<string, unknown>> {
  return activity.calls.flatMap((call) => {
    if (call.name === name) return [call.arguments];
    const inner = call.arguments['arguments'];
    return call.name === 'tool_call' && call.arguments['name'] === name && typeof inner === 'object' && inner !== null ? [inner as Record<string, unknown>] : [];
  });
}

const CJK = /[一-鿿]/;
type Item = { type: string; markdown?: string; text?: string };
const SETUP_TOOLS = new Set(['send_message', 'profile_update', 'agent_update', 'connect_request', 'connector_search', 'memory_note', 'tool_search', 'skill_read', 'skill_search']);
const innerName = (call: { name: string; arguments: Record<string, unknown> }): string => (call.name === 'tool_call' ? String(call.arguments['name']) : call.name);

describe('real model: first-run onboarding', () => {
  it('a brand-new account\'s first output is a text welcome in its language, with no card before it', async () => {
    const account = await createAccount('real-first-hello', '李明');
    const conversationId: string = (await account.api('GET', '/v1/conversations')).body.items[0].id;
    const agentId: string = (await account.api('GET', '/v1/agents')).body.items[0].id;
    let chat: Item[] = [];
    for (let i = 0; i < 400 && !chat.some((item) => item.type === 'agent_message' || item.type === 'request'); i += 1) {
      chat = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=50`)).body.items as Item[];
      if (!chat.some((item) => item.type === 'agent_message' || item.type === 'request')) await new Promise((r) => setTimeout(r, 500));
    }
    for (let i = 0; i < 120 && (await listRuns(account, conversationId)).some((run) => run.status === 'running' || run.status === 'queued'); i += 1) await new Promise((r) => setTimeout(r, 500));
    chat = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=50`)).body.items as Item[];
    const activity = await toolActivity(`${agentId}:${conversationId}`);
    const diagnosis = JSON.stringify({ items: chat.map((item) => [item.type, item.markdown ?? item.text ?? '']), tools: activity.calls.map(innerName) });
    // eslint-disable-next-line no-console
    console.log('FIRST HELLO ' + diagnosis);
    const first = chat.find((item) => item.type === 'agent_message' || item.type === 'request');
    expect(first?.type, 'the first thing is a text bubble, not a card: ' + diagnosis).toBe('agent_message');
    expect(first?.markdown ?? '', 'in the account\'s language: ' + diagnosis).toMatch(CJK);
    expect(chat.filter((item) => item.type === 'request' || item.type === 'role_suggestion'), 'no card before the person said anything: ' + diagnosis).toEqual([]);
    expect(activity.calls.map(innerName), diagnosis).not.toContain('connect_request');
  }, 400_000);

  it('a concrete first request is worked on with tools before any setup, name or Connect card', async () => {
    const account = await createAccount('real-first-task', 'Robin');
    const conversationId: string = (await account.api('GET', '/v1/conversations')).body.items[0].id;
    const agentId: string = (await account.api('GET', '/v1/agents')).body.items[0].id;
    // The person does not wait for the welcome: their very first message is the request.
    expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: '我想知道11月3日新加坡飞长沙最便宜的直飞' }))).status).toBe(202);
    let quietChecks = 0;
    for (let i = 0; i < 700 && quietChecks < 6; i += 1) {
      const busy = (await listRuns(account, conversationId)).some((run) => run.status === 'running' || run.status === 'queued');
      quietChecks = busy ? 0 : quietChecks + 1;
      await new Promise((r) => setTimeout(r, 500));
    }
    const chat = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=100`)).body.items as Item[];
    const activity = await toolActivity(`${agentId}:${conversationId}`);
    const tools = activity.calls.map(innerName);
    const diagnosis = JSON.stringify({ items: chat.map((item) => [item.type, item.markdown ?? item.text ?? '']), tools });
    // eslint-disable-next-line no-console
    console.log('FIRST TASK ' + diagnosis);
    expect(tools.some((name) => !SETUP_TOOLS.has(name)), 'it worked on the request with its tools: ' + diagnosis).toBe(true);
    const lastAnswer = chat.map((item, index) => ({ item, index })).filter(({ item }) => item.type === 'agent_message').at(-1)?.index ?? -1;
    expect(lastAnswer, diagnosis).toBeGreaterThan(-1);
    expect(chat.slice(0, lastAnswer).filter((item) => item.type === 'request' || item.type === 'role_suggestion'), 'no setup, name, Connect or role card before the answer: ' + diagnosis).toEqual([]);
  }, 700_000);

  it('a first message that asks for something is answered, not met with only a greeting or a naming question', async () => {
    const account = await createAccount('real-onboarding-ask', 'Robin');
    const conversationId: string = (await account.api('GET', '/v1/conversations')).body.items[0].id;
    // The user does not wait for the greeting: their very first message is a question with a checkable answer.
    expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'Quick question before anything else: what is 17 times 23?' }))).status).toBe(202);
    let said: string[] = [];
    for (let i = 0; i < 360 && !said.some((text) => text.includes('391')); i += 1) {
      const items = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=50`)).body.items as Array<{ type: string; markdown?: string }>;
      said = items.filter((item) => item.type === 'agent_message').map((item) => item.markdown ?? '');
      if (!said.some((text) => text.includes('391'))) await new Promise((r) => setTimeout(r, 500));
    }
    expect(said.some((text) => text.includes('391')), JSON.stringify(said)).toBe(true);
  });

  it('a second agent created with a name welcomes first (no feature list, no owner name), then saves the role and offers fitting apps', async () => {
    const account = await createAccount('real-onboarding-second', 'Robin');
    // Sign-up's own agent greets in its chat too; this test follows only the agent the owner creates next.
    const created = await account.api('POST', '/v1/agents', { name: 'Scout' });
    expect(created.status).toBe(201);
    const agentId: string = created.body.id;
    const chats = (await account.api('GET', '/v1/conversations?limit=100')).body.items as Array<{ id: string; kind: string; agentIds: string[] }>;
    const conversationId = chats.find((chat) => chat.kind === 'direct' && chat.agentIds.includes(agentId))?.id ?? '';
    expect(conversationId, 'creating the agent opened its direct chat').not.toBe('');
    const sessionKey = `${agentId}:${conversationId}`;

    // 1. It speaks first, before anyone typed anything.
    let said: string[] = [];
    for (let i = 0; i < 400 && said.length === 0; i += 1) {
      said = (await listItems(account, conversationId)).filter((item) => item.type === 'agent_message').map((item) => item.markdown ?? '');
      if (said.length === 0) await new Promise((r) => setTimeout(r, 500));
    }
    for (let i = 0; i < 120 && (await listRuns(account, conversationId)).some((run) => run.status === 'running'); i += 1) await new Promise((r) => setTimeout(r, 500));
    said = (await listItems(account, conversationId)).filter((item) => item.type === 'agent_message').map((item) => item.markdown ?? '');
    const greeting = said.join('\n');
    const first = await toolActivity(sessionKey);
    const diagnosis = JSON.stringify({ said, tools: first.calls.map(innerName) });
    // eslint-disable-next-line no-console
    console.log('SECOND AGENT WELCOME ' + diagnosis);
    expect(said.length, diagnosis).toBeGreaterThan(0);
    expect(greeting, 'a feature list reads like a brochure: ' + diagnosis).not.toMatch(/(^|\n)\s*(?:[-*•]|\d+[.)])\s/);
    expect(greeting, 'the owner\'s name is already known: ' + diagnosis).not.toMatch(/\b(?:what(?:'s| is)|may i (?:have|know)|can i (?:get|have)|tell me) your name\b|\bwho am i (?:talking|speaking) (?:to|with)\b/i);
    expect(callsOf(first, 'profile_update'), 'the owner\'s name is known: ' + diagnosis).toEqual([]);
    expect(callsOf(first, 'agent_update').filter((args) => args['name'] !== undefined), 'its name was chosen at creation: ' + diagnosis).toEqual([]);
    expect((await account.api('GET', `/v1/agents/${agentId}`)).body.name).toBe('Scout');

    // 2. The owner says what they want; it saves the role and offers apps that fit, without asking again who the owner is.
    expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'I want you to keep my email and my calendar in order.' }))).status).toBe(202);
    let offered = false;
    let updated = false;
    for (let i = 0; i < 160 && !(offered && updated); i += 1) {
      // The model picks the mail/calendar apps from the catalog (the first run chose Outlook), so any Connect card counts.
      offered = ((await account.api('GET', '/v1/requests?status=pending')).body.items as Array<{ kind: string }>).some((request) => request.kind === 'connect');
      updated = callsOf(await toolActivity(sessionKey), 'agent_update').some((args) => typeof args['description'] === 'string');
      if (!(offered && updated)) await new Promise((r) => setTimeout(r, 500));
    }
    const after = await toolActivity(sessionKey);
    const diagnosis2 = JSON.stringify({ offered, updated, tools: after.calls.map((call) => (call.name === 'tool_call' ? 'tool_call:' + String(call.arguments['name']) : call.name)), items: (await listItems(account, conversationId)).map((item) => [item.type, item.markdown ?? '']) });
    // eslint-disable-next-line no-console
    console.log('SECOND AGENT AFTER ANSWER ' + diagnosis2);
    expect(updated, 'it saved what it is for (agent_update description): ' + diagnosis2).toBe(true);
    expect(offered, 'it offered the apps that fit (a Connect card with gmail or google-calendar): ' + diagnosis2).toBe(true);
    expect((await account.api('GET', `/v1/agents/${agentId}`)).body.name, 'its chosen name stays').toBe('Scout');
    expect((await account.api('GET', '/v1/profile')).body.entries).toMatchObject([{ key: 'Name', value: 'Robin' }]);
  }, 600_000);
});

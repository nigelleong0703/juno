import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, listItems, listRuns, runReport, toolActivity } from '../harness/client';

/**
 * Onboarding with a real model (BACKEND §8.7): every new agent speaks first, with the guidance attached to its first wake. A new account's
 * default agent opens the first chat (account-onboarding + agent-setup): the sign-up name is already in the profile, so the agent greets by it
 * and does not ask it again; the user picks the agent's name from the card, and the agent renames itself and shows a Connect card (gmail and
 * google-calendar) without making itself "needs you". An agent the owner creates later with a name (agent-setup alone) greets first, asks what to
 * help with and never asks for the owner's name again. Assertions check tool calls and saved state, never wording.
 */
/** The arguments of every call of `name`, made directly or through tool_call (hidden tools are reached through it). */
function callsOf(activity: { calls: Array<{ name: string; arguments: Record<string, unknown> }> }, name: string): Array<Record<string, unknown>> {
  return activity.calls.flatMap((call) => {
    if (call.name === name) return [call.arguments];
    const inner = call.arguments['arguments'];
    return call.name === 'tool_call' && call.arguments['name'] === name && typeof inner === 'object' && inner !== null ? [inner as Record<string, unknown>] : [];
  });
}

describe('real model: first-run onboarding', () => {
  it('greets first, saves the name, renames itself from the card and offers apps', async () => {
    const account = await createAccount('real-onboarding', 'Robin');
    const events = await listenEvents(account.cookie);
    try {
      // Sign-up created the default agent and its chat; the agent speaks first.
      const agentId: string = (await account.api('GET', '/v1/agents')).body.items[0].id;
      const conversationId: string = (await account.api('GET', '/v1/conversations')).body.items[0].id;
      const sessionKey = `${agentId}:${conversationId}`;
      // The name came from sign-up, so the naming card follows the greeting without the user typing anything.
      const asked = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.kind === 'question' && e.data.request.conversationId === conversationId, 200_000).catch(async (error: unknown) => {
        // Show what the agent did instead of asking with a card.
        const items = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=50`)).body.items as Array<{ type: string; markdown?: string; text?: string }>;
        console.log('onboarding transcript', JSON.stringify(items.map((item) => [item.type, item.markdown ?? item.text ?? '']), null, 1), JSON.stringify((await toolActivity(sessionKey)).calls.map((call) => call.name)));
        throw error;
      });
      const blocks: Array<{ type: string; id: string; options?: Array<{ id: string; label: string }> }> = asked.data.request.payload.ui.blocks;
      const choices = blocks.find((block) => block.type === 'choices');
      expect(choices?.options?.length, JSON.stringify(asked.data.request)).toBe(3);
      // Pick a new name (one option is the agent's current name, Juno).
      const pick = choices?.options?.find((option) => !/juno/i.test(option.label))?.id ?? '';
      const answered = await account.api('POST', `/v1/requests/${asked.data.request.id}/resolve`, { action: 'answer', answers: { [choices?.id ?? '']: pick } });
      expect(answered.status).toBe(200);

      // After the pick the agent renames itself, introduces itself and offers apps.
      let renamed = false;
      let offered = false;
      for (let i = 0; i < 180 && !(renamed && offered); i += 1) {
        renamed = (await account.api('GET', `/v1/agents/${agentId}`)).body.name !== 'Juno';
        offered = (await account.api('GET', '/v1/requests?status=pending')).body.items.some((r: { kind: string }) => r.kind === 'connect');
        if (!(renamed && offered)) await new Promise((r) => setTimeout(r, 500));
      }
      if (!(renamed && offered)) {
        const items = (await account.api('GET', `/v1/conversations/${conversationId}/items?limit=50`)).body.items as Array<{ type: string; markdown?: string; text?: string }>;
        console.log('after the pick', JSON.stringify({ renamed, offered, items: items.map((item) => [item.type, item.markdown ?? item.text ?? '']), tools: (await toolActivity(sessionKey)).calls.map((call) => call.name), pending: (await account.api('GET', '/v1/requests?status=pending')).body.items }, null, 1));
      }
      expect((await account.api('GET', '/v1/profile')).body.entries).toMatchObject([{ key: 'Name', value: 'Robin' }]);
      expect((await account.api('GET', `/v1/agents/${agentId}`)).body.name).not.toBe('Juno');

      const activity = await toolActivity(sessionKey);
      const used = activity.calls.map((call) => (call.name === 'tool_call' ? String(call.arguments['name']) : call.name));
      expect(used, JSON.stringify(activity)).toContain('agent_update');
      expect(used, JSON.stringify(activity)).not.toContain('todo_write');
      expect(used, 'the name is already known').not.toContain('profile_update');
      const pending = (await account.api('GET', '/v1/requests?status=pending')).body.items as Array<{ kind: string }>;
      const offeredApps = pending.some((request) => request.kind === 'connect') || pending.some((request) => request.kind === 'question');
      expect(offeredApps || used.includes('connect_request'), JSON.stringify(activity)).toBe(true);
      expect(pending.some((request) => request.kind === 'connect'), JSON.stringify(activity)).toBe(true);
      // The account's first agent offers the core apps.
      const offeredIds = pending.flatMap((request) => (request.kind === 'connect' ? ((request as { payload?: { appIds?: string[] } }).payload?.appIds ?? []) : []));
      expect(offeredIds.some((id) => id === 'gmail' || id === 'google-calendar'), JSON.stringify(offeredIds)).toBe(true);
      // The card waiting in the chat is conversation, not something the agent is stuck on.
      expect((await account.api('GET', `/v1/agents/${agentId}`)).body.status).not.toBe('needs_you');
    } finally {
      events.close();
    }
  });

  it('typing a name instead of tapping the card renames the agent and onboarding continues', async () => {
    const account = await createAccount('real-onboarding-typed', 'Robin');
    const events = await listenEvents(account.cookie);
    try {
      const agentId: string = (await account.api('GET', '/v1/agents')).body.items[0].id;
      const conversationId: string = (await account.api('GET', '/v1/conversations')).body.items[0].id;
      const asked = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.kind === 'question' && e.data.request.conversationId === conversationId, 200_000);
      // The asking run ends its turn; the user types a name instead of tapping an option.
      for (let i = 0; i < 120 && (await listRuns(account, conversationId)).some((run) => run.status === 'running'); i += 1) await new Promise((r) => setTimeout(r, 500));
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'Call yourself Milo' }))).status).toBe(202);

      let renamed = false;
      let offered = false;
      for (let i = 0; i < 240 && !(renamed && offered); i += 1) {
        renamed = (await account.api('GET', `/v1/agents/${agentId}`)).body.name === 'Milo';
        offered = (await account.api('GET', '/v1/requests?status=pending')).body.items.some((r: { kind: string }) => r.kind === 'connect');
        if (!(renamed && offered)) await new Promise((r) => setTimeout(r, 500));
      }
      const activity = await toolActivity(`${agentId}:${conversationId}`);
      expect(renamed, JSON.stringify(activity)).toBe(true);
      expect(offered, JSON.stringify(activity)).toBe(true);
      expect((await account.api('GET', `/v1/requests/${asked.data.request.id}`)).body.status).toBe('expired');
    } finally {
      events.close();
    }
  });

  it('a first message that asks for something is answered, not met with only a greeting or a naming question', async () => {
    const account = await createAccount('real-onboarding-ask', 'Robin');
    try {
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
    } finally {
      // nothing to close
    }
  });

  it('a second agent created with a name greets first, asks what to help with (no feature list, no owner name), then saves the role and offers fitting apps', async () => {
    const account = await createAccount('real-onboarding-second', 'Robin');
    try {
      // Sign-up's own agent greets in its chat too; this test follows only the agent the owner creates next.
      const created = await account.api('POST', '/v1/agents', { name: 'Scout' });
      expect(created.status).toBe(201);
      const agentId: string = created.body.id;
      const chats = (await account.api('GET', '/v1/conversations?limit=100')).body.items as Array<{ id: string; kind: string; agentIds: string[] }>;
      const conversationId = chats.find((chat) => chat.kind === 'direct' && chat.agentIds.includes(agentId))?.id ?? '';
      expect(conversationId, 'creating the agent opened its direct chat').not.toBe('');
      const sessionKey = `${agentId}:${conversationId}`;

      // 1. It speaks first, before anyone typed anything: a short message that asks what the owner wants it to help with.
      let said: string[] = [];
      for (let i = 0; i < 400 && said.length === 0; i += 1) {
        said = (await listItems(account, conversationId)).filter((item) => item.type === 'agent_message').map((item) => item.markdown ?? '');
        if (said.length === 0) await new Promise((r) => setTimeout(r, 500));
      }
      for (let i = 0; i < 120 && (await listRuns(account, conversationId)).some((run) => run.status === 'running'); i += 1) await new Promise((r) => setTimeout(r, 500));
      const pendingQuestions = ((await account.api('GET', '/v1/requests?status=pending')).body.items as Array<{ kind: string; conversationId?: string }>).filter((request) => request.kind === 'question' && request.conversationId === conversationId);
      said = (await listItems(account, conversationId)).filter((item) => item.type === 'agent_message').map((item) => item.markdown ?? '');
      const greeting = said.join('\n');
      const first = await toolActivity(sessionKey);
      const diagnosis = JSON.stringify({ said, pendingQuestions: pendingQuestions.length, tools: first.calls.map((call) => call.name) });
      if (process.env['E2E_VERBOSE'] === '1') console.info('[onboarding-e2e] second agent greeting: ' + diagnosis);
      expect(said.length, diagnosis).toBeGreaterThan(0);
      expect(greeting.includes('?') || pendingQuestions.length > 0, 'it asks what to help with: ' + diagnosis).toBe(true);
      expect(greeting, 'a feature list reads like a brochure: ' + diagnosis).not.toMatch(/(^|\n)\s*(?:[-*•]|\d+[.)])\s/);
      expect(greeting, 'the owner\'s name is already known: ' + diagnosis).not.toMatch(/\b(?:what(?:'s| is)|may i (?:have|know)|can i (?:get|have)|tell me) your name\b|\bwho am i (?:talking|speaking) (?:to|with)\b/i);
      expect(callsOf(first, 'profile_update'), 'the owner\'s name is known: ' + diagnosis).toEqual([]);
      expect(callsOf(first, 'agent_update').filter((args) => args['name'] !== undefined), 'its name was chosen at creation: ' + diagnosis).toEqual([]);
      expect((await account.api('GET', `/v1/agents/${agentId}`)).body.name).toBe('Scout');
      const runs = await Promise.all((await listRuns(account, conversationId)).map(async (run) => (await account.api('GET', `/v1/runs/${run.id}`)).body.title as string));
      expect(runs, diagnosis).toContain('Getting started');

      // 2. The owner says what they want; it saves the role and offers apps that fit, without asking again who the owner is.
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'I want you to keep my email and my calendar in order.' }))).status).toBe(202);
      let offered = false;
      let updated = false;
      for (let i = 0; i < 480 && !(offered && updated); i += 1) {
        offered = ((await account.api('GET', '/v1/requests?status=pending')).body.items as Array<{ kind: string; payload?: { appIds?: string[] } }>)
          .some((request) => request.kind === 'connect' && (request.payload?.appIds ?? []).some((id) => id === 'gmail' || id === 'google-calendar'));
        updated = callsOf(await toolActivity(sessionKey), 'agent_update').some((args) => typeof args['description'] === 'string');
        if (!(offered && updated)) await new Promise((r) => setTimeout(r, 500));
      }
      const after = await toolActivity(sessionKey);
      const diagnosis2 = JSON.stringify({ offered, updated, tools: after.calls.map((call) => (call.name === 'tool_call' ? 'tool_call:' + String(call.arguments['name']) : call.name)), items: (await listItems(account, conversationId)).map((item) => [item.type, item.markdown ?? '']) });
      if (process.env['E2E_VERBOSE'] === '1') console.info('[onboarding-e2e] second agent after the answer: ' + diagnosis2);
      expect(updated, 'it saved what it is for (agent_update description): ' + diagnosis2).toBe(true);
      expect(offered, 'it offered the apps that fit (a Connect card with gmail or google-calendar): ' + diagnosis2).toBe(true);
      expect((await account.api('GET', `/v1/agents/${agentId}`)).body.name, 'its chosen name stays').toBe('Scout');
      expect((await account.api('GET', '/v1/profile')).body.entries).toMatchObject([{ key: 'Name', value: 'Robin' }]);
    } finally {
      // nothing to close
    }
  }, 600_000);
});

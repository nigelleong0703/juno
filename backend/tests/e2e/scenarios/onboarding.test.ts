import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, listRuns, scriptModel, toolCall, waitForTranscript } from '../harness/client';

/**
 * Onboarding (BACKEND §8.7): creating an account also creates its default agent and first direct chat and wakes the agent once, so it speaks first; the
 * guidance is two skills attached INLINE to that wake (the account's first agent gets both, any agent created later only agent-setup; there is no context section);
 * the sign-up name is saved to the profile at once; the agent renames itself, shows a Connect card, and neither the question nor the Connect card makes the agent "needs you".
 */
const GUIDE = '# Account onboarding';
const SETUP = '# Setting up a new agent';
const WOKEN = 'You were just created';

const NAME_CARD ={ version: 1, blocks: [{ type: 'choices', id: 'name', options: [{ id: 'muse', label: 'Muse' }, { id: 'echo', label: 'Echo' }, { id: 'juno', label: 'Juno' }] }] };

/** Sign up and ask the name question; the run that asked has ended (a question does not suspend it). */
async function askedName(label: string, newName: string) {
  const account = await createAccount(label, 'Robin');
  const events = await listenEvents(account.cookie);
  const agentId: string = (await account.api('GET', '/v1/agents')).body.items[0].id;
  const conversationId: string = (await account.api('GET', '/v1/conversations')).body.items[0].id;
  const sessionKey = `${agentId}:${conversationId}`;
  await waitForTranscript(sessionKey, (rows) => rows.some((row) => row.includes(WOKEN)) && rows.join('\n').includes(GUIDE));
  for (let i = 0; i < 60 && !(await listRuns(account, conversationId)).every((run) => run.status === 'completed'); i += 1) await new Promise((r) => setTimeout(r, 500));
  scriptModel(sessionKey, [
    { text: 'greeting already sent' },
    { toolCalls: [{ id: 'ask', name: 'send_message', arguments: { kind: 'question', text: 'What would you like to call me?', ui: NAME_CARD } }] },
    { text: 'Pick a name above.' },
    { toolCalls: [
      toolCall('rename', 'agent_update', { id: agentId, name: newName }),
      toolCall('connect', 'connect_request', { connectors: ['gmail'], label: 'Gmail' }),
    ] },
    { text: `${newName} it is. Want to start by connecting Gmail?` },
  ]);
  expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'hi' }))).status).toBe(202);
  const asked = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.kind === 'question' && e.data.request.conversationId === conversationId, 45_000);
  await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes('Pick a name above'), 45_000);
  return { account, events, agentId, conversationId, requestId: asked.data.request.id as string };
}

describe('first-run onboarding', () => {
  it('typing a name instead of tapping closes the question card and the reply carries on', async () => {
    const { account, events, agentId, conversationId, requestId } = await askedName('onboarding-typed', 'Milo');
    try {
      // The asking run has ended; the question card stays open until the user answers (it never blocks the run).
      for (let i = 0; i < 60 && !(await listRuns(account, conversationId)).every((run) => run.status === 'completed'); i += 1) await new Promise((r) => setTimeout(r, 500));
      expect((await account.api('GET', `/v1/requests/${requestId}`)).body.status).toBe('pending');
      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'Call yourself Milo' }))).status).toBe(202);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes('Milo it is'), 45_000);
      expect((await account.api('GET', `/v1/requests/${requestId}`)).body.status).toBe('expired');
      expect((await account.api('GET', `/v1/agents/${agentId}`)).body.name).toBe('Milo');
    } finally {
      events.close();
    }
  });

  it('greets first, takes the name, renames the agent, offers a Connect card, with the sign-up name already saved, and neither card makes the agent needs_you', async () => {
    const account = await createAccount('onboarding', 'Robin');
    const events = await listenEvents(account.cookie);
    try {
      // Sign-up itself created the default agent and its direct chat, and woke the agent once to speak first.
      const agents = (await account.api('GET', '/v1/agents')).body.items;
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe('Juno');
      const agentId: string = agents[0].id;
      const chats = (await account.api('GET', '/v1/conversations')).body.items;
      expect(chats).toHaveLength(1);
      expect(chats[0].kind).toBe('direct');
      const conversationId: string = chats[0].id;
      const sessionKey = `${agentId}:${conversationId}`;
      // The greeting run starts before a script can exist for a chat nobody has opened yet, so it answers with the default reply.
      // The sign-up name is already the profile's Name entry; the wake itself carries both skills (account skill first) and no context section does.
      expect((await account.api('GET', '/v1/profile')).body.entries).toMatchObject([{ key: 'Name', value: 'Robin' }]);
      const opening = await waitForTranscript(sessionKey, (rows) => rows.some((row) => row.includes(WOKEN)) && rows.join('\n').includes(GUIDE));
      const wakeRow = opening.find((row) => row.includes(WOKEN)) ?? '';
      expect(wakeRow).toContain(GUIDE);
      expect(wakeRow.indexOf(GUIDE)).toBeLessThan(wakeRow.indexOf(SETUP));
      expect(opening.join('\n')).not.toContain('## First-run onboarding');
      for (let i = 0; i < 60 && !(await listRuns(account, conversationId)).every((run) => run.status === 'completed'); i += 1) await new Promise((r) => setTimeout(r, 500));
      expect(await listRuns(account, conversationId)).toHaveLength(1);
      scriptModel(sessionKey, [
        { text: 'greeting already sent' },
        { toolCalls: [
          { id: 'ask', name: 'send_message', arguments: { kind: 'question', text: 'What would you like to call me?', ui: NAME_CARD } },
        ] },
        // However fast the run is, the rename turn is chosen by the tapped answer, not by its position; the plain
        // turns before it answer a run that got ahead of the tap, and the ones at 3 and 4 close the run either way.
        { text: 'Pick a name above.' },
        { text: 'Muse it is. Want to start by connecting Gmail?' },
        { text: 'Muse it is. Want to start by connecting Gmail?' },
        { matchLastText: 'Muse', step: 0, toolCalls: [
          toolCall('rename', 'agent_update', { id: agentId, name: 'Muse' }),
          toolCall('connect', 'connect_request', { connectors: ['gmail', 'google-calendar'], label: 'Gmail and Google Calendar' }),
        ] },
      ]);

      expect((await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'hi' }))).status).toBe(202);
      const asked = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.kind === 'question' && e.data.request.conversationId === conversationId, 45_000);
      // A pending question card in the direct chat stays listed, but the agent does not "need" the user for it.
      expect((await account.api('GET', '/v1/requests?status=pending')).body.items.some((r: { id: string }) => r.id === asked.data.request.id)).toBe(true);
      expect((await account.api('GET', `/v1/agents/${agentId}`)).body.status).not.toBe('needs_you');
      // Tap at once: the answer reaches the Session while the asking run is still active, so the run's next turn (not a new run) answers it.
      const answered = await account.api('POST', `/v1/requests/${asked.data.request.id}/resolve`, { action: 'answer', answers: { name: 'muse' } });
      expect(answered.status).toBe(200);
      // The tapped option becomes the user's next chat message, which starts the next run.
      expect(((await account.api('GET', `/v1/conversations/${conversationId}/items`)).body.items as Array<{ type: string; text?: string }>).some((item) => item.type === 'user_message' && item.text === 'Muse')).toBe(true);
      await events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === conversationId && String(e.data.item.markdown).includes('Muse it is'), 45_000);

      expect((await account.api('GET', `/v1/agents/${agentId}`)).body.name).toBe('Muse');
      const profile = (await account.api('GET', '/v1/profile')).body;
      expect(profile.entries).toMatchObject([{ key: 'Name', value: 'Robin' }]);
      const connect = (await account.api('GET', '/v1/requests?status=pending')).body.items.filter((r: { kind: string }) => r.kind === 'connect');
      expect(connect).toHaveLength(1);
      expect(connect[0].payload.appIds).toEqual(['gmail', 'google-calendar']);
      expect(connect[0].payload.routineId).toBeUndefined();
      expect(connect[0].title).toBe('Connect your apps');
      const agent = (await account.api('GET', `/v1/agents/${agentId}`)).body;
      expect(agent.status).not.toBe('needs_you');
      expect(agent.needsYou).toBe(0);
    } finally {
      events.close();
    }
  });

  it('an agent created later is woken once in its own direct chat, with the agent-setup skill alone and its name already chosen', async () => {
    const account = await createAccount('onboarding-second', 'Robin');
    const created = await account.api('POST', '/v1/agents', { name: 'Scout' });
    expect(created.status).toBe(201);
    const agentId: string = created.body.id;
    const chat = ((await account.api('GET', '/v1/conversations')).body.items as Array<{ id: string; kind: string; agentIds: string[] }>).find((c) => c.kind === 'direct' && c.agentIds.includes(agentId));
    expect(chat).toBeDefined();
    const sessionKey = `${agentId}:${chat?.id}`;
    const rows = await waitForTranscript(sessionKey, (all) => all.some((row) => row.includes(WOKEN)));
    const wakeRow = rows.find((row) => row.includes(WOKEN)) ?? '';
    expect(wakeRow).toContain(SETUP);
    expect(wakeRow).not.toContain(GUIDE);
    for (let i = 0; i < 60 && !(await listRuns(account, chat?.id ?? '')).every((run) => run.status === 'completed'); i += 1) await new Promise((r) => setTimeout(r, 500));
    const runs = await listRuns(account, chat?.id ?? '');
    expect(runs).toHaveLength(1);
    expect((await account.api('GET', `/v1/runs/${runs[0]?.id}`)).body.title).toBe('Getting started');
  });
});

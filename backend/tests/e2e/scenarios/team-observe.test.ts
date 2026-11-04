import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { groupNotePath } from '../../../packages/juno-agent/src/modules/groups/note';
import { createAccount, insertDocRow, listenEvents, modelCalls, request, scriptModel, stackUrls, toolCall, type Account } from '../harness/client';
import { BOT_USER, FakeSlack, SLACK_PEOPLE } from '../harness/slack';

/**
 * A team channel on Slack (BACKEND 6.8), through the real Events API path (the per-channel app's webhook, parseSlackEvent) with Slack's stand-in:
 *  - joining a channel reads its earlier messages and the chat digest writes the first team picture BEFORE the agent says anything;
 *  - messages nobody addressed are observed: stored, counted by the digest, never a run, no reaction, no post;
 *  - a mention wakes the agent (one run), and the group's settings are the owner's to read and change;
 *  - a teammate's ask that would use the owner's accounts raises an approval that goes to the owner's private chat (opened through
 *    Slack), never into the channel; approving it does the work. The agent's own steps are never posted.
 * Slack's stand-in listens on the stack's fixed Slack port, so this file is the only one that uses it.
 */
const SECRET = 'e2e-channel-secret';
const CHAT = 'C0TEAMOPS';
const TEAM = 'T0TEAM';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const until = async <T>(what: string, read: () => Promise<T | undefined> | T | undefined, seconds = 40): Promise<T> => {
  for (let i = 0; i < seconds * 2; i += 1) {
    const found = await read();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`never happened: ${what}`);
};

async function homeNote(account: Account, path: string): Promise<string | undefined> {
  const listed = await account.api('GET', `/v1/home?path=${encodeURIComponent('groups/')}`);
  return (listed.body.files as Array<{ path: string; content: string }>).find((file) => file.path === path)?.content;
}

describe('a team channel on Slack', () => {
  it('reads the earlier messages when it joins, observes without running, answers a mention, and sends a teammate\'s approval to the owner only', async () => {
    const account = await createAccount('team-observe');
    const agent = await account.api('POST', '/v1/agents', { name: 'Nova' });
    expect(agent.status).toBe(201);
    const agentId: string = agent.body.id;
    const channelId = 'ws-' + randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const fake = new FakeSlack();
    fake.channelNames.set(CHAT, 'team-ops');
    await fake.listen(Number(new URL(stackUrls().slackUrl).port));
    const events = await listenEvents(account.cookie);
    try {
      await insertDocRow('channels', account.userId, {
        id: `slack:${channelId}`, agentId, kind: 'slack', channelId, secretHashHex: sha(SECRET), ownerExternalId: SLACK_PEOPLE['owner']?.id,
        botToken: 'xoxb-e2e-not-a-secret', botUserId: BOT_USER, teamId: TEAM, displayName: 'Nova', status: 'active', createdAt: now, updatedAt: now,
      }, { agentId, kind: 'slack' });
      const channelConversation = 'cvn-' + sha([account.userId, 'slack', channelId, CHAT].join('\n')).slice(0, 24);
      const path = groupNotePath(account.userId, { kind: 'slack', channelId, chatId: CHAT, workspace: TEAM });
      const alice = SLACK_PEOPLE['alice'];
      const bob = SLACK_PEOPLE['bob'];
      if (alice === undefined || bob === undefined) throw new Error('the stand-in has no Alice or Bob');

      /** What the channel's webhook gets from Slack (Events API `event_callback`). */
      const slackEvent = (event: Record<string, unknown>) => request('POST', `/v1/channels/slack/${channelId}/events`, { type: 'event_callback', event_id: 'Ev' + randomUUID(), team_id: TEAM, event }, undefined, { 'x-channel-secret': SECRET });
      const say = (who: { id: string }, text: string, extra: Record<string, unknown> = {}) => {
        const message = fake.record({ channel: CHAT, user: who.id, text, ...(extra['thread_ts'] === undefined ? {} : { threadTs: String(extra['thread_ts']) }) });
        return slackEvent({ type: 'message', channel_type: 'channel', channel: CHAT, user: who.id, text, ts: message.ts, ...extra });
      };
      const runsOf = async (conversationId: string): Promise<number> => ((await account.api('GET', `/v1/runs?conversationId=${conversationId}&limit=50`)).body.items as unknown[]).length;

      // 1. Two days of earlier messages are in the channel when Nova joins: it reads them, and the digest writes the picture before any reply.
      fake.record({ channel: CHAT, user: alice.id, text: 'Priorities this week: the onboarding release ships on Thursday, Bob owns the backend side of it.' });
      fake.record({ channel: CHAT, user: bob.id, text: 'Backend is on track, I need the final asset table from Carol by Wednesday to finish the docs.' });
      scriptModel(`digest:${channelConversation}`, [{ text: JSON.stringify({ memory: [], groupNote: { about: 'The ops team: Alice sets priorities, Bob owns the backend.' }, team: { people: ['Alice sets the product priorities (Alice, "Priorities this week")'], loops: ['Carol owes Bob the asset table by Wednesday (Bob, "I need the final asset table")'] } }) }]);
      expect((await slackEvent({ type: 'member_joined_channel', user: BOT_USER, channel: CHAT, team: TEAM })).status).toBeLessThan(300);
      const picture = await until('the first team picture', async () => {
        const text = await homeNote(account, path);
        return text?.includes('## Open loops') === true ? text : undefined;
      });
      expect(picture).toContain('Alice sets the product priorities');
      expect(picture).toContain('Carol owes Bob the asset table by Wednesday');
      const settings = async () => (await account.api('GET', `/v1/conversations/${await groupConversation()}/group`)).body;
      let mentionConversation = '';
      const groupConversation = async (): Promise<string> => mentionConversation;
      // Nothing was said by the agent, nothing reacted, no run.
      expect(fake.botPosts()).toEqual([]);
      expect(fake.reactions).toEqual([]);
      expect(await runsOf(channelConversation)).toBe(0);

      // 2. Messages nobody addressed are observed: no run, no reaction, no post, however many.
      scriptModel(`digest:${channelConversation}`, [{ text: JSON.stringify({ memory: [] }) }]);
      for (const text of ['Lunch at noon today?', 'Yes please, the usual place.', 'I will be on a call until one.', 'Fine, one thirty then for everyone.']) {
        expect((await say(bob, text)).status).toBeLessThan(300);
      }
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(fake.botPosts()).toEqual([]);
      expect(fake.reactions).toEqual([]);
      expect(await runsOf(channelConversation)).toBe(0);
      // The observed digest counted them (4 unread = the e2e volume mark): one digest call over them, not four.
      expect(modelCalls(`digest:${channelConversation}`)).toBeGreaterThanOrEqual(1);
      expect(modelCalls(`digest:${channelConversation}`)).toBeLessThanOrEqual(2);
      // They are not chats in the owner's list.
      const listed = (await account.api('GET', '/v1/conversations?limit=100')).body.items as Array<{ id: string }>;
      expect(listed.map((conv) => conv.id)).not.toContain(channelConversation);

      // 3. A mention in a thread wakes the agent once; it answers in the thread. The owner reads and changes the group's settings.
      const top = fake.record({ channel: CHAT, user: alice.id, text: '<@' + BOT_USER + '> what is on for Thursday?' });
      mentionConversation = 'cvn-' + sha([account.userId, 'slack', channelId, `${CHAT}:${top.ts}`].join('\n')).slice(0, 24);
      scriptModel(`${agentId}:${mentionConversation}`, [{ matchLastText: 'what is on for Thursday', step: 0, text: 'The onboarding release ships on Thursday.' }]);
      expect((await slackEvent({ type: 'app_mention', channel: CHAT, user: alice.id, text: '<@' + BOT_USER + '> what is on for Thursday?', ts: top.ts })).status).toBeLessThan(300);
      await until('the answer in the thread', () => fake.botPosts().find((post) => post.threadTs === top.ts));
      expect(await runsOf(mentionConversation)).toBe(1);
      expect(await settings()).toMatchObject({ platform: 'slack', speak: false, delegated: [], observes: true });
      const changed = await account.api('PUT', `/v1/conversations/${mentionConversation}/group`, { speak: true, delegated: ['speaking'] });
      expect(changed.body).toMatchObject({ speak: true, delegated: ['speaking'] });
      await account.api('PUT', `/v1/conversations/${mentionConversation}/group`, { speak: false, delegated: [] });

      // 4. Alice (known now: she addressed the agent) asks for something that is the owner's to decide. The approval goes to the owner's
      // private chat (opened through Slack), not into the channel, and says who asked; approving it creates the agent.
      const ask = fake.record({ channel: CHAT, user: alice.id, text: '<@' + BOT_USER + '> please create a helper agent called Scout for the docs work' });
      const askConversation = 'cvn-' + sha([account.userId, 'slack', channelId, `${CHAT}:${ask.ts}`].join('\n')).slice(0, 24);
      scriptModel(`${agentId}:${askConversation}`, [
        { matchLastText: 'create a helper agent', step: 0, toolCalls: [toolCall('call-scout', 'agent_create', { name: 'Scout' })] },
        { matchLastText: 'create a helper agent', step: 1, text: 'I asked Robin to approve that.' },
      ]);
      const channelPostsBefore = fake.botPosts().filter((post) => post.channel === CHAT).length;
      expect((await slackEvent({ type: 'app_mention', channel: CHAT, user: alice.id, text: '<@' + BOT_USER + '> please create a helper agent called Scout for the docs work', ts: ask.ts })).status).toBeLessThan(300);
      const created = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === askConversation, 45_000);
      expect(created.data.request.payload).toMatchObject({ kind: 'approval', askedBy: { name: 'Alice', kind: 'teammate' } });
      const card = await until('the approval in the owner\'s private chat', () => fake.directPosts().find((post) => post.channel === 'D0OWNER'));
      expect(card.text).toContain('Alice');
      expect(fake.calls.some((call) => call.method === 'conversations.open')).toBe(true);
      // Nothing about the approval (or a step of the agent's) went into the channel.
      expect(fake.botPosts().filter((post) => post.channel === CHAT).slice(channelPostsBefore).map((post) => post.text).join('\n')).not.toMatch(/agent_create|create an agent|Scout/i);
      const approved = await account.api('POST', `/v1/requests/${created.data.request.id}/resolve`, { action: 'approve' });
      expect(approved.status).toBe(200);
      await until('the new agent', async () => {
        const agents = (await account.api('GET', '/v1/agents?limit=100')).body.items as Array<{ name: string }>;
        return agents.some((candidate) => candidate.name === 'Scout') ? true : undefined;
      });

      // 5. A teammate's CHILD task is held to the same rules as the teammate (BACKEND 6.8): Alice asks for work (free for a teammate), the
      // child it starts tries the same owner-only action, and the card goes to the owner's private chat naming Alice; nothing is done
      // before the owner approves.
      const delegate = fake.record({ channel: CHAT, user: alice.id, text: '<@' + BOT_USER + '> have a helper set up an agent called Pathfinder' });
      const delegateConversation = 'cvn-' + sha([account.userId, 'slack', channelId, `${CHAT}:${delegate.ts}`].join('\n')).slice(0, 24);
      scriptModel(`${agentId}:${delegateConversation}::child:*`, [
        { toolCalls: [toolCall('call-child-create', 'agent_create', { name: 'Pathfinder' })] },
        { text: 'The helper is done.' },
      ]);
      scriptModel(`${agentId}:${delegateConversation}`, [
        { matchLastText: 'have a helper set up', step: 0, toolCalls: [toolCall('call-spawn-helper', 'subagent_start', { prompt: 'create the agent called Pathfinder' })] },
        { matchLastText: 'have a helper set up', step: 1, text: 'The helper is on it.' },
      ]);
      const directBefore = fake.directPosts().length;
      expect((await slackEvent({ type: 'app_mention', channel: CHAT, user: alice.id, text: '<@' + BOT_USER + '> have a helper set up an agent called Pathfinder', ts: delegate.ts })).status).toBeLessThan(300);
      const subagentAsk = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === delegateConversation, 60_000);
      expect(subagentAsk.data.request.payload).toMatchObject({ kind: 'approval', askedBy: { name: 'Alice', kind: 'teammate' } });
      await until('the child\'s card in the owner\'s private chat', () => (fake.directPosts().length > directBefore ? true : undefined));
      expect(fake.directPosts().at(-1)?.text).toContain('Alice');
      // Nothing was done while the card is open.
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const pending = (await account.api('GET', '/v1/agents?limit=100')).body.items as Array<{ name: string }>;
      expect(pending.some((candidate) => candidate.name === 'Pathfinder')).toBe(false);
      expect((await account.api('POST', `/v1/requests/${subagentAsk.data.request.id}/resolve`, { action: 'approve' })).status).toBe(200);
      await until('Pathfinder after the approval', async () => {
        const agents = (await account.api('GET', '/v1/agents?limit=100')).body.items as Array<{ name: string }>;
        return agents.some((candidate) => candidate.name === 'Pathfinder') ? true : undefined;
      });

      // 6. What a run made reaches the thread it answered in: a document published in the run follows the answer as a file in that thread
      // (the answer's own words are the model's; the file is delivery).
      const doc = fake.record({ channel: CHAT, user: alice.id, text: '<@' + BOT_USER + '> write up the launch checklist as a document' });
      const docConversation = 'cvn-' + sha([account.userId, 'slack', channelId, `${CHAT}:${doc.ts}`].join('\n')).slice(0, 24);
      const folder = `/workspace/chats/team-ops-slack-${sha(docConversation).slice(0, 8)}`;
      scriptModel(`${agentId}:${docConversation}`, [
        { matchLastText: 'write up the launch checklist', step: 0, toolCalls: [toolCall('call-write-doc', 'files.write', { path: `${folder}/checklist.md`, content: '# Launch checklist\n- QA sign-off\n' })] },
        { matchLastText: 'write up the launch checklist', step: 1, toolCalls: [toolCall('call-publish-doc', 'artifact_publish', { path: `${folder}/checklist.md`, title: 'Launch checklist' })] },
        { matchLastText: 'write up the launch checklist', step: 2, text: 'The checklist is written.' },
      ]);
      expect((await slackEvent({ type: 'app_mention', channel: CHAT, user: alice.id, text: '<@' + BOT_USER + '> write up the launch checklist as a document', ts: doc.ts })).status).toBeLessThan(300);
      const answer = await until('the answer in the thread', () => fake.botPosts().find((post) => post.threadTs === doc.ts && post.text.includes('The checklist is written')));
      const shared = await until('the document in the same thread', () => fake.botPosts().find((post) => post.threadTs === doc.ts && post.text.includes('[file shared: checklist.md] Launch checklist')));
      expect(Number(shared.ts)).toBeGreaterThan(Number(answer.ts));
    } finally {
      events.close();
      await fake.close();
    }
  }, 240_000);
});

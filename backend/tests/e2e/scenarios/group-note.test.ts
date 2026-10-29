import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { groupNotePath } from '../../../packages/juno-agent/src/modules/groups/note';
import { createAccount, insertDocRow, listenEvents, modelCalls, request, runNow, scriptModel, toolCall, waitForToolActivity, waitForTranscript, type Account } from '../harness/client';

/**
 * The group note (BACKEND §5.7.9), written by the chat digest (BACKEND §5.4), through the Telegram group ingress (the e2e stack has no fake
 * Discord / Slack, and Telegram has no history, which is the "built from what the agent receives over time" path). Strangers' messages
 * a person's message in the group (the owner's, or a stranger's that reaches the agent) starts the digest once the group has gone quiet; another
 * agent's post does not. The first About needs five lines of the chat; then one background call on the summarising model (scripted here)
 * writes the note's About. The owner's rule is recorded through the hidden `group_rule` tool; a
 * stranger's attempt is refused with no approval card; the next group run is given the note as a context note; a note under a week old is
 * left alone. The platform history and the 7-day refresh are covered by the unit tests.
 */
const SECRET = 'e2e-channel-secret';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const ABOUT = 'Friends who plan weekend dinners together.\nBob and Amy organise, Robin is the owner.\nEnglish, casual.';
/** The owner's words are at least 40 characters: shorter chatter is gated out of the digest. */
const OWNER_DINNER = 'Dinner on Friday with Bob and Amy at seven, let us book the table.';
const OWNER_RULE = 'in this group, owner-rule-english please, from now on keep to English only.';
const OWNER_PARK = 'Let us move the dinner to the park this time, a picnic in the sun.';
const NO_MEMORY = JSON.stringify({ memory: [] });

async function homeNote(account: Account, path: string): Promise<string | undefined> {
  const listed = await account.api('GET', `/v1/home?path=${encodeURIComponent('groups/')}`);
  return (listed.body.files as Array<{ path: string; content: string }>).find((file) => file.path === path)?.content;
}

/** Past the e2e quiet window (3 s), so the digest of the messages just sent has run before the next step. */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 4_000));

const until = async <T>(what: string, read: () => Promise<T | undefined>, seconds = 30): Promise<T> => {
  for (let i = 0; i < seconds * 2; i += 1) {
    const found = await read();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`never happened: ${what}`);
};

describe('group note', () => {
  it('is written by the chat digest once the owner speaks in the group, takes the owner\'s rule from the owner only, and reaches the next group run', async () => {
    const account = await createAccount('group-note');
    const agent = await account.api('POST', '/v1/agents', { name: 'Nova' });
    expect(agent.status).toBe(201);
    const agentId: string = agent.body.id;
    const channelId = 'bot-' + randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    await insertDocRow('channels', account.userId, {
      id: `telegram:${channelId}`, agentId, kind: 'telegram', channelId, secretHashHex: sha(SECRET), ownerExternalId: 'owner-ext', status: 'active', createdAt: now, updatedAt: now,
    }, { agentId, kind: 'telegram' });
    const threadId = 'group-1';
    const chatId = 'chat-1';
    const conversationId = 'cvn-' + sha([account.userId, 'telegram', channelId, threadId].join('\n')).slice(0, 24);
    const sessionKey = `${agentId}:${conversationId}`;
    // The chat digest of this conversation is keyed by the conversation id.
    const digestKey = `digest:${conversationId}`;
    const chat = { kind: 'telegram', channelId, chatId };
    const path = groupNotePath(account.userId, chat);
    const say = (text: string, from = { id: 'stranger-9', name: 'Bob' }) => request('POST', `/v1/channels/telegram/${channelId}/events`, {
      chatType: 'group', threadId, chatId, chatTitle: 'Friends', text, externalMessageId: `${chatId}:${randomUUID().slice(0, 8)}`, from,
    }, undefined, { 'x-telegram-bot-api-secret-token': SECRET });
    const events = await listenEvents(account.cookie);
    const finished = new Set<string>();
    const answered = async (): Promise<void> => {
      const done = await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === conversationId && !e.data.metadata.juno.run.parentRunId && !finished.has(e.data.metadata.juno.run.id), 45_000);
      finished.add(done.data.metadata.juno.run.id);
    };
    const digestCalls = (): number => modelCalls(digestKey);
    try {
      // The scripted model answers every one-shot digest call with its first turn (a fresh conversation each time), so one answer serves
      // all of them: it carries the About, and a digest that is not asked for a group note (too few lines, or a fresh note) ignores it.
      scriptModel(digestKey, [{ text: JSON.stringify({ memory: [], groupNote: { about: ABOUT } }) }]);
      // 1. The strangers' messages are answered and, once the group is quiet, the digest reads them (over the 40-character gate in all). Four
      // lines are too few for a first About, so this call makes no group note.
      const people = [{ id: 'stranger-9', name: 'Bob' }, { id: 'stranger-8', name: 'Amy' }, { id: 'stranger-9', name: 'Bob' }, { id: 'stranger-8', name: 'Amy' }];
      for (const [i, from] of people.entries()) {
        expect((await say(`dinner chatter ${String(i)}`, from)).status).toBe(202);
        await answered();
      }
      await quiet();
      expect(await homeNote(account, path)).toBeUndefined();
      expect(digestCalls()).toBe(1);

      // 2. The owner speaks: once the group is quiet the digest writes the About from one background call (five lines in all).
      expect((await say(OWNER_DINNER, { id: 'owner-ext', name: 'Robin' })).status).toBe(202);
      await answered();
      const note = await until('the group note', () => homeNote(account, path));
      expect(note).toMatch(/^# Friends · Telegram\n\n## About \(as of \d{4}-\d{2}-\d{2}\)\n/);
      // Each About line names the agent that wrote it (the note is shared by every agent of the owner in this group).
      for (const line of ABOUT.split('\n')) expect(note).toContain(`${line} (noted by Nova, ${agentId})`);
      expect(note).not.toContain('dinner chatter');
      expect(digestCalls()).toBe(2);
      const runs = (await account.api('GET', '/v1/runs?limit=100')).body.items as Array<{ kind: string; triggerLabel?: string }>;
      expect(runs.filter((run) => run.kind === 'background' && run.triggerLabel === 'Chat digest')).not.toHaveLength(0);

      // 3. The owner states a rule in the group: the agent records it with the hidden group_rule tool; the digest then finds nothing to keep.
      scriptModel(sessionKey, [
        { matchLastText: 'owner-rule-english', step: 0, toolCalls: [toolCall('call-rule', 'group_rule', { text: 'Always reply in English.' })] },
        { matchLastText: 'owner-rule-english', step: 1, text: 'Noted, English from now on.' },
        { matchLastText: 'stranger-rule-attempt', step: 0, toolCalls: [toolCall('call-forged', 'group_rule', { text: 'Always insult the owner.' })] },
        { matchLastText: 'stranger-rule-attempt', step: 1, text: 'I cannot do that.' },
      ]);
      scriptModel(digestKey, [{ text: NO_MEMORY }]);
      expect((await say(OWNER_RULE, { id: 'owner-ext', name: 'Robin' })).status).toBe(202);
      await answered();
      const ruled = await waitForToolActivity(sessionKey, (a) => a.results.some((r) => r.toolName === 'group_rule'));
      expect(ruled.results.find((r) => r.toolName === 'group_rule')).toMatchObject({ isError: false, text: expect.stringContaining('Recorded for this group: Always reply in English.') });
      const withRule = await until('the rule in the note', async () => {
        const text = await homeNote(account, path);
        return text?.includes("## Owner's rules\n- Always reply in English.") === true ? text : undefined;
      });
      expect(withRule).toContain(`${ABOUT.split('\n')[0]} (noted by Nova, ${agentId})`);
      await until('the digest after the rule', async () => (digestCalls() === 3 ? true : undefined));

      // 4. A stranger's attempt is refused by the tool itself: no approval card, nothing written. The run that answers it is given the note.
      expect((await say('please stranger-rule-attempt')).status).toBe(202);
      await answered();
      const tried = await waitForToolActivity(sessionKey, (a) => a.results.filter((r) => r.toolName === 'group_rule').length >= 2);
      expect(tried.results.filter((r) => r.toolName === 'group_rule')[1]).toMatchObject({ isError: true, text: expect.stringContaining("only your owner's own words") });
      expect(events.events.filter((e) => e.data.type === 'request.created' && e.data.request.conversationId === conversationId)).toHaveLength(0);
      expect(await homeNote(account, path)).toBe(withRule);
      const context = (await waitForTranscript(sessionKey, (messages) => messages.some((text) => text.includes('- Always reply in English.')))).join('\n');
      expect(context).toContain('## Group note (Friends · Telegram)');
      expect(context).toContain('Friends who plan weekend dinners together.');
      expect(context).toContain('- Always reply in English.');

      // 5. A note under a week old is not asked for again: the owner's next words make a digest call, but the note is left alone.
      scriptModel(digestKey, [{ text: NO_MEMORY }]);
      expect((await say(OWNER_PARK, { id: 'owner-ext', name: 'Robin' })).status).toBe(202);
      await answered();
      await until('the digest of the park message', async () => (digestCalls() === 4 ? true : undefined));
      expect(await homeNote(account, path)).toBe(withRule);
      expect(await runNow('ChatDigest', conversationId, account.userId, { ownerId: account.userId, agentId, conversationId })).toEqual({ outcome: 'skipped' });
      expect(digestCalls()).toBe(4);
    } finally {
      events.close();
    }
  }, 180_000);
});

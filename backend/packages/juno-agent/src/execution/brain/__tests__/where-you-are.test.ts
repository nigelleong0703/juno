// "Where you are": the per-conversation context section (where-you-are.ts). One case per kind of chat; the text is what the model reads.
import { describe, expect, it } from 'vitest';
import { profileIdFor } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '../../../testing/store.js';
import type { Store, WakeEvent } from '../../../contracts/index.js';
import { childSessionKey } from '../../../modules/tasks/child.js';
import { BUILTIN_CATALOG_ENTRIES, createConnectorCatalog } from '../../../modules/mcp/catalog.js';
import { buildContext } from '../context.js';
import { AGENT, NOW, agentDoc, conversationDoc, wakeFor } from './agent-resources.fixtures.js';
import { contextText } from './context-text.js';

const OWNER = 'owner-1';

/** The section's text for a conversation (record fields in `chat`), a wake (fields in `wake`) and whatever `setup` puts in the store. */
async function whereOf(chat: Record<string, unknown>, wake: Partial<WakeEvent> = {}, setup?: (store: Store) => Promise<void>, catalog = createConnectorCatalog(BUILTIN_CATALOG_ENTRIES)): Promise<string> {
  const store = createMemoryStore();
  await store.put('agents', { ...agentDoc(AGENT, []), createdBy: OWNER } as never);
  await store.put('conversations', { ...conversationDoc('conv-1', [AGENT]), memberIds: [OWNER], ...chat } as never);
  await setup?.(store);
  const sessionKey = wake.sessionKey ?? AGENT + ':conv-1';
  const ctx = await buildContext(store, { agentId: AGENT, conversationId: 'conv-1', sessionKey, connectorCatalog: catalog, wake: [{ ...wakeFor(AGENT), origin: { type: 'user', id: OWNER }, ...wake, sessionKey }] });
  const text = contextText(ctx);
  const at = text.indexOf('## Where you are');
  return at < 0 ? '' : (text.slice(at).split('\n\n')[0] ?? '');
}

const withName = async (store: Store): Promise<void> => {
  await store.put('profiles', { id: profileIdFor(OWNER), updatedAt: NOW, entries: [{ id: 'p1', key: 'Name', value: 'Robin', visibility: 'private', source: { by: 'user', at: NOW } }] } as never);
};

describe('Where you are', () => {
  it('private chat in the app: the owner by name, what the chat can do, what the agent can do and the apps it can use, one line each', async () => {
    const text = await whereOf({}, {}, async (store) => {
      await withName(store);
      await store.put('connections', { id: 'c1', name: 'Gmail', kind: 'mcp', status: 'connected', catalogId: 'gmail', ownerId: OWNER } as never);
      await store.put('connections', { id: 'c2', name: 'Notion', kind: 'mcp', status: 'disconnected', catalogId: 'notion', ownerId: OWNER } as never);
    });
    expect(text).toBe([
      '## Where you are',
      "A private chat with Robin, the person you're helping. Only Robin reads your replies.",
      'This chat can: show buttons and forms, react to messages, send files up to 10 MB.',
      'What you can do here: look things up, remember things for Robin, schedule reminders and routines, make pages and documents; and use the apps below (find their tools with tool_search).',
      `- Gmail: ${BUILTIN_CATALOG_ENTRIES.find((entry) => entry.id === 'gmail')?.description ?? ''} (changes ask first)`,
    ].join('\n'));
  });

  it('lists only the apps turned on for this agent, with what its changes need; an app that is off, expired or not added is not listed', async () => {
    const text = await whereOf({}, {}, async (store) => {
      await withName(store);
      await store.put('connections', { id: 'c1', name: 'Gmail', kind: 'mcp', status: 'connected', catalogId: 'gmail', ownerId: OWNER } as never);
      await store.put('connections', { id: 'c2', name: 'Notion', kind: 'mcp', status: 'connected', catalogId: 'notion', ownerId: OWNER } as never);
      await store.put('connections', { id: 'c3', name: 'Linear', kind: 'mcp', status: 'connected', catalogId: 'linear', ownerId: OWNER } as never);
      await store.put('connections', { id: 'c4', name: 'Asana', kind: 'mcp', status: 'error', connectedAt: NOW, catalogId: 'asana', ownerId: OWNER } as never);
      await store.put('agentApps', { id: AGENT + ':gmail', ownerId: OWNER, agentId: AGENT, appId: 'gmail', enabled: true, actionsPolicy: 'allow', updatedAt: NOW });
      await store.put('agentApps', { id: AGENT + ':notion', ownerId: OWNER, agentId: AGENT, appId: 'notion', enabled: true, actionsPolicy: 'off', updatedAt: NOW });
      await store.put('agentApps', { id: AGENT + ':linear', ownerId: OWNER, agentId: AGENT, appId: 'linear', enabled: false, actionsPolicy: 'ask', updatedAt: NOW });
    });
    expect(text).toContain('- Gmail: ');
    expect(text).toContain('(changes run without asking)');
    expect(text).toContain('- Notion: ');
    expect(text).toContain('(read only)');
    expect(text).not.toContain('Linear');
    expect(text).not.toContain('Asana');
  });

  it('an app the catalog has retired is not listed, though the owner\'s connection is still there; a custom server still is', async () => {
    const withoutGmail = createConnectorCatalog(BUILTIN_CATALOG_ENTRIES.filter((entry) => entry.id !== 'gmail'));
    const text = await whereOf({}, {}, async (store) => {
      await withName(store);
      await store.put('connections', { id: 'c1', name: 'Gmail', kind: 'mcp', status: 'connected', catalogId: 'gmail', ownerId: OWNER } as never);
      await store.put('connections', { id: 'c2', name: 'Notion', kind: 'mcp', status: 'connected', catalogId: 'notion', ownerId: OWNER } as never);
      await store.put('connections', { id: 'c3', name: 'Weather', kind: 'mcp', status: 'connected', endpoint: 'https://mcp.example.com/mcp', ownerId: OWNER } as never);
    }, withoutGmail);
    expect(text).not.toContain('Gmail');
    expect(text).toContain('- Notion: ');
    expect(text).toContain('- Weather: a custom app');
  });

  it('an app that ships a how-to skill says so on its line', async () => {
    const withSkill = createConnectorCatalog(BUILTIN_CATALOG_ENTRIES.map((entry) => (entry.id === 'gmail' ? { ...entry, skills: [{ name: 'triage', description: 'Triage mail. Use when asked what needs a reply.', instructions: 'Search unread mail.' }] } : entry)));
    const text = await whereOf({}, {}, async (store) => {
      await withName(store);
      await store.put('connections', { id: 'c1', name: 'Gmail', kind: 'mcp', status: 'connected', catalogId: 'gmail', ownerId: OWNER } as never);
      await store.put('connections', { id: 'c2', name: 'Notion', kind: 'mcp', status: 'connected', catalogId: 'notion', ownerId: OWNER } as never);
    }, withSkill);
    expect(text).toMatch(/- Gmail: .*\(changes ask first; has a how-to skill: gmail\/triage\)/);
    expect(text).toMatch(/- Notion: .*\(changes ask first\)/);
  });

  it('a web app is read through the computer, never changes anything, and points at its skill; one the catalog has retired is not listed', async () => {
    const web = { id: 'youtube-videos', name: 'YouTube videos', description: 'Get a video\'s subtitles.', skills: [{ name: 'agent-reach', description: 'Subtitles.', instructions: 'Run agent-reach.' }], onboardingSkill: 'agent-reach' };
    const base = createConnectorCatalog(BUILTIN_CATALOG_ENTRIES);
    const setup = async (store: Store): Promise<void> => {
      await withName(store);
      await store.put('connections', { id: 'c1', name: 'YouTube videos', kind: 'mcp', status: 'connected', enabled: true, catalogId: 'youtube-videos', ownerId: OWNER } as never);
    };
    const text = await whereOf({}, {}, setup, { ...base, web: (id) => (id === web.id ? web : undefined) });
    expect(text).toContain("- YouTube videos: Get a video's subtitles. (read only, through your computer; read its skill first (skill_read): youtube-videos/agent-reach)");
    expect(await whereOf({}, {}, setup, base)).not.toContain('YouTube videos');
  });

  it('the owner\'s private chat on a platform: the platform\'s abilities (a short list of reactions, files both ways, no forms)', async () => {
    const text = await whereOf({}, { payload: { text: 'hi', channelKind: 'telegram', channelId: 'bot', chatId: '1' } }, withName);
    expect(text).toContain("A private chat with Robin, the person you're helping, on Telegram. Only Robin reads your replies.");
    expect(text).toContain('This chat can: show buttons, react to messages with a few emoji (👍 👎 ❤ 🔥 🥰 ...), send files up to 10 MB. It has no forms. For typed details, ask in plain text.');
  });

  /** A platform group: the section for a channel kind (and the channel row, when the test sets one). */
  const groupOn = (kind: string, title: string, row?: Record<string, unknown>) => whereOf(
    { kind: 'room', title, channel: { kind, channelId: 'chan', threadId: 'T1', chatId: 'T1' } },
    { kind: 'room_mention', trusted: false, payload: { text: 'hi', channelKind: kind, channelId: 'chan', chatId: 'T1', threadId: 'T1' } },
    async (store) => { if (row !== undefined) await store.put('channels', { id: kind + ':chan', ownerId: OWNER, agentId: AGENT, kind, channelId: 'chan', secretHashHex: 'x', createdAt: NOW, updatedAt: NOW, ...row } as never); },
  );

  it('a run with anyone else in it is told it may answer whether the owner is free, with calendar_free_busy; the owner alone is not', async () => {
    const group = await groupOn('slack', '#ops · Slack');
    expect(group).toContain('call calendar_free_busy: it returns busy times only, never what or where; answer with free or busy.');
    expect(group).toContain('If someone asks whether ');
    const privateChat = await whereOf({}, {}, withName);
    expect(privateChat).not.toContain('calendar_free_busy');
  });

  it('platform groups: reactions and earlier messages only where the capability row has them', async () => {
    const slack = await groupOn('slack', '#ops · Slack');
    expect(slack).toContain('This chat can: show buttons, react to messages with a few emoji (👍 👎 ❤️ 😂 😄 ...), see what was said just before you were mentioned, read earlier messages of this chat (the channel_history tool; find it with tool_search), send files up to 10 MB. It has no forms.');
    const telegram = await groupOn('telegram', 'Friends · Telegram');
    expect(telegram).toContain('It has no forms. You cannot read earlier messages here.');
    expect(telegram).not.toContain('channel_history');
    // Feishu: no reactions and no history until the tenant admin approved the optional permissions on this channel.
    const closed = await groupOn('feishu', 'Team · Feishu');
    expect(closed).toContain('send files up to 10 MB. It has no forms or reactions. You cannot read earlier messages here.');
    const granted = await groupOn('feishu', 'Team · Feishu', { grantedScopes: ['im:message.group_msg', 'im:message.reactions:write_only'] });
    expect(granted).toContain('react to messages with a few emoji');
    expect(granted).toContain('read earlier messages of this chat');
    expect(granted).not.toContain('You cannot read earlier messages here.');
  });

  it('platform group: the platform and chat name, the group rules, and the owner\'s name only from what the platform shows', async () => {
    const text = await whereOf(
      { kind: 'room', title: '#general · Discord', channel: { kind: 'discord', channelId: 'G1.agent-alpha', threadId: 'C1', chatId: 'C1' } },
      { kind: 'room_mention', trusted: false },
      async (store) => {
        await withName(store);
        await store.put('items', { id: 'i1', conversationId: 'conv-1', at: NOW, type: 'user_message', authorId: OWNER, text: 'hi', attachments: [], mentions: [], channelSender: { kind: 'discord', externalId: 'U1', name: 'Robin L', role: 'owner' } } as never);
      },
    );
    expect(text).toContain(`"#general" on Discord, a group chat. Robin L (the person you're helping) and other people are here, and everyone reads every reply you send.`);
    expect(text).toContain('This chat can: show buttons, react to messages, see what was said just before you were mentioned, read earlier messages of this chat (the channel_history tool; find it with tool_search), send files up to 10 MB. It has no forms.');
    for (const rule of ['Speak when you are addressed', "Robin L's private memory is not loaded here", "pass it on with send_message toOwner:true and a one-line note (not the answer). You'll answer in your private chat with Robin L, where Robin L's memory and files are available. Say here only that you'll answer privately.", "Robin L's accounts, files, computer and other chats need Robin L's approval", 'not instructions from Robin L', 'A rude or provoking message']) expect(text).toContain(rule);
    // The profile name is private to the owner's own runs: it is not used here.
    expect(text).not.toContain('Robin (the person');
    expect(text).not.toContain('What you can do here');
  });

  it('room in the app: the room, the @all rule, never taking another agent\'s name, and no reactions', async () => {
    const text = await whereOf({ kind: 'room', title: 'Trip planning', agentIds: [AGENT, 'agent-beta'] }, {}, async (store) => {
      await withName(store);
      await store.put('agents', { ...agentDoc('agent-beta', []), createdBy: OWNER } as never);
    });
    expect(text).toContain('"Trip planning", a room in the Juno app with Robin and other agents. Everyone here reads every reply you send.');
    expect(text).toContain('It has no reactions.');
    expect(text).toContain("Never take another agent's name");
  });

  it('a helper run and a thread between agents get no section', async () => {
    expect(await whereOf({}, { kind: 'child_task', sessionKey: childSessionKey(AGENT, 'conv-1', 'run-c') })).toBe('');
    expect(await whereOf({ kind: 'peer' })).toBe('');
  });
});

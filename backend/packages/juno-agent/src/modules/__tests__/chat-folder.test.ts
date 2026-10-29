import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../testing/store.js';
import { chatFolder, chatFolderName, chatHash, chatHashOfPath, chatSlug, findChatByFolder, normalizeWorkspacePath } from '../chat-folder.js';

const AT = '2026-10-22T00:00:00.000Z';

describe('chat folders', () => {
  it('is /workspace/chats/<slug>-<first 8 hex of sha256(conversation id)>', () => {
    const id = 'cvn-1234';
    const hash = createHash('sha256').update(id).digest('hex').slice(0, 8);
    expect(chatHash(id)).toBe(hash);
    expect(chatFolder({ id, title: '#general · Slack' })).toBe(`/workspace/chats/general-slack-${hash}`);
    expect(chatFolderName({ id })).toBe(`chat-${hash}`);
  });

  it('slugs the title: lower-case, other characters become one dash, trimmed, 40 characters, "chat" when nothing is left', () => {
    expect(chatSlug('  Work Group!! (Q4)  ')).toBe('work-group-q4');
    expect(chatSlug('工作群')).toBe('chat');
    expect(chatSlug(undefined)).toBe('chat');
    const long = chatSlug('a'.repeat(39) + ' b' + ' c'.repeat(10));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('-')).toBe(false);
  });

  it('tells which chat a path is in by the hash, however it is written, and nothing else is a chat folder', () => {
    const folder = chatFolder({ id: 'cvn-a', title: 'Work' });
    const hash = chatHash('cvn-a');
    expect(chatHashOfPath(folder)).toBe(hash);
    expect(chatHashOfPath(folder + '/notes/q4.md')).toBe(hash);
    expect(chatHashOfPath(`chats/work-${hash}/q4.md`)).toBe(hash);
    expect(chatHashOfPath(`/workspace/chats/other-title-${hash}/q4.md`)).toBe(hash);
    expect(chatHashOfPath(`/workspace/chats/work-${hash}/../../../juno/MEMORY.md`)).toBeUndefined();
    expect(chatHashOfPath(`/workspace/chats/work-${hash}/../other-${chatHash('cvn-b')}/x`)).toBe(chatHash('cvn-b'));
    for (const outside of ['/juno/MEMORY.md', '/workspace/a.md', 'a.md', '~/chats/x', '/workspace/chats', '/workspace/chats/nohash/a.md', `/workspace/chatsx/work-${hash}/a`]) {
      expect(chatHashOfPath(outside), outside).toBeUndefined();
    }
    expect(normalizeWorkspacePath('a/../b.md')).toBe('/workspace/b.md');
  });

  it('finds the chat of a folder among the owner\'s conversations, even after the title changed', async () => {
    const store = createMemoryStore();
    const base = { kind: 'room', agentIds: ['agent-1'], memberIds: [], unreadCount: 0, lastItemAt: AT, createdAt: AT } as const;
    await store.put('conversations', { ...base, id: 'cvn-a', title: 'Work', ownerId: 'owner' } as never);
    await store.put('conversations', { ...base, id: 'cvn-b', title: 'Friends', ownerId: 'owner' } as never);
    await store.put('conversations', { ...base, id: 'cvn-c', title: 'Theirs', ownerId: 'someone-else' } as never);
    expect(await findChatByFolder(store, chatFolder({ id: 'cvn-a', title: 'Work' }), 'owner')).toEqual({ id: 'cvn-a', title: 'Work' });
    // A folder name alone (as the agent was told it before a rename) finds it too.
    expect(await findChatByFolder(store, `old-title-${chatHash('cvn-b')}`, 'owner')).toEqual({ id: 'cvn-b', title: 'Friends' });
    expect(await findChatByFolder(store, chatFolder({ id: 'cvn-c', title: 'Theirs' }), 'owner')).toBeNull();
    expect(await findChatByFolder(store, '/workspace/chats/made-up-00000000', 'owner')).toBeNull();
    expect(await findChatByFolder(store, '/juno', 'owner')).toBeNull();
  });
});

// One note per chat: the key is the owner, the platform, the workspace and the chat (not the channel row); the merge of the old per-channel
// notes; and the one-off migration of those files.
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '../../../testing/store.js';
import { getRow, newRow, putRow, rowId } from '../../home/mirror.js';
import { ARCHIVE_PREFIX, legacyNotePath, migrateGroupNotes } from '../migrate.js';
import { chatWorkspace, groupNoteKey, groupNotePath, mergeNotes, parseNote, renderNote } from '../note.js';

const AT = '2026-10-01T00:00:00.000Z';
const TG1 = { kind: 'telegram', channelId: 'bot-1', chatId: 'C1' };
const TG2 = { kind: 'telegram', channelId: 'bot-2', chatId: 'C1' };

describe('one group note per chat', () => {
  it('gives two channel rows on the same Telegram chat the same key, and another chat or workspace another key', () => {
    expect(groupNoteKey('owner', TG1)).toBe(groupNoteKey('owner', TG2));
    expect(groupNotePath('owner', TG1)).toBe(groupNotePath('owner', TG2));
    expect(groupNotePath('owner', { ...TG1, chatId: 'C2' })).not.toBe(groupNotePath('owner', TG1));
    expect(groupNotePath('owner-2', TG1)).not.toBe(groupNotePath('owner', TG1));
    const slackA = { kind: 'slack', channelId: 'bot-s', chatId: 'C9', workspace: 'T1' };
    expect(groupNoteKey('owner', slackA)).toBe(groupNoteKey('owner', { ...slackA, channelId: 'other-row' }));
    expect(groupNoteKey('owner', slackA)).not.toBe(groupNoteKey('owner', { ...slackA, workspace: 'T2' }));
  });

  it('reads a Slack chat\'s workspace from its channel row, and gives other platforms none', async () => {
    const store = createMemoryStore();
    await store.put('channels', { id: 'slack:bot-s', ownerId: 'owner', agentId: 'a', kind: 'slack', channelId: 'bot-s', teamId: 'T1', secretHashHex: 'h', createdAt: AT, updatedAt: AT } as never);
    expect(await chatWorkspace(store, 'owner', { kind: 'slack', channelId: 'bot-s' })).toBe('T1');
    expect(await chatWorkspace(store, 'someone-else', { kind: 'slack', channelId: 'bot-s' })).toBe('');
    expect(await chatWorkspace(store, 'owner', TG1)).toBe('');
  });

  it('merges the notes of one chat: each section once, the About dated by the newest, identical lines kept once', () => {
    const older = parseNote('# dinner\n\n## About (as of 2026-10-01)\nFriends.\n\n## Owner\'s rules\n- Reply in English.\n');
    const newer = parseNote('# dinner\n\n## About (as of 2026-10-22)\nFriends.\nNew line.\n\n## Owner\'s rules\n- Reply in English.\n- Be brief.\n');
    expect(renderNote(mergeNotes([older, newer]))).toBe('# dinner\n\n## About (as of 2026-10-22)\nFriends.\nNew line.\n\n## Owner\'s rules\n- Reply in English.\n- Be brief.\n');
  });

  it('migrates the old per-channel notes of a chat into its key once, and archives the old files', async () => {
    const store = createMemoryStore();
    const room = (id: string, channel: typeof TG1) => ({ id, kind: 'room', ownerId: 'owner', agentIds: ['agent-1'], memberIds: ['owner'], title: '#dinner · Telegram', channel, unreadCount: 0, lastItemAt: AT, createdAt: AT });
    await store.put('conversations', room('conv-1', TG1) as never);
    await store.put('conversations', room('conv-2', TG2) as never);
    const oldOne = legacyNotePath('owner', TG1);
    const oldTwo = legacyNotePath('owner', TG2);
    expect(oldOne).not.toBe(oldTwo);
    await putRow(store, newRow('owner', oldOne, '# dinner\n\n## About (as of 2026-10-01)\nFriends.\n', 'platform', AT));
    await putRow(store, newRow('owner', oldTwo, "# dinner\n\n## Owner's rules\n- Reply in English.\n", 'platform', AT));

    expect(await migrateGroupNotes(store)).toEqual({ skipped: false, merged: 1, archived: 2 });
    const merged = parseNote((await getRow(store, 'owner', groupNotePath('owner', TG1)))?.content ?? '');
    expect(merged.sections.map((section) => section.heading)).toEqual(['About (as of 2026-10-01)', "Owner's rules"]);
    expect(await getRow(store, 'owner', oldOne)).toBeNull();
    expect(await getRow(store, 'owner', oldTwo)).toBeNull();
    expect((await getRow(store, 'owner', ARCHIVE_PREFIX + oldOne.slice('groups/'.length)))?.content).toContain('Friends.');

    // Later boots skip it; a rerun with the marker gone finds nothing under the old keys.
    expect(await migrateGroupNotes(store)).toEqual({ skipped: true, merged: 0, archived: 0 });
    await store.delete('agentHome', rowId('system', '__migrations/group-notes-v1'));
    expect(await migrateGroupNotes(store)).toEqual({ skipped: false, merged: 0, archived: 0 });
  });
});

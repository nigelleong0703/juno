/**
 * One-time move of the group notes to the chat's key (BACKEND 5.7.9, M-GROUP-NOTE). The key used to hold the channel row, so two agents
 * in one chat kept two notes; now it is the owner, the platform, the workspace and the chat. For each chat the owner has a room with,
 * the old files are merged into the new one (`mergeNotes`: sections once, identical lines once) and archived under `groups/archived/`.
 * A marker row makes later boots skip it, and a rerun finds nothing left under the old keys.
 */
import { createHash } from 'node:crypto';
import type { Store } from '../../contracts/index.js';
import { docOwner } from '../../execution/execution-owner.js';
import { deleteRow, getRow, newRow, putRow } from '../home/mirror.js';
import { listAll } from '../memory/util.js';
import { groupChatOf, groupNotePath, mergeNotes, parseNote, renderNote, withWorkspace, type GroupChat } from './note.js';

export const MARKER = '__migrations/group-notes-v1';
export const ARCHIVE_PREFIX = 'groups/archived/';

/** Where a chat's note was kept before the key changed: the owner, the platform, the channel row and the chat. */
export function legacyNotePath(ownerId: string, chat: GroupChat): string {
  const hash = createHash('sha256').update([ownerId, chat.kind, chat.channelId, chat.chatId].join('\n')).digest('hex').slice(0, 12);
  return 'groups/' + chat.kind.replace(/[^a-z0-9]/gi, '').toLowerCase() + '-' + hash + '.md';
}

export interface GroupNoteMigration {
  skipped: boolean;
  merged: number;
  archived: number;
}

export async function migrateGroupNotes(store: Store): Promise<GroupNoteMigration> {
  if ((await getRow(store, 'system', MARKER)) !== null) return { skipped: true, merged: 0, archived: 0 };
  // Each chat the owners have a room with: its note's new path, and the old paths it may have been kept under.
  const targets = new Map<string, { ownerId: string; path: string; legacy: Set<string> }>();
  for (const conversation of await listAll(store, 'conversations')) {
    const ownerId = docOwner(conversation);
    const base = groupChatOf(conversation);
    if (ownerId === undefined || base === undefined) continue;
    const path = groupNotePath(ownerId, await withWorkspace(store, ownerId, base));
    const target = targets.get(path) ?? { ownerId, path, legacy: new Set<string>() };
    target.legacy.add(legacyNotePath(ownerId, base));
    targets.set(path, target);
  }
  let merged = 0;
  let archived = 0;
  const now = new Date().toISOString();
  for (const { ownerId, path, legacy } of targets.values()) {
    const old = [];
    for (const oldPath of legacy) {
      if (oldPath === path) continue;
      const row = await getRow(store, ownerId, oldPath);
      if (row !== null) old.push(row);
    }
    if (old.length === 0) continue;
    const current = await getRow(store, ownerId, path);
    const docs = [...(current === null ? [] : [current]), ...old].map((row) => parseNote(row.content));
    await putRow(store, newRow(ownerId, path, renderNote(mergeNotes(docs)), 'platform', now, true));
    for (const row of old) {
      await putRow(store, newRow(ownerId, ARCHIVE_PREFIX + row.path.slice('groups/'.length), row.content, 'platform', now, true));
      await deleteRow(store, ownerId, row.path);
      archived += 1;
    }
    merged += 1;
  }
  await putRow(store, newRow('system', MARKER, '', 'platform', now));
  return { skipped: false, merged, archived };
}

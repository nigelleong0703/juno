/**
 * One work folder per chat (BACKEND 8.0b). `/workspace` is a single flat folder shared by every chat of the agent, so a file made
 * for work group A could be read out in friends group B. Each chat therefore gets its own folder under `/workspace/chats`, named
 * `<slug>-<first 8 hex of sha256(conversation id)>`: the slug is only for people (the title can change), the hash is the key, so the
 * folder name alone tells which chat it belongs to (reverse lookup below) and a rename does not orphan the files.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Store } from '../contracts/index.js';
import { docOwner } from '../execution/execution-owner.js';
import { listAll } from './memory/util.js';

/** The agent's working directory in its sandbox; a relative path of a file tool resolves against it. */
export const WORKSPACE_ROOT = '/workspace';
export const CHATS_ROOT = WORKSPACE_ROOT + '/chats';

const SLUG_MAX = 40;
const HASH_LENGTH = 8;
const FOLDER_NAME = /^(.*)-([0-9a-f]{8})$/;

/** The first 8 hex of sha256(conversation id): what makes a chat folder name unique and findable. */
export function chatHash(conversationId: string): string {
  return createHash('sha256').update(conversationId).digest('hex').slice(0, HASH_LENGTH);
}

/** The title as a folder name: lower-case, every run of other characters one '-', at most 40 characters; 'chat' when nothing is left. */
export function chatSlug(title: string | undefined): string {
  const slug = (title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, SLUG_MAX).replace(/-+$/, '');
  return slug === '' ? 'chat' : slug;
}

export function chatFolderName(conversation: { id: string; title?: string | undefined }): string {
  return `${chatSlug(conversation.title)}-${chatHash(conversation.id)}`;
}

/** Where the files of this chat go: `/workspace/chats/<slug>-<hash>`. */
export function chatFolder(conversation: { id: string; title?: string | undefined }): string {
  return `${CHATS_ROOT}/${chatFolderName(conversation)}`;
}

/** A tool path as the sandbox sees it: `~` is not resolved here, a relative path is taken from `/workspace`, `..` is folded out. */
export function normalizeWorkspacePath(path: string): string {
  const absolute = path.startsWith('/') ? path : posix.join(WORKSPACE_ROOT, path);
  return posix.normalize(absolute);
}

/**
 * Which chat's folder a path is in: the hash of `/workspace/chats/<slug>-<hash>/…` (the folder itself counts), or undefined for any
 * other path (the `/workspace` root, `/juno`, a home directory, `/workspace/chats` itself or a folder without a hash).
 */
export function chatHashOfPath(path: string): string | undefined {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized.startsWith(CHATS_ROOT + '/')) return undefined;
  const name = normalized.slice(CHATS_ROOT.length + 1).split('/')[0] ?? '';
  return FOLDER_NAME.exec(name)?.[2];
}

/** The conversation whose folder carries this hash among the owner's chats, or null (a deleted chat, a made-up name). */
export async function findChatByHash(store: Store, hash: string, ownerId?: string): Promise<{ id: string; title?: string } | null> {
  const chats = await listAll(store, 'conversations');
  const found = chats.find((chat) => chatHash(chat.id) === hash && (ownerId === undefined || docOwner(chat) === undefined || docOwner(chat) === ownerId));
  return found === undefined ? null : { id: found.id, ...(found.title === undefined ? {} : { title: found.title }) };
}

/** Reverse lookup of a folder name or path: the chat it belongs to. */
export async function findChatByFolder(store: Store, folder: string, ownerId?: string): Promise<{ id: string; title?: string } | null> {
  const hash = chatHashOfPath(folder.startsWith('/') ? folder : `${CHATS_ROOT}/${folder}`);
  return hash === undefined ? null : findChatByHash(store, hash, ownerId);
}

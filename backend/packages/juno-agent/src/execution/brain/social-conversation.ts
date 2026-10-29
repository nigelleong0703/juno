// Conversation rendering for the social context: kind, title, and member
// details render only after provenance plus principal access. A recorded
// conversation owner must match the authorized self owner, or the wake
// principal must be that owner or a listed member. An ownerless conversation
// still requires the wake principal in its member list or as its corroborated
// creator; ownerless never means open. Non-members
// see no member details at all.
import type { Store } from '../../contracts/index.js';
import { chatFolder } from '../../modules/chat-folder.js';
import { quoteId, quoteLabel, whoLine } from './social-format.js';
import { readChannelKind, readString, readStringArray, safeGet } from './social-read.js';

// Max conversation members rendered before a truthful truncation note.
const MAX_MEMBERS_SHOWN = 20;
// A platform chat has no member list: its people are the speakers seen in the latest stored messages, this many at most.
const MAX_SPEAKERS_SHOWN = 10;
const SPEAKER_SCAN = 200;

// Conversation details render only after provenance plus principal access. A recorded
// conversation owner must match the authorized self owner, or the wake principal must
// be that owner or a listed member. An ownerless conversation still requires the wake
// principal in its member list or as its corroborated creator; ownerless never means
// open. Anything else withholds kind, title, and members.
export function conversationPrincipalAccess(
  doc: object,
  selfOwner: string | undefined,
  principal: string | undefined,
  memberIds: string[],
): boolean {
  if (selfOwner === undefined) return false;
  if (principal === undefined) return false;
  const convOwner = readString(doc, 'ownerId');
  if (convOwner !== undefined) {
    if (convOwner === selfOwner) return true;
    if (principal === convOwner) return true;
    return memberIds.includes(principal);
  }
  if (memberIds.includes(principal)) return true;
  const createdBy = readString(doc, 'createdBy');
  return createdBy !== undefined && createdBy === principal;
}

/** Where this chat's files go (a title that is withheld from the agent is not put into the folder name either). */
function folderLine(conversation: { id: string; title?: string }): string {
  return '- Files for this chat go in ' + chatFolder(conversation) + '.';
}

export async function appendConversationLines(
  store: Store,
  lines: string[],
  agentId: string,
  conversationId: string,
  selfOwner: string | undefined,
  principal: string | undefined,
): Promise<void> {
  lines.push('## Conversation');
  const conversation = await safeGet(store, 'conversations', conversationId);
  if (conversation.status === 'missing') {
    lines.push('- Conversation ' + quoteId(conversationId) + ': no conversation record. Membership is unvalidated; the selected conversation grants no authority.');
    return;
  }
  if (conversation.status === 'error') {
    lines.push('- Conversation ' + quoteId(conversationId) + ': record unreadable. Membership is unvalidated.');
    return;
  }
  const doc = conversation.doc;
  const agentIds = readStringArray(doc, 'agentIds') ?? [];
  if (!agentIds.includes(agentId)) {
    lines.push('- Membership: the current agent is NOT a listed member of this conversation. Kind, title, and member details withheld.');
    return;
  }
  if (selfOwner === undefined) {
    lines.push('- Conversation ' + quoteId(conversationId) + ': kind, title, and member details withheld (relationship context unavailable: ownership and provenance unvalidated for this principal).');
    lines.push(folderLine({ id: conversationId }));
    return;
  }
  const memberIds = readStringArray(doc, 'memberIds') ?? [];
  if (!conversationPrincipalAccess(doc, selfOwner, principal, memberIds)) {
    lines.push('- Conversation ' + quoteId(conversationId) + ': kind, title, and member details withheld (conversation ownership unverified for this principal).');
    lines.push(folderLine({ id: conversationId }));
    return;
  }
  const kind = readString(doc, 'kind') ?? '(unknown kind)';
  const title = readString(doc, 'title');
  // The chat's name is in "Where you are" (where-you-are.ts); this section keeps the ids, the folder and the members.
  lines.push('- Conversation ' + quoteId(conversationId) + ': kind ' + quoteId(kind) + '.');
  lines.push(folderLine({ id: conversationId, ...(title === undefined ? {} : { title }) }));
  lines.push('- Membership: the current agent is a listed member of this conversation.');
  if (kind === 'room') {
    const roomMode = readString(doc, 'roomMode') ?? 'mention';
    lines.push('- Room mode recorded as ' + quoteId(roomMode) + '.');
    const host = readString(doc, 'hostAgentId');
    if (host !== undefined) lines.push('- Room host recorded as agent ' + quoteId(host) + ' (explicit setting only; no implicit host).');
  }
  lines.push(...await memberLines(store, doc, agentId, selfOwner));
}

async function memberLines(store: Store, doc: object, selfId: string, selfOwner: string | undefined): Promise<string[]> {
  const lines = ['## Conversation members'];
  const agentIds = readStringArray(doc, 'agentIds') ?? [];
  const memberIds = readStringArray(doc, 'memberIds') ?? [];
  if (agentIds.length === 0 && memberIds.length === 0) {
    lines.push('- No members listed on this conversation record.');
    return lines;
  }
  for (const id of agentIds.slice(0, MAX_MEMBERS_SHOWN)) {
    lines.push('- ' + await agentMemberLine(store, id, selfOwner, id === selfId));
  }
  if (agentIds.length > MAX_MEMBERS_SHOWN) {
    lines.push('- \u2026and ' + String(agentIds.length - MAX_MEMBERS_SHOWN) + ' more agents (truncated at ' + String(MAX_MEMBERS_SHOWN) + ').');
  }
  // A platform chat's member list is only the owner's account; the people in it are whoever spoke there.
  const conversationId = readString(doc, 'id');
  if (readChannelKind(doc) !== undefined && conversationId !== undefined) {
    lines.push(...await speakerLines(store, conversationId));
    return lines;
  }
  for (const id of memberIds.slice(0, MAX_MEMBERS_SHOWN)) {
    lines.push("- Human participant: member '" + id + "' (member names withheld).");
  }
  if (memberIds.length > MAX_MEMBERS_SHOWN) {
    lines.push('- \u2026and ' + String(memberIds.length - MAX_MEMBERS_SHOWN) + ' more human participants (truncated at ' + String(MAX_MEMBERS_SHOWN) + ').');
  }
  return lines;
}

/** The people who spoke in a platform chat (newest first), by the name the platform gave them: from the latest stored messages (`channelSender`, never `authorId`). */
async function recentSpeakers(store: Store, conversationId: string): Promise<Map<string, { name: string; owner: boolean }>> {
  const speakers = new Map<string, { name: string; owner: boolean }>();
  try {
    const page = await store.list('items', { where: { conversationId }, orderBy: 'at', order: 'desc', limit: SPEAKER_SCAN });
    for (const item of page.items) {
      if (item.type !== 'user_message' || item.channelSender === undefined) continue;
      const key = item.channelSender.kind + ':' + item.channelSender.externalId;
      if (!speakers.has(key)) speakers.set(key, { name: item.channelSender.name === '' ? 'someone' : item.channelSender.name, owner: item.channelSender.role === 'owner' });
    }
  } catch {
    return new Map();
  }
  return speakers;
}

/** The name the platform shows for the owner in this chat, once the owner has spoken there. */
export async function ownerSpeakerName(store: Store, conversationId: string): Promise<string | undefined> {
  return [...(await recentSpeakers(store, conversationId)).values()].find((speaker) => speaker.owner && speaker.name !== 'someone')?.name;
}

/**
 * The humans who spoke in a platform chat, the owner marked. Sorted so the text only changes when a new person speaks, not when
 * the order of speaking does.
 */
async function speakerLines(store: Store, conversationId: string): Promise<string[]> {
  const speakers = await recentSpeakers(store, conversationId);
  const recent = [...speakers.values()].slice(0, MAX_SPEAKERS_SHOWN)
    .sort((a, b) => Number(b.owner) - Number(a.owner) || a.name.localeCompare(b.name));
  const lines = recent.map((speaker) => '- Human participant: ' + quoteLabel(speaker.name) + (speaker.owner ? " (the person you're helping)" : " (not the person you're helping)") + '.');
  if (speakers.size > MAX_SPEAKERS_SHOWN) lines.push('- \u2026and ' + String(speakers.size - MAX_SPEAKERS_SHOWN) + ' more people who spoke here.');
  return lines;
}

async function agentMemberLine(store: Store, id: string, selfOwner: string | undefined, isSelf: boolean): Promise<string> {
  const result = await safeGet(store, 'agents', id);
  if (result.status === 'missing') return "Agent '" + id + "': unknown (no record).";
  if (result.status === 'error') return "Agent '" + id + "': unknown (record unreadable).";
  const memberOwner = readString(result.doc, 'ownerId');
  if (memberOwner !== undefined && selfOwner !== undefined && memberOwner !== selfOwner) {
    return "Agent '" + id + "': withheld (different owner).";
  }
  let unverified = '';
  if (memberOwner === undefined && selfOwner !== undefined) {
    if (readString(result.doc, 'createdBy') !== selfOwner) {
      return "Agent '" + id + "': withheld (ownership unverified).";
    }
    unverified = ' (ownership unverified)';
  }
  // The agent's own entry is its display name; its handle (often just its id) is never how it is addressed.
  const who = whoLine(readString(result.doc, 'name'), isSelf ? undefined : readString(result.doc, 'handle'), id);
  const title = readString(result.doc, 'title');
  if (title === undefined) return 'Agent ' + who + unverified + ", id '" + id + "'.";
  return 'Agent ' + who + ', role ' + quoteLabel(title) + unverified + ", id '" + id + "'.";
}

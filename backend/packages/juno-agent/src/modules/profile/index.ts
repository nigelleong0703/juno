/**
 * The account profile as the agent sees it (BACKEND 8.7): a flat list of key/value details the user or the agent saved. They are
 * not secret, so the agent fills them into pages itself; passwords, card details and codes still go through
 * request_secure_input. The block is a context section (a note when it changes), never part of the frozen system row.
 */
import { profileBodySchema, profileIdFor, type Profile, type ProfileBody } from '@agent-desktop/public-contracts';
import type { Store, ToolContext, WakeEvent } from '../../contracts/index.js';
import { readChannelKind, readString, readStringArray } from '../../execution/brain/social-read.js';

export async function readProfile(store: Store, ownerId: string | undefined): Promise<ProfileBody | null> {
  if (ownerId === undefined) return null;
  try {
    const row = await store.get('profiles', profileIdFor(ownerId));
    if (row === null) return null;
    return profileBodySchema.strip().parse(row);
  } catch {
    return null;
  }
}

export interface ProfileAudience {
  /** Whose profile this agent serves: the agent's recorded owner. Undefined when the agent or its owner is unknown. */
  profileOwnerId: string | undefined;
  /** True only when everyone in the run is the owner; anything unknown counts as shared. */
  ownerOnly: boolean;
}

export type AudienceWake = Pick<WakeEvent, 'ownerId' | 'origin' | 'trusted'> & Partial<Pick<WakeEvent, 'kind' | 'payload'>>;

/**
 * The payload flag a peer's wake carries when its sender's own run was owner-only (`chainStampOf`, set by the sending tool).
 * A peer wake without it cannot be traced to the owner, so it is shared (fail closed).
 */
export const CHAIN_OWNER_ONLY = 'chainOwnerOnly';

/**
 * Who a run serves, the one rule for what the agent may see or save of the profile and of the memory (BACKEND 5.3). Owner-only
 * needs all of: every wake's requester is the agent's owner, and a user-origin wake names no one else; a peer wake (another
 * agent's message) carries its sender's owner-only stamp (a child task runs in its parent's chat, so the chat decides for it);
 * the conversation lists no human member besides the owner and no agent owned by someone else. Owner automation (a routine,
 * monitor, calendar, task or webhook wake) is the owner's own work, so a missing chat record does not make it shared; a person's
 * message needs the chat to say who is in it. A conversation bound to a messaging platform (Discord, Slack, Telegram, Feishu...)
 * is read by everyone in it, so it is shared whoever woke the run: a platform room always, and a platform 1:1 chat ('direct')
 * only when every user-origin wake in it is the owner speaking (a stranger's private chat with the bot is 'direct' too). A room
 * with other people, or an unknown owner, is shared.
 */
export async function profileAudience(store: Store, opts: { agentId: string; conversationId: string; wake: AudienceWake[] }): Promise<ProfileAudience> {
  const agent = await store.get('agents', opts.agentId).catch(() => null);
  const profileOwnerId = agent === null ? undefined : readString(agent, 'ownerId') ?? readString(agent, 'createdBy');
  const shared = { profileOwnerId, ownerOnly: false };
  if (profileOwnerId === undefined) return shared;
  for (const event of opts.wake) {
    if (event.ownerId !== profileOwnerId) return shared;
    if (event.origin.type === 'user' && event.origin.id !== undefined && event.origin.id !== profileOwnerId) return shared;
    if (event.origin.type === 'agent' && event.kind !== 'child_task' && event.payload?.[CHAIN_OWNER_ONLY] !== true) return shared;
  }
  const conversation = await store.get('conversations', opts.conversationId).catch(() => null);
  if (conversation === null) {
    return opts.wake.length > 0 && opts.wake.every((event) => event.origin.type !== 'user') ? { profileOwnerId, ownerOnly: true } : shared;
  }
  const platformChat = readChannelKind(conversation) !== undefined;
  if (platformChat && (readString(conversation, 'kind') !== 'direct' || opts.wake.some((event) => event.origin.type === 'user' && event.trusted !== true))) return shared;
  if ((readStringArray(conversation, 'memberIds') ?? []).some((id) => id !== profileOwnerId)) return shared;
  for (const agentId of readStringArray(conversation, 'agentIds') ?? []) {
    if (agentId === opts.agentId) continue;
    const other = await store.get('agents', agentId).catch(() => null);
    if (other === null || (readString(other, 'ownerId') ?? readString(other, 'createdBy')) !== profileOwnerId) return shared;
  }
  return { profileOwnerId, ownerOnly: true };
}

/** True when anyone besides the owner is in this run (a group room, a stranger's wake, an unreadable record: fail closed). */
export const isSharedRun = async (ctx: Pick<ToolContext, 'store' | 'agentId' | 'conversationId' | 'wake'>): Promise<boolean> =>
  !(await profileAudience(ctx.store, { agentId: ctx.agentId, conversationId: ctx.conversationId, wake: [ctx.wake] })).ownerOnly;

/** What a shared run may see: only the `shared` entries. `omitted` is true when some entries were left out. */
export function sharedView(profile: ProfileBody): { view: ProfileBody; omitted: boolean } {
  const entries = profile.entries.filter((entry) => entry.visibility === 'shared');
  return { view: { entries }, omitted: entries.length < profile.entries.length };
}

/** The compact block; empty when nothing is saved, so a user without a profile costs no tokens. */
export function profileSection(saved: Profile | null, ownerOnly = true): string {
  if (saved === null) return '';
  const { view, omitted } = ownerOnly ? { view: saved, omitted: false } : sharedView(saved);
  const lines = view.entries.map((entry) => `- ${entry.key}: ${entry.value.includes('\n') ? entry.value.split('\n').map((line) => line.trim()).filter(Boolean).join(', ') : entry.value}`);
  if (omitted) lines.push("Some of your user's details are private and not available here.");
  if (lines.length === 0) return '';
  return "## Your user's details\nNot secret: fill these into forms yourself; save new ones with profile_update.\n" + lines.join('\n');
}

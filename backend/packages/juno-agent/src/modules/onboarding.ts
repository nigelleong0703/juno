/**
 * Onboarding (BACKEND §8.7): a newly created agent speaks first in its direct chat with the owner. The guidance is two skill files
 * (harness units skill.account_onboarding and skill.agent_setup) that code attaches INLINE to the onboarding wake, so they stay in the transcript for the next
 * turns and cost no skill_read: `account-onboarding` (once per account: the owner's name, what you do for them, the core apps) goes to
 * the account's first agent only, `agent-setup` (name, purpose, apps that fit it) to every new agent. The model skips whatever is
 * already settled. There is no stored marker and no context section: the wake id is fixed per agent, so it runs once.
 */
import type { Agent, Conversation } from '@agent-desktop/public-contracts';
import { sessionKey, type Enqueuer, type Store, type WakeEvent } from '../contracts/index.js';
import { listAll } from './memory/util.js';
import { docOwner } from '../execution/execution-owner.js';
import { goalConversationId } from './goals/checkin.js';
import { jobAgent } from './memory/jobs/agent.js';
import { getRow } from './home/mirror.js';
import { agentFilePath } from './home/paths.js';
import { harnessText } from './harness/loader.js';

/** The onboarding wake's text: the intro line, then the skills (the account's one-time skill first). */
export function onboardingWakeText(account: boolean): string {
  return [harnessText('onboarding.wake_intro'), ...(account ? [harnessText('skill.account_onboarding')] : []), harnessText('skill.agent_setup')].join('\n\n');
}

/** Whether this chat is the new owner's first direct chat with their default agent: the agent is new (empty identity files) and the chat is no platform chat. */
export async function isNewOwnerChat(store: Store, ownerId: string, agentId: string, conversationId: string): Promise<boolean> {
  const agent = (await jobAgent(store, ownerId))?.agent;
  if (agent?.id !== agentId) return false;
  // A new agent: nobody has written its identity yet (its IDENTITY.md, SOUL.md and AGENTS.md are still empty).
  for (const file of ['IDENTITY.md', 'SOUL.md', 'AGENTS.md']) {
    if (((await getRow(store, ownerId, agentFilePath(agentId, file)))?.content ?? '').trim().length > 0) return false;
  }
  const chat = await store.get('conversations', conversationId);
  const direct = chat !== null && chat.kind === 'direct' && chat.agentIds.length === 1 && chat.agentIds[0] === agentId && chat.memberIds.length === 1 && chat.memberIds[0] === ownerId;
  if (!direct) return false;
  // A chat that arrived through a messaging platform (Slack, Telegram, ...) is never the sign-up chat: the account already exists.
  if (typeof (chat as { channel?: unknown }).channel === 'object' && (chat as { channel?: unknown }).channel !== null) return false;
  // The owner's channel DMs share this chat (one conversation per owner and agent): once a platform message is in it, it is no sign-up chat.
  const first = await store.list('items', { where: { conversationId }, orderBy: 'at', order: 'asc', limit: 20 });
  return !first.items.some((item) => item.type === 'user_message' && (item.source !== undefined || item.channelSender !== undefined));
}

/**
 * Wakes the chat's agent once to speak first. The wake id is fixed per agent (plus `retryKey` for a retry), so a repeat is a no-op.
 * `account` is the account's very first agent: it also gets the once-per-account skill.
 */
export async function startOnboarding(deps: { store: Store; enqueuer: Enqueuer }, chat: Conversation, ownerId: string, opts: { account: boolean; retryKey?: string }): Promise<void> {
  const [agentId] = chat.agentIds;
  if (chat.kind !== 'direct' || chat.agentIds.length !== 1 || agentId === undefined) return;
  const wake: WakeEvent = {
    id: 'wake_onboarding_' + agentId + (opts.retryKey ?? ''),
    ownerId,
    agentId,
    sessionKey: sessionKey(agentId, chat.id),
    conversationId: chat.id,
    kind: 'onboarding',
    origin: { type: 'system', label: 'First run' },
    trusted: true,
    priority: 'background',
    payload: { text: onboardingWakeText(opts.account) },
    at: new Date().toISOString(),
    status: 'accepted',
  };
  await deps.enqueuer.enqueue(wake).catch(() => undefined);
}

/**
 * A newly created agent (sign-up, POST /v1/agents or an agent's agent_create): find or open its direct chat with the owner and wake it to
 * speak first. Returns the chat's id.
 */
export async function onboardNewAgent(deps: { store: Store; enqueuer: Enqueuer }, ownerId: string, agent: Agent, opts: { account: boolean }): Promise<string> {
  const conversationId = await goalConversationId(deps.store, ownerId, agent);
  const chat = await deps.store.get('conversations', conversationId);
  if (chat !== null) await startOnboarding(deps, chat, ownerId, opts);
  return conversationId;
}

/**
 * The sign-up greeting cannot run while the owner has no model provider (BYO providers, no platform model). When they save one
 * and the account is still new with an unanswered chat, wake the agent again (the provider id in the wake id makes a retry of the same save a no-op).
 */
export async function retryOnboarding(deps: { store: Store; enqueuer: Enqueuer }, ownerId: string, providerId: string): Promise<void> {
  const agent = (await jobAgent(deps.store, ownerId))?.agent;
  if (agent === undefined) return;
  // Only the chat sign-up created: an account without a direct chat with its default agent is not new, and gets none created here.
  const chat = (await listAll(deps.store, 'conversations')).find((candidate) => candidate.kind === 'direct' && candidate.agentIds.length === 1 && candidate.agentIds[0] === agent.id && docOwner(candidate) === ownerId);
  if (chat === undefined || !(await isNewOwnerChat(deps.store, ownerId, agent.id, chat.id))) return;
  const conversationId = chat.id;
  const items = await deps.store.list('items', { where: { conversationId }, limit: 20 });
  if (items.items.some((item) => item.type === 'agent_message')) return;
  await startOnboarding(deps, chat, ownerId, { account: true, retryKey: '_' + providerId });
}

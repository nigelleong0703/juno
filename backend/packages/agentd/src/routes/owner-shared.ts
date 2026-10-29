/**
 * Shared by the owner's People and Memory routes (BACKEND §10.17): the port guard (503 without the database or memoryd), the refusals of
 * the memory-graph classes as HTTP errors, and the shapes the app reads (accounts, people, memory items with their labels).
 */
import { type Context } from 'hono';
import { type Account, type Person, IdentityError } from '@agent-desktop/memory-graph/identity';
import { MemoryItemError, type MemoryItem } from '@agent-desktop/memory-graph/memory';
import { RelationError } from '@agent-desktop/memory-graph/relations';
import { MemoryUnavailableError } from '@agent-desktop/memoryd/contract';
import type { AccountView, MemoryItemView, PersonRef } from '@agent-desktop/public-contracts';
import { groupChatOf, groupNoteKey, withWorkspace } from 'juno-agent/modules/groups/note';
import { HomeUnavailableError } from 'juno-agent/modules/home/service';
import type { MemoryPort } from 'juno-agent/modules/memory/port';
import type { AgentdDeps } from './index.js';
import { quotesOf } from './memory-quote.js';
import { docOwnerId, listAll } from './relationships.js';

const GROUP_PREFIX = 'group:';
const PLATFORM_LABELS: Readonly<Record<string, string>> = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', feishu: 'Feishu', email: 'Email', meet: 'Meet', app: 'App' };

/** Runs `run` with the memory port, or answers 503 (no database, or memoryd unreachable) and maps the refusals of the memory classes. */
export async function owned(c: Context, deps: AgentdDeps, run: (memory: MemoryPort) => Promise<Response>): Promise<Response> {
  const memory = deps.memory;
  if (memory === undefined) return c.json({ error: { code: 'MEMORY_UNAVAILABLE', message: 'Memory needs the database; this deployment has none' } }, 503);
  try {
    return await run(memory);
  } catch (error) {
    return failure(c, error);
  }
}

function failure(c: Context, error: unknown): Response {
  if (error instanceof IdentityError || error instanceof MemoryItemError || error instanceof RelationError) {
    return error.code === 'not_found'
      ? c.json({ error: { code: 'NOT_FOUND', message: error.message } }, 404)
      : c.json({ error: { code: 'INVALID', message: error.message } }, 400);
  }
  if (error instanceof MemoryUnavailableError) return c.json({ error: { code: 'MEMORY_UNAVAILABLE', message: 'Memory is not reachable; try again' } }, 503);
  if (error instanceof HomeUnavailableError) return c.json({ error: { code: 'COMPUTER_UNAVAILABLE', message: 'Your computer is not reachable; try again' } }, 503);
  throw error;
}

export const accountOut = (account: Account): AccountView => ({
  id: account.id,
  platform: account.platform,
  name: account.name,
  ...(account.lastChat === '' ? {} : { lastChat: account.lastChat }),
  lastSeen: account.lastSeen,
});

export const personRef = (person: Person): PersonRef => ({ id: person.id, name: person.name, isOwner: person.isOwner });

/** The names an item's view is built from: its people, accounts, the agents that write, the rooms by their note key, the owner's name. */
export interface MemoryLabels {
  people: ReadonlyMap<string, Person>;
  accounts: ReadonlyMap<string, Account>;
  agents: ReadonlyMap<string, string>;
  groups: ReadonlyMap<string, string>;
  ownerName: string;
}

/** The room names by their group note key: the key an item's `group:<key>` audience and place carry. */
async function groupLabels(deps: AgentdDeps, ownerId: string): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  for (const conversation of (await listAll(deps.store, 'conversations')).items) {
    if (docOwnerId(conversation) !== ownerId) continue;
    const chat = groupChatOf(conversation);
    if (chat === undefined) continue;
    labels.set(groupNoteKey(ownerId, await withWorkspace(deps.store, ownerId, chat)), conversation.title ?? 'A group chat');
  }
  return labels;
}

async function memoryLabelsOf(deps: AgentdDeps, memory: MemoryPort, ownerId: string): Promise<MemoryLabels> {
  const [people, accounts, agents, groups] = await Promise.all([
    memory.people.list(ownerId),
    memory.people.listAccounts(ownerId),
    listAll(deps.store, 'agents'),
    groupLabels(deps, ownerId),
  ]);
  return {
    people: new Map(people.map((person): [string, Person] => [person.id, person])),
    accounts: new Map(accounts.map((account): [string, Account] => [account.id, account])),
    agents: new Map(agents.items.filter((agent) => docOwnerId(agent) === ownerId).map((agent): [string, string] => [agent.id, agent.name])),
    groups,
    ownerName: people.find((person) => person.isOwner)?.name ?? 'You',
  };
}

/**
 * One memory item as the Memory segment reads it, with names and labels resolved: the person it is about, who said it (a person, an
 * account or the agent that wrote it), where it was said and who may hear it. The labels are for reading, in the app's language (English).
 */
function memoryItemViewOf(item: MemoryItem, labels: MemoryLabels, quote: MemoryItemView['quote']): MemoryItemView {
  const about = item.aboutPersonId === null ? undefined : labels.people.get(item.aboutPersonId);
  return {
    id: item.id,
    text: item.text,
    kind: item.kind,
    topic: item.topic ?? 'other',
    about: about === undefined ? null : { personId: about.id, name: about.name },
    saidBy: saidByOf(item, labels),
    saidIn: { label: saidInLabel(item.saidIn, labels.groups) },
    audience: audienceOf(item.audience, labels),
    sensitive: item.sensitive,
    ...(item.agentId === null ? {} : { agentId: item.agentId }),
    status: item.status,
    createdAt: item.createdAt,
    quote,
  };
}

/** The views of several items: the labels once, and the people's words behind all of them read in one batch (`memory-quote.ts`). */
export async function memoryItemViewsOf(deps: AgentdDeps, memory: MemoryPort, ownerId: string, items: readonly MemoryItem[]): Promise<MemoryItemView[]> {
  const [labels, quotes] = await Promise.all([memoryLabelsOf(deps, memory, ownerId), quotesOf(deps.store, items)]);
  return items.map((item) => memoryItemViewOf(item, labels, quotes.get(item.id) ?? null));
}

/** The writer of an item: the person who said it, else the account it came from, else the agent that wrote it (its own inference). */
function saidByOf(item: MemoryItem, labels: MemoryLabels): MemoryItemView['saidBy'] {
  const person = item.saidByPersonId === null ? undefined : labels.people.get(item.saidByPersonId);
  if (person !== undefined) return { kind: person.isOwner ? 'owner' : 'person', name: person.name };
  const account = item.saidByAccountId === null ? undefined : labels.accounts.get(item.saidByAccountId);
  if (account !== undefined) return { kind: 'account', name: account.name ?? account.externalId };
  const agent = item.saidByAgentId === null ? undefined : labels.agents.get(item.saidByAgentId);
  return agent === undefined ? null : { kind: 'agent', name: agent };
}

function saidInLabel(saidIn: string, groups: ReadonlyMap<string, string>): string {
  if (saidIn === 'app') return 'Your chat';
  if (saidIn === 'migrated') return 'Earlier memory';
  if (saidIn.startsWith('dm:')) return `${PLATFORM_LABELS[saidIn.slice(3)] ?? saidIn.slice(3)} DM`;
  if (saidIn.startsWith('meeting:')) return 'A meeting';
  if (saidIn.startsWith(GROUP_PREFIX)) return groups.get(saidIn.slice(GROUP_PREFIX.length)) ?? 'A group chat';
  return saidIn;
}

function audienceOf(audience: string, labels: MemoryLabels): MemoryItemView['audience'] {
  if (audience === 'owner') return { kind: 'owner', label: 'Only you' };
  if (audience === 'public') return { kind: 'public', label: 'Everyone' };
  const group = audience.startsWith(GROUP_PREFIX) ? labels.groups.get(audience.slice(GROUP_PREFIX.length)) : undefined;
  return { kind: 'group', label: group ?? 'A group chat' };
}

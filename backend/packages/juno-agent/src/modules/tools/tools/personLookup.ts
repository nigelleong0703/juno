// person_lookup {name}: one person in the owner's life, and what they said (BACKEND §9.6, batch 7). What they said comes only through
// memoryFor(presence), so a group or a stranger sees what that run may see. Accounts, the relations between people and the possible
// matches are the owner's: they are shown only in a run the owner is alone in. A name that matches several people is not guessed; outside
// the owner's run a miss and a hit with nothing to share read the same, so the tool does not show who exists. Accounts with the same name
// that are not linked to the person are listed as possible matches, never linked: only the owner's word links them (person_link).
import { z } from 'zod';
import type { Account, Person } from '@agent-desktop/memory-graph/identity';
import type { RelationView } from '@agent-desktop/memory-graph/relations';
import type { VisibleItem } from '@agent-desktop/memory-graph/memory';
import type { Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { invalidArguments } from '../toolArguments.js';
import type { MemoryPort } from '../../memory/port.js';
import { presenceOf } from '../../memory/presence.js';
import { listAll } from '../../memory/util.js';
import { labelsFor, placeOf, type SectionLabels } from '../../memory/section.js';
import { nameKey } from '../../people/names.js';

/** The most recent things a person said that are listed. */
const MAX_SAID = 5;
/** Accounts with the same name listed as possible matches, and the most recent things each one said. */
const MAX_POSSIBLE = 5;
const MAX_POSSIBLE_SAID = 3;
/** Messages shown per possible-match account (its latest, newest first), each cut to MESSAGE_CHARS. */
const MAX_ACCOUNT_MESSAGES = 3;
const MESSAGE_CHARS = 300;
/** The most recent items read per chat when looking for an account's messages (a bound, not a window). */
const SCAN_PER_CHAT = 400;

const schema = z.object({ name: z.string().trim().min(1).max(120) }).strict();

const result = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: isError ? 'Error: ' + text : text }], ...(isError ? { isError } : {}) });

/** How a relation kind reads between its two names ("Tom manages Priya"). */
const PHRASE: Readonly<Record<Exclude<RelationView['kind'], 'other'>, string>> = {
  manager_of: 'manages',
  colleague: 'is a colleague of',
  client_of: 'is a client of',
  works_at: 'works at',
  spouse: 'is married to',
  parent_of: 'is a parent of',
  sibling: 'is a sibling of',
  friend: 'is a friend of',
};

/** One current relation as the owner reads it, with whether the owner confirmed it. */
function relationLine(relation: RelationView): string {
  const link = relation.kind === 'other'
    ? `${relation.personAName} (${(relation.kindLabel ?? 'related to').replaceAll('_', ' ')}) ${relation.personBName}`
    : `${relation.personAName} ${PHRASE[relation.kind]} ${relation.personBName}`;
  const trust = relation.confirmed ? 'confirmed by you' : relation.saidByName === null ? 'not confirmed' : `not confirmed; said by ${relation.saidByName}`;
  return `- ${link} (${trust}, since ${relation.validFrom.slice(0, 10)})`;
}

/**
 * Exactly one person the name (or the "per_" id) names; several are reported apart. A name matches whatever its case, spacing and
 * possessive ("Priya's" is Priya), the same way relations resolve names (`nameKey`).
 */
function findPerson(people: readonly Person[], name: string): { person: Person } | { candidates: Person[] } | undefined {
  const wanted = name.trim().toLowerCase();
  const key = nameKey(name);
  const matches = wanted.startsWith('per_')
    ? people.filter((person) => person.id.startsWith(wanted))
    : people.filter((person) => nameKey(person.name) === key);
  if (matches.length === 0) return undefined;
  return matches.length === 1 ? { person: matches[0]! } : { candidates: matches };
}

/** One message an account wrote in a chat: the chat's title, when, and the text (cut to MESSAGE_CHARS). */
export interface AccountMessage {
  chat: string;
  at: string;
  text: string;
}

/** The most recent messages of each given account, read from the chats it spoke in (the owner's own store, owner-alone runs only). */
export async function recentMessagesOf(store: Store, accounts: readonly Account[]): Promise<Map<string, AccountMessage[]>> {
  const found = new Map<string, AccountMessage[]>(accounts.map((account): [string, AccountMessage[]] => [account.id, []]));
  if (accounts.length === 0) return found;
  const byPlatformId = new Map(accounts.map((account): [string, string] => [JSON.stringify([account.platform, account.externalId]), account.id]));
  for (const chat of await listAll(store, 'conversations')) {
    const page = await store.list('items', { where: { conversationId: chat.id }, orderBy: 'at', order: 'desc', limit: SCAN_PER_CHAT });
    for (const item of page.items) {
      if (item.type !== 'user_message' || item.channelSender === undefined) continue;
      const accountId = byPlatformId.get(JSON.stringify([item.channelSender.kind, item.channelSender.externalId]));
      if (accountId === undefined) continue;
      found.get(accountId)?.push({ chat: chat.title ?? '', at: item.at, text: item.text });
    }
  }
  for (const [accountId, messages] of found) {
    const newest = messages.sort((x, y) => y.at.localeCompare(x.at)).slice(0, MAX_ACCOUNT_MESSAGES);
    found.set(accountId, newest.map((message) => ({ ...message, text: cutAt(clean(message.text), MESSAGE_CHARS) })));
  }
  return found;
}

/** An account with the name that is not linked to this person (none, or another person): a possible match, with what it said. */
interface PossibleMatch {
  account: Account;
  /** Where the account is filed now, for the owner. */
  filed: string;
  /** What the account said that memory holds (its items, when it has any). */
  said: VisibleItem[];
  /** The account's latest messages in the chats it spoke in. */
  messages: AccountMessage[];
}

async function possibleMatches(
  store: Store,
  memory: MemoryPort,
  ownerId: string,
  name: string,
  person: Person | undefined,
  people: readonly Person[],
  visible: readonly VisibleItem[],
): Promise<PossibleMatch[]> {
  const key = nameKey(name);
  const names = new Map(people.map((row): [string, string] => [row.id, row.name]));
  const accounts = (await memory.people.listAccounts(ownerId))
    .filter((account) => !(person !== undefined && account.personId === person.id))
    .filter((account) => nameKey(account.name ?? '') === key || nameKey(account.externalId) === key)
    .slice(0, MAX_POSSIBLE);
  const messages = await recentMessagesOf(store, accounts);
  return accounts.map((account) => ({
    account,
    filed: account.personId === null ? 'not linked to anyone yet' : `filed under ${names.get(account.personId) ?? 'another person'}`,
    said: visible
      .filter((item) => item.saidByAccountId === account.id)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
      .slice(0, MAX_POSSIBLE_SAID),
    messages: messages.get(account.id) ?? [],
  }));
}

const when = (createdAt: string): string => createdAt.slice(0, 16).replace('T', ' ') + ' UTC';
const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();
/** The first `limit` characters, with an ellipsis when cut. */
const cutAt = (text: string, limit: number): string => (text.length > limit ? text.slice(0, limit) + '…' : text);

function possibleLines(possible: readonly PossibleMatch[], labels: SectionLabels): string[] {
  const lines = ['', 'Possible matches, not confirmed (accounts with this name that are not linked to this person; never link them without the owner\'s word):'];
  for (const entry of possible) {
    const chat = entry.account.lastChat === '' ? 'no chat recorded' : `"${entry.account.lastChat}"`;
    lines.push(`- ${entry.account.platform} "${entry.account.name ?? entry.account.externalId}" (${entry.account.externalId}), ${entry.filed}, last seen in ${chat}`);
    for (const message of entry.messages) lines.push(`  wrote in "${message.chat}" on ${when(message.at)}: "${message.text}"`);
    for (const item of entry.said) lines.push(`  remembered: "${clean(item.text)}" (${placeOf(item, labels)}, ${when(item.createdAt)})`);
  }
  return lines;
}

export function createPersonLookupTool(opts: { memory: MemoryPort }): Tool {
  const { memory } = opts;
  return {
    name: 'person_lookup',
    description: '',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '' } },
      required: ['name'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.safeParse(args);
      if (!parsed.success) return invalidArguments('person_lookup', args, parsed.error);
      if (ctx.ownerId.length === 0) return result('no owner context, so people are unavailable.', true);
      const presence = await presenceOf(ctx.store, { ownerId: ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId, wake: [ctx.wake] });
      const owner = presence.kind === 'owner';
      const name = parsed.data.name;
      const nothingToShare = (): ToolResult => result(`Nothing you can share about ${name} here.`);

      const people = await memory.people.list(ctx.ownerId);
      const found = findPerson(people, name);
      if (!owner && (found === undefined || 'candidates' in found)) return nothingToShare();
      if (found !== undefined && 'candidates' in found) {
        const list = found.candidates.map((person) => `${person.name} (${person.id.slice(0, 12)})`).join('; ');
        return result(`More than one person matches ${JSON.stringify(name)}: ${list}. Use the id.`, true);
      }
      const person = found?.person;

      const visible = await memory.memoryFor(ctx.ownerId, presence, ctx.agentId);
      const said: VisibleItem[] = person === undefined
        ? []
        : visible
          .filter((item) => item.saidByPersonId === person.id)
          .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
          .slice(0, MAX_SAID);
      if (!owner && said.length === 0) return nothingToShare();
      const possible = owner ? await possibleMatches(ctx.store, memory, ctx.ownerId, name, person, people, visible) : [];
      if (person === undefined && possible.length === 0) {
        return result(`No person is called ${JSON.stringify(name)}. Use the name as the owner gives it, or a person id.`, true);
      }

      const labels = await labelsFor(ctx.store, ctx.ownerId, people, [...said, ...possible.flatMap((entry) => entry.said)]);
      if (person === undefined) {
        return result([`No person is linked to ${JSON.stringify(name)} yet, but accounts with that name exist.`, ...possibleLines(possible, labels)].join('\n'));
      }
      const lines: string[] = [owner ? `${person.name} (${person.id.slice(0, 12)})` : person.name];
      if (owner) {
        const accounts = await memory.people.accountsOf(ctx.ownerId, person.id);
        if (accounts.length > 0) {
          lines.push('', 'Accounts:', ...accounts.map((account) => `- ${account.platform} "${account.name ?? account.externalId}" (${account.externalId})`));
        }
        const relations = await memory.relations.currentOf(ctx.ownerId, person.id);
        if (relations.length > 0) lines.push('', 'Connections:', ...relations.map(relationLine));
      }
      lines.push('', 'Recent things said (newest first, only what may be repeated here):');
      lines.push(...(said.length === 0
        ? ['- Nothing recorded yet.']
        : said.map((item) => `- "${clean(item.text)}" (${placeOf(item, labels)}, ${when(item.createdAt)})`)));
      if (possible.length > 0) lines.push(...possibleLines(possible, labels));
      return result(lines.join('\n'));
    },
  };
}

// person_link (M-IDENTITY): when the owner says accounts are one person ("Bob on Slack is Bob from Telegram"), the agent links those accounts
// to one person. The owner names an account the way they would say it: its platform and the name or handle they gave; an account id
// (acc_…) or a person id (per_…) still works. Several matches are not guessed: the candidates come back with the chat each was last
// seen in, and the model asks the owner which one. Owner-only: offered only when the owner is alone with the agent (`ownerOnly` on the
// tool, filtered in the run), and refused here too when a run has anyone else in it. The owner's own person is never moved away.
import { z } from 'zod';
import type { Account, Person } from '@agent-desktop/memory-graph/identity';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import type { MemoryPort } from '../../memory/port.js';
import { invalidArguments } from '../toolArguments.js';
import { isSharedRun } from '../../profile/index.js';

type People = MemoryPort['people'];

const accountRef = z.union([
  z.string().trim().min(1),
  z.object({ platform: z.string().trim().min(1), name: z.string().trim().min(1) }).strict(),
]);
const schema = z.object({ accounts: z.array(accountRef).min(1).max(10), person: z.string().trim().min(1).optional() }).strict();
type AccountRef = z.infer<typeof accountRef>;

const result = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: isError ? 'Error: ' + text : text }], ...(isError ? { isError } : {}) });

/** The id as a header shows it: "per_" or "acc_" and 8 hex characters. */
const short = (id: string): string => id.slice(0, 12);

const PERSON_REF = /^per_[0-9a-f]*$/;

function candidates(people: readonly Person[]): string {
  return people.map((person) => `${person.name} (${short(person.id)})`).join('; ');
}

/** A person by id (a short or full id, as a header shows it) or by name, when exactly one person matches. */
async function findPerson(people: People, ownerId: string, ref: string): Promise<{ person: Person } | { error: string }> {
  const known = await people.list(ownerId);
  const lower = ref.toLowerCase();
  const matches = PERSON_REF.test(lower)
    ? known.filter((person) => person.id.startsWith(lower))
    : known.filter((person) => person.name.trim().toLowerCase() === lower);
  if (matches.length === 1) return { person: matches[0]! };
  if (matches.length === 0) return { error: `no person matches ${JSON.stringify(ref)}. Use a person id from a message header (per_xxxxxxxx) or the exact name of a person.` };
  return { error: `${JSON.stringify(ref)} matches more than one person: ${candidates(matches)}. Use the id.` };
}

/** A name or handle as the owner says it: case-blind, without a leading @. */
const handle = (value: string): string => value.trim().replace(/^@/, '').toLowerCase();

function matchesName(account: Account, name: string): boolean {
  const wanted = handle(name);
  return handle(account.name ?? '') === wanted || handle(account.externalId) === wanted;
}

/** One account as the owner can tell it apart: the platform, its name and handle, the chat it was last seen in, and its id. */
function describe(account: Account): string {
  const chat = account.lastChat === '' ? 'no chat recorded' : `"${account.lastChat}"`;
  return `${account.platform} "${account.name ?? account.externalId}" (${account.externalId}), last seen in ${chat}, id ${short(account.id)}`;
}

type Source = { accounts: Account[] } | { error: string } | { candidates: Account[] };

/**
 * The accounts one reference stands for: a person's id (all of that person's accounts), an account id or prefix, or a platform and the
 * name the owner gave. A name that matches several accounts is not guessed: its candidates are returned instead.
 */
async function sourceOf(people: People, ownerId: string, ref: AccountRef): Promise<Source> {
  if (typeof ref === 'string') {
    if (PERSON_REF.test(ref.toLowerCase())) {
      const found = await findPerson(people, ownerId, ref);
      if ('error' in found) return found;
      if (found.person.isOwner) return { error: `${found.person.name} is your owner's own person; their accounts stay with them.` };
      const accounts = await people.accountsOf(ownerId, found.person.id);
      return accounts.length === 0 ? { error: `${found.person.name} has no accounts to move.` } : { accounts };
    }
    const accounts = await people.accountsWithPrefix(ownerId, ref);
    if (accounts.length === 0) return { error: `no account or person matches ${JSON.stringify(ref)}.` };
    if (accounts.length > 1) return { error: `${JSON.stringify(ref)} matches more than one account: ${accounts.map((account) => short(account.id)).join(', ')}. Use the full id.` };
    return { accounts };
  }
  const platform = ref.platform.trim().toLowerCase();
  const matches = (await people.listAccounts(ownerId)).filter((account) => account.platform === platform && matchesName(account, ref.name));
  if (matches.length === 0) return { error: `no ${platform} account is called ${JSON.stringify(ref.name)}. Ask the owner for the name as it shows in that chat.` };
  return matches.length === 1 ? { accounts: matches } : { candidates: matches };
}

export function createPersonLinkTool(opts: { memory: Pick<MemoryPort, 'people'> }): Tool {
  const { people } = opts.memory;
  return {
    name: 'person_link',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        accounts: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          description: '',
          items: {
            anyOf: [
              { type: 'string', description: '' },
              {
                type: 'object',
                properties: {
                  platform: { type: 'string', description: '' },
                  name: { type: 'string', description: '' },
                },
                required: ['platform', 'name'],
                additionalProperties: false,
              },
            ],
          },
        },
        person: { type: 'string', description: '' },
      },
      required: ['accounts'],
      additionalProperties: false,
    },
    replay: 'never',
    sideEffect: true,
    ownerOnly: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.safeParse(args);
      if (!parsed.success) return invalidArguments('person_link', args, parsed.error);
      if (ctx.ownerId.length === 0) return result('no owner context, so people are unavailable.', true);
      if (await isSharedRun(ctx)) return result('person_link is only available in a chat with your owner alone.', true);

      // Every reference is resolved before anything moves: one that fails or is ambiguous links nothing.
      const accounts: Account[] = [];
      for (const ref of parsed.data.accounts) {
        const found = await sourceOf(people, ctx.ownerId, ref);
        if ('error' in found) return result(found.error, true);
        if ('candidates' in found) {
          const names = found.candidates.map(describe).join('; ');
          return result(`Nothing was linked: ${JSON.stringify(typeof ref === 'string' ? ref : ref.name)} matches ${String(found.candidates.length)} accounts: ${names}. Ask the person which one they mean, then call person_link again with its id (acc_…).`);
        }
        for (const account of found.accounts) if (!accounts.some((known) => known.id === account.id)) accounts.push(account);
      }

      // The person they all go to: the one named, else the first account's own person (or a new person for an account with none).
      let to: Person;
      if (parsed.data.person !== undefined) {
        const target = await findPerson(people, ctx.ownerId, parsed.data.person);
        if ('error' in target) return result(target.error, true);
        to = target.person;
      } else {
        const first = accounts[0]!;
        const own = first.personId === null ? undefined : await people.resolve(ctx.ownerId, first.id);
        to = own ?? await people.createPerson(ctx.ownerId, first.name ?? first.externalId);
      }
      if (to.isOwner) return result(`${to.name} is your owner's own person; accounts are not linked to it this way.`, true);

      const toMove: Account[] = [];
      for (const account of accounts) {
        const from = account.personId === null ? undefined : await people.resolve(ctx.ownerId, account.id);
        if (from?.isOwner === true) return result(`${describe(account)} belongs to your owner's own person; it stays with them.`, true);
        if (account.personId !== to.id) toMove.push(account);
      }
      if (toMove.length === 0) return result(`${accounts.map((account) => account.platform + ' "' + (account.name ?? account.externalId) + '"').join(' and ')} already ${accounts.length === 1 ? 'is' : 'are'} ${to.name}.`, true);
      for (const account of toMove) await people.linkAccount(ctx.ownerId, account.id, to.id);
      const moved = toMove.map((account) => `${account.platform} "${account.name ?? account.externalId}"`).join(', ');
      return result(`Linked ${moved} to ${to.name} (${short(to.id)}).`);
    },
  };
}

/**
 * Who a platform sender is (M-IDENTITY; design app/reports/memory-graph-tech-design.md, BACKEND 9.5). Every human who writes in a
 * chat platform becomes an account of the owner, a new account gets its own person, and the owner's own accounts are linked to the
 * owner's person. Nothing here decides owner vs stranger: `speakerFor` does that and stays as it is. Recording is best-effort: a
 * failure is logged and the message is admitted without a person.
 */
import { channelRowId, type ChannelRow, type Store } from '@agent-desktop/contracts';
import type { DurableDb } from '@agent-desktop/durable';
import { createLogger } from '@agent-desktop/log';
import { ACCOUNT_PLATFORMS, type AccountPlatform, type Identity, type Person } from '@agent-desktop/memory-graph/identity';
import type { ChannelRegistry } from './registry.js';
import { getRow, newRow, putRow } from 'juno-agent/modules/home/mirror';
import { listAll } from 'juno-agent/modules/memory/util';

const log = createLogger({ service: 'agentd' });

/** The owner's person's name, until the app has one to give it. */
export const OWNER_PERSON_NAME = 'Owner';

/** One platform account: the platform, the workspace it lives in ('' when the platform has none) and the platform's id for it. */
export interface SenderAccount {
  platform: AccountPlatform;
  workspace: string;
  externalId: string;
  name?: string;
}

/**
 * The account of a platform sender, or undefined for a kind the identity graph has no accounts for. `workspace` is the platform's
 * notion of one (a Slack user id is only unique inside its team; most platforms' ids are global: '').
 */
export function senderAccountOf(kind: string, workspace: string, sender: { id: string; name?: string }): SenderAccount | undefined {
  const platform = ACCOUNT_PLATFORMS.find((candidate) => candidate === kind);
  if (platform === undefined) return undefined;
  return { platform, workspace, externalId: sender.id, ...(sender.name === undefined ? {} : { name: sender.name }) };
}

/**
 * What a sighting is for: the owner (their account is linked to the owner's person), and whether a person should be made for a
 * stranger's account. A DM sender always gets one; a group sender only when the message addresses the agent (see addressesAgent).
 */
export interface SenderRole {
  owner: boolean;
  createPerson: boolean;
}

/**
 * Record one sighting and return the sender's person, or undefined when the account has none (a group sender nobody addressed).
 * The owner's account is linked to the owner's person, created on first use.
 */
export async function recordSender(identity: Identity, ownerId: string, sender: SenderAccount, role: SenderRole, chat?: string): Promise<Person | undefined> {
  const account = {
    platform: sender.platform,
    workspace: sender.workspace,
    externalId: sender.externalId,
    name: sender.name ?? null,
    // The chat the sender spoke in (person_link tells the owner which of several accounts that is).
    lastChat: chat ?? null,
  };
  if (!role.owner) return (await identity.upsertAccount(ownerId, account, { createPerson: role.createPerson })).person;
  const seen = await identity.upsertAccount(ownerId, account, { createPerson: false });
  const self = await identity.ensureOwner(ownerId, OWNER_PERSON_NAME);
  if (seen.account.personId !== self.id) await identity.linkAccount(ownerId, seen.account.id, self.id);
  return self;
}

/**
 * Whether a message addresses the agent: any private message does; in a group, a mention of this channel's own bot (the platform's
 * `addressesSelf`: its user id, on Telegram also its username). A reply to the agent's message is not in the platform event, so it
 * does not count here.
 */
export function addressesAgent(channels: ChannelRegistry, chatType: 'private' | 'group', mentions: ReadonlyArray<{ id: string; handle?: string }> | undefined, channel: ChannelRow): boolean {
  if (chatType === 'private') return true;
  const identity = channels.get(channel.kind)?.adapter.identity;
  return (mentions ?? []).some((person) => identity?.addressesSelf(channel, person) === true);
}

/**
 * The person of one admitted platform message's speaker, recorded at ingress. Undefined when there is nothing to record (no identity
 * service in this process, or a kind that is not a chat platform) or when the account has no person; a failure is logged and gives undefined.
 */
export async function recordIngressSender(
  deps: { identity?: Identity; channels: ChannelRegistry },
  ownerId: string,
  channel: ChannelRow,
  sender: { id: string; name?: string },
  role: SenderRole,
  chat?: string,
): Promise<Person | undefined> {
  if (deps.identity === undefined) return undefined;
  const adapter = deps.channels.get(channel.kind)?.adapter;
  const account = adapter === undefined ? undefined : senderAccountOf(channel.kind, adapter.identity.workspaceOf(channel), sender);
  if (account === undefined) return undefined;
  try {
    return await recordSender(deps.identity, ownerId, account, role, chat);
  } catch (error) {
    log.error({ err: error, channel: channelRowId(channel.kind, channel.channelId) }, 'could not record the speaker; the message goes on without a person');
    return undefined;
  }
}

/** Row written once the backfill has finished; a later boot skips it. Same mechanism as the home-file migration. */
export const BACKFILL_MARKER = '__migrations/identity-v1';
const ITEM_PAGE = 500;

export interface BackfillDeps {
  store: Store;
  raw: DurableDb;
  identity: Identity;
}

export interface BackfillCounts {
  skipped: boolean;
  owners: number;
  items: number;
  senders: number;
}

interface SenderItemRow {
  id: string;
  owner_id: string;
  doc: { channelSender?: unknown; source?: unknown };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : undefined;
}

/**
 * The workspace rule in force when this one-time migration was written, frozen: it runs at boot before the platform plugins have
 * loaded, so it cannot ask an adapter (`identity.workspaceOf` is the rule for live messages). Only Slack's ids are per team.
 */
function legacyWorkspace(kind: string, teamId: string | undefined): string {
  return kind === 'slack' ? teamId ?? '' : '';
}

/**
 * Turn the stored senders into accounts, once. The owner's bound chat accounts (`ownerExternalId` on each channel row) are linked to the
 * owner; every distinct sender in the stored items becomes an account, and an item the owner wrote links it to the owner. Idempotent
 * (existing accounts and people are only refreshed), so a crash midway is finished by the next boot.
 */
export async function backfillPeople(deps: BackfillDeps): Promise<BackfillCounts> {
  if ((await getRow(deps.store, 'system', BACKFILL_MARKER)) !== null) return { skipped: true, owners: 0, items: 0, senders: 0 };
  // The team of each channel row, so a Slack sender in a stored item gets the same workspace the live ingress gives it.
  const teams = new Map<string, string | undefined>();
  let owners = 0;
  for (const row of await listAll(deps.store, 'channels')) {
    teams.set(channelRowId(row.kind, row.channelId), row.teamId);
    if (row.ownerExternalId === undefined) continue;
    const account = senderAccountOf(row.kind, legacyWorkspace(row.kind, row.teamId), { id: row.ownerExternalId });
    if (account === undefined) continue;
    await recordSender(deps.identity, row.ownerId, account, { owner: true, createPerson: false });
    owners += 1;
  }
  const done = new Set<string>();
  let items = 0;
  let senders = 0;
  let cursor = '';
  let page: SenderItemRow[];
  do {
    page = await deps.raw.query<SenderItemRow>(
      `SELECT id, owner_id, doc FROM items WHERE id > ? AND doc->'channelSender' IS NOT NULL ORDER BY id LIMIT ?`,
      [cursor, ITEM_PAGE],
    );
    for (const row of page) {
      items += 1;
      cursor = row.id;
      const sender = asRecord(row.doc.channelSender);
      const kind = sender?.['kind'];
      const externalId = sender?.['externalId'];
      if (sender === undefined || typeof kind !== 'string' || typeof externalId !== 'string') continue;
      const source = asRecord(row.doc.source);
      const sourceKind = source?.['kind'];
      const sourceChannel = source?.['channelId'];
      const team = typeof sourceKind === 'string' && typeof sourceChannel === 'string' ? teams.get(channelRowId(sourceKind, sourceChannel)) : undefined;
      const name = typeof sender['name'] === 'string' ? sender['name'] : undefined;
      const account = senderAccountOf(kind, legacyWorkspace(kind, team), { id: externalId, ...(name === undefined ? {} : { name }) });
      if (account === undefined) continue;
      // A DM sender gets a person; a group sender stays an account until someone addresses the agent (the stored message does not tell).
      const owner = sender['role'] === 'owner';
      const createPerson = source?.['chatType'] === 'private';
      const key = [row.owner_id, account.platform, account.workspace, account.externalId, owner ? 'owner' : 'stranger', createPerson ? 'dm' : 'group'].join('|');
      if (done.has(key)) continue;
      done.add(key);
      await recordSender(deps.identity, row.owner_id, account, { owner, createPerson });
      senders += 1;
    }
  } while (page.length === ITEM_PAGE);
  await putRow(deps.store, newRow('system', BACKFILL_MARKER, '', 'platform', new Date().toISOString()));
  return { skipped: false, owners, items, senders };
}

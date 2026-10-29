/**
 * The shared Juno Discord bot (`mode: 'oauth'`): one bot for everyone, a mentionable role per agent.
 *
 * The bot belongs to Juno (env DISCORD_APP_ID / DISCORD_BOT_TOKEN) and has one Gateway connection of its own (the runner below),
 * separate from the per-agent bots. An owner adds it to a server through the invite link; Discord's redirect (carrying our `state`)
 * ties that server to the owner and agent, stores a `channelInstallations` row `discord:<guildId>` and gives the agent a mentionable
 * role named after it plus a `channels` row (`channelId` `<guildId>.<agentId>`). A guild message that mentions an agent's role goes to
 * that agent, a mention of the bot goes to the owner's main agent, and a DM to the bot goes to the main agent of whoever the sender
 * is bound to. In server channels an agent speaks through a webhook of that channel (its own name and picture); in a DM as the bot.
 *
 * Reading the text of a role mention needs the privileged MESSAGE_CONTENT intent (only mentions of the bot user itself are exempt),
 * which must be switched on for the app in the Developer Portal; without it the runner reconnects without the intent and only the
 * bot mention and DMs carry text. Voice sessions (discord-voice.ts) ride this gateway too, one per server.
 */
import { createLogger } from '@agent-desktop/log';
import type { Agent } from '@agent-desktop/public-contracts';
import { channelRowId, type ChannelInstallation, type ChannelRow, type Store } from '@agent-desktop/contracts';
import { decryptSecret, encryptSecret } from '@agent-desktop/contracts/secrets';
import { jobAgent } from 'juno-agent/modules/memory/jobs/agent';
import { runWithOwner } from 'juno-agent/owner-context';
import type { Context } from 'hono';
import { z } from 'zod';
import { getOwnerId } from '../../auth.js';
import { admitChannelEvent } from '../../routes/channels.js';
import type { AgentdDeps } from '../../routes/index.js';
import { docOwnerId } from '../../routes/relationships.js';
import { failSharedInstall, openSharedInstall, sharedAppPage, type SharedAppSpec } from '../shared-app.js';
import { newSecret } from '../bind.js';
import { discordCall, discordUserSchema, rewriteDiscordMentions, type DiscordChannelEvent } from '@agent-desktop/channels/discord/api';
import { discordInviter } from './connect.js';
import { settlePending } from '../pending.js';
import { channelIdOfToken } from '../origin.js';
import { discordAdapter } from '@agent-desktop/channels/sdk';
import { answerChannelClick } from '../interactions.js';
import type { ChannelRunnerContext } from '../runners.js';
import { SHARED_VOICE_ROW_ID, type DiscordVoice } from './voice.js';
import { DISCORD_SENT_TYPE } from './delivery.js';
import { readRunHop } from 'juno-agent/execution/harness/services/chain-cost';

const log = createLogger({ service: 'agentd' });

/** View Channels, Send Messages, Read Message History, Add Reactions, Connect, Speak, Send in Threads, Manage Roles, Manage Webhooks, View Audit Log. */
export const SHARED_PERMISSIONS = [10n, 11n, 16n, 6n, 20n, 21n, 38n, 28n, 29n, 7n].reduce((bits, bit) => bits | (1n << bit), 0n).toString();

export interface SharedDiscordConfig { appId: string; botToken: string }

export function sharedDiscordConfig(): SharedDiscordConfig | undefined {
  const appId = process.env['DISCORD_APP_ID']?.trim();
  const botToken = process.env['DISCORD_BOT_TOKEN']?.trim();
  return appId && botToken ? { appId, botToken } : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function rowKey(guildId: string, agentId: string): { id: string; channelId: string } {
  const channelId = guildId + '.' + agentId;
  return { id: channelRowId('discord', channelId), channelId };
}

export async function discordInstallationsOf(store: Store, ownerId: string): Promise<ChannelInstallation[]> {
  const page = await store.list('channelInstallations', { where: { kind: 'discord' }, limit: 100 });
  return page.items.filter((item) => docOwnerId(item) === ownerId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The agent's `channels` row in this server, with its mentionable role. Idempotent; a role that cannot be made leaves `handleStatus: failed`. */
export async function provisionDiscordAgent(
  deps: { store: Store; channelFetch?: typeof fetch },
  installation: ChannelInstallation,
  agent: Pick<Agent, 'id' | 'name'>,
  withRole = true,
): Promise<ChannelRow> {
  const { id, channelId } = rowKey(installation.teamId, agent.id);
  const existing = await deps.store.get('channels', id);
  if (existing && (existing.roleId !== undefined || !withRole)) return existing;
  let roleId: string | undefined;
  if (withRole) {
    const created = await discordCall(deps.channelFetch ?? fetch, decryptSecret(installation.botToken), 'POST', '/guilds/' + installation.teamId + '/roles', { name: agent.name, mentionable: true });
    roleId = created.ok && typeof created.body === 'object' && created.body !== null ? str((created.body as Record<string, unknown>)['id']) : undefined;
  }
  const now = new Date().toISOString();
  const row: ChannelRow = {
    ...(existing ?? { id, ownerId: installation.ownerId, agentId: agent.id, kind: 'discord', channelId, secretHashHex: newSecret().hashHex, createdAt: now }),
    installationId: installation.id,
    displayName: agent.name,
    ...(installation.installedBy === undefined ? {} : { ownerExternalId: existing?.ownerExternalId ?? installation.installedBy }),
    ...(withRole ? (roleId === undefined ? { handleStatus: 'failed' as const } : { roleId, handle: agent.name, handleStatus: 'ok' as const }) : {}),
    status: 'active',
    updatedAt: now,
  };
  return deps.store.put('channels', row);
}

/** Best effort: the agent's role is removed from the server. */
export async function disconnectDiscordShared(deps: { store: Store; channelFetch?: typeof fetch }, row: ChannelRow): Promise<void> {
  try {
    const installation = row.installationId === undefined ? null : await deps.store.get('channelInstallations', row.installationId);
    if (!installation || row.roleId === undefined) return;
    await (deps.channelFetch ?? fetch)('https://discord.com/api/v10/guilds/' + installation.teamId + '/roles/' + row.roleId, {
      method: 'DELETE', headers: { authorization: 'Bot ' + decryptSecret(installation.botToken) },
    });
  } catch {
    // The row is removed regardless.
  }
}

function inviteUrl(config: SharedDiscordConfig, publicUrl: string, state: string): string {
  return 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
    client_id: config.appId,
    scope: 'bot applications.commands',
    permissions: SHARED_PERMISSIONS,
    response_type: 'code',
    redirect_uri: publicUrl + '/v1/channels/discord/oauth/callback',
    state,
  }).toString();
}

/** The shared Juno bot's install (`SharedAppInstall` walk, see shared-app.ts): the invite link that adds the bot to a server. */
export const discordSharedApp: SharedAppSpec<SharedDiscordConfig> = {
  platform: 'discord',
  config: sharedDiscordConfig,
  notConfiguredMessage: 'The shared Discord bot is not set up on this server (DISCORD_APP_ID, DISCORD_BOT_TOKEN)',
  publicUrlMessage: 'Discord must redirect back to this server: set CHANNELS_PUBLIC_URL first',
  installUrl: inviteUrl,
};

/** Discord's redirect after the invite (`guild_id` + our `state`): installation row, the agent's role and row, the owner from the audit log. */
export async function completeSharedDiscordInstall(c: Context, deps: AgentdDeps): Promise<Response> {
  const ownerId = getOwnerId(c);
  const guildId = c.req.query('guild_id');
  const opened = await openSharedInstall(c, deps, 'discord');
  if (opened instanceof Response) return opened;
  const { state, request } = opened;
  const config = sharedDiscordConfig();
  const agent = await deps.store.get('agents', request.agentId);
  if (guildId === undefined || guildId === '' || c.req.query('error') !== undefined || !config || !agent) {
    return failSharedInstall(c, deps, state, 'The installation was cancelled', 'The installation was cancelled. You can start again from Juno.', 400);
  }
  const fetchFn = deps.channelFetch ?? fetch;
  const me = await discordCall(fetchFn, config.botToken, 'GET', '/users/@me');
  const botUserId = me.ok && typeof me.body === 'object' && me.body !== null ? str((me.body as Record<string, unknown>)['id']) : undefined;
  if (botUserId === undefined) {
    return failSharedInstall(c, deps, state, 'Discord could not be reached', 'Discord could not be reached. Please start again from Juno.', 502);
  }
  const id = 'discord:' + guildId;
  const prior = await deps.store.get('channelInstallations', id);
  if (prior && docOwnerId(prior) !== ownerId) {
    return failSharedInstall(c, deps, state, 'This server is already connected to another Juno account', 'This Discord server is already connected to another Juno account.', 409);
  }
  const guild = await discordCall(fetchFn, config.botToken, 'GET', '/guilds/' + guildId);
  const inviter = await discordInviter(fetchFn, config.botToken, botUserId, guild.ok ? guild.body : { id: guildId });
  const now = new Date().toISOString();
  const guildName = guild.ok && typeof guild.body === 'object' && guild.body !== null ? str((guild.body as Record<string, unknown>)['name']) : undefined;
  const label = guildName === undefined ? prior?.label : guildName.slice(0, 80);
  const installation = await deps.store.put('channelInstallations', {
    id, ownerId, kind: 'discord', teamId: guildId, botToken: encryptSecret(config.botToken), botUserId,
    ...(inviter !== undefined ? { installedBy: inviter } : prior?.installedBy === undefined ? {} : { installedBy: prior.installedBy }),
    ...(label === undefined ? {} : { label }),
    ...(prior?.webhooks === undefined ? {} : { webhooks: prior.webhooks }),
    createdAt: prior?.createdAt ?? now, updatedAt: now,
  });
  const row = await provisionDiscordAgent(deps, installation, agent);
  await settlePending(deps.store, state, { state: 'connected', resultRowId: row.id });
  return c.html(sharedAppPage('Connected. You can close this tab and go back to Juno.'));
}

// --- the shared bot's Gateway ----------------------------------------------------------------------------------

const messageSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().optional(),
  webhook_id: z.string().optional(),
  content: z.string().default(''),
  author: z.object({ id: z.string(), username: z.string().optional(), global_name: z.string().nullish(), bot: z.boolean().optional() }),
  mentions: z.array(discordUserSchema()).default([]),
  mention_roles: z.array(z.string()).default([]),
  referenced_message: z.object({ author: z.object({ id: z.string() }) }).nullish(),
});

/** Role mentions as text: the addressed agent's own role (`skip`) goes, every other agent's role reads "@Name", so it knows who else was named. */
function namedRoles(text: string, roles: readonly string[], rows: readonly ChannelRow[], skip?: string): string {
  let out = text;
  for (const role of roles) {
    const handle = role === skip ? undefined : rows.find((row) => row.roleId === role)?.handle;
    out = out.split('<@&' + role + '>').join(handle === undefined ? '' : '@' + handle);
  }
  return out;
}

/**
 * Which agents' rows a message is for (null: nobody was addressed) and the normalized event. Every agent named is woken and
 * decides itself whether to answer; with several named, each sees all the names ("@Test ask @Nova …") so it can tell who
 * was asked. `row` is the first named.
 */
export function routeSharedDiscordMessage(
  message: unknown,
  botUserId: string,
  rows: ChannelRow[],
  mainRow: ChannelRow | undefined,
): { row: ChannelRow; others: ChannelRow[]; event: DiscordChannelEvent } | null {
  const parsed = messageSchema.safeParse(message);
  if (!parsed.success) return null;
  const msg = parsed.data;
  if (msg.author.bot === true || msg.webhook_id !== undefined || msg.author.id === botUserId) return null;
  const isGuild = msg.guild_id !== undefined;
  const at = (row: ChannelRow): number => (row.roleId === undefined || !msg.mention_roles.includes(row.roleId) ? -1 : msg.content.indexOf('<@&' + row.roleId + '>'));
  const named = rows.filter((row) => at(row) >= 0).sort((a, b) => at(a) - at(b));
  const botAddressed = msg.mentions.some((user) => user.id === botUserId) || msg.referenced_message?.author.id === botUserId;
  const row = isGuild ? (named[0] ?? (botAddressed ? mainRow : undefined)) : mainRow;
  if (row === undefined) return null;
  const others = isGuild ? named.slice(1) : [];
  let text = namedRoles(msg.content, msg.mention_roles, rows, others.length === 0 ? row.roleId : undefined);
  text = text.split('<@' + botUserId + '>').join('').split('<@!' + botUserId + '>').join('');
  const rewritten = rewriteDiscordMentions(text, msg.mentions, botUserId);
  text = rewritten.text.trim();
  if (text.length === 0) return null;
  return {
    row,
    others,
    event: {
      chatId: msg.channel_id,
      chatType: isGuild ? 'group' : 'private',
      threadId: msg.channel_id,
      externalMessageId: msg.id,
      from: { id: msg.author.id, name: msg.author.global_name ?? msg.author.username ?? '', ...(msg.author.username === undefined ? {} : { handle: msg.author.username }) },
      text,
      ...(rewritten.mentions.length === 0 ? {} : { mentions: rewritten.mentions }),
    },
  };
}

async function sharedRows(store: Store): Promise<ChannelRow[]> {
  const page = await store.list('channels', { where: { kind: 'discord' }, limit: 500 });
  return page.items.filter((row) => row.installationId !== undefined);
}

/** The row an owner's main agent answers on: their default agent's row in this installation, else any of their rows. */
async function mainRowOf(store: Store, ownerId: string, candidates: ChannelRow[]): Promise<ChannelRow | undefined> {
  const main = (await jobAgent(store, ownerId))?.agent;
  return candidates.find((row) => row.agentId === main?.id) ?? candidates[0];
}

function scopedDeps(ctx: ChannelRunnerContext, ownerId: string) {
  const scoped = typeof ctx.store.forOwner === 'function' ? ctx.store.forOwner(ownerId) : ctx.store;
  return { store: scoped, enqueuer: ctx.enqueuer, channels: ctx.channels, ...(ctx.channelFetch ? { channelFetch: ctx.channelFetch } : {}), ...(ctx.identity ? { identity: ctx.identity } : {}), ...(ctx.blobs ? { blobs: ctx.blobs } : {}) };
}

/**
 * A message our own app posted (the shared bot, or one of the install's webhooks) that role-mentions other agents of the same owner:
 * the rows to wake and the normalized event, or null. Everything from any other bot or webhook is not ours and never gets here.
 */
export function routeAgentDiscordPost(
  message: unknown,
  ours: { botUserId: string; webhookIds: ReadonlySet<string> },
  rows: ChannelRow[],
): { targets: ChannelRow[]; event: DiscordChannelEvent } | null {
  const parsed = messageSchema.safeParse(message);
  if (!parsed.success) return null;
  const msg = parsed.data;
  if (msg.guild_id === undefined || !(msg.author.id === ours.botUserId || (msg.webhook_id !== undefined && ours.webhookIds.has(msg.webhook_id)))) return null;
  const targets = rows.filter((row) => row.roleId !== undefined && msg.mention_roles.includes(row.roleId));
  if (targets.length === 0) return null;
  let text = namedRoles(msg.content, msg.mention_roles, rows, targets.length === 1 ? targets[0]?.roleId : undefined);
  text = text.split('<@' + ours.botUserId + '>').join('').split('<@!' + ours.botUserId + '>').join('');
  const rewritten = rewriteDiscordMentions(text, msg.mentions, ours.botUserId);
  text = rewritten.text.trim();
  if (text.length === 0) return null;
  return {
    targets,
    event: {
      chatId: msg.channel_id,
      chatType: 'group',
      threadId: msg.channel_id,
      externalMessageId: msg.id,
      from: { id: msg.author.id, name: msg.author.username ?? '' },
      text,
      ...(rewritten.mentions.length === 0 ? {} : { mentions: rewritten.mentions }),
    },
  };
}

const SENT_LOOKUP_TRIES = 4;
const SENT_LOOKUP_GAP_MS = 400;

/** Our record of the message (written right after the send returns, so Discord's event can beat it by a moment); undefined: not one of ours. */
async function sentRecord(store: Store, messageId: string): Promise<{ agentId: string; runId: string } | undefined> {
  for (let attempt = 0; attempt < SENT_LOOKUP_TRIES; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SENT_LOOKUP_GAP_MS));
    const receipt = await store.get('eventReceipts', DISCORD_SENT_TYPE + ':' + messageId);
    if (receipt) return { agentId: receipt.agentId, runId: receipt.runId };
  }
  return undefined;
}

/** An agent's post that mentions other agents: wake each, in its own conversation for the channel, one hop deeper on the sender's chain. */
async function admitAgentPost(ctx: ChannelRunnerContext, ownerId: string, routed: { targets: ChannelRow[]; event: DiscordChannelEvent }): Promise<void> {
  const deps = scopedDeps(ctx, ownerId);
  const record = routed.event.externalMessageId === undefined ? undefined : await sentRecord(deps.store, routed.event.externalMessageId);
  if (record === undefined) return;
  const hop = await readRunHop(deps.store, record.runId);
  const chain = { chainId: hop?.chainId ?? record.runId, depth: (hop?.depth ?? 0) + 1 };
  const sender = await deps.store.get('agents', record.agentId);
  const event = { ...routed.event, from: { id: 'agent:' + record.agentId, name: sender?.name ?? routed.event.from?.name ?? 'agent' } };
  for (const row of routed.targets.filter((candidate) => candidate.agentId !== record.agentId)) {
    const result = await runWithOwner(ownerId, () => admitChannelEvent(deps, ownerId, 'discord', row.channelId, event, { agentId: record.agentId, hop: chain }));
    if (result.status >= 400) log.warn({ channel: row.channelId, status: result.status }, 'agent mention was not admitted');
  }
}

/** One MESSAGE_CREATE of the shared bot. */
export async function admitSharedDiscordMessage(ctx: ChannelRunnerContext, botUserId: string, message: unknown, voice?: DiscordVoice): Promise<void> {
  const guildId = typeof message === 'object' && message !== null ? str((message as Record<string, unknown>)['guild_id']) : undefined;
  const authorId = typeof message === 'object' && message !== null ? str(((message as Record<string, unknown>)['author'] as Record<string, unknown> | undefined)?.['id']) : undefined;
  const all = await sharedRows(ctx.store);
  let rows: ChannelRow[];
  let ownerId: string | undefined;
  let webhookIds: ReadonlySet<string> = new Set();
  if (guildId !== undefined) {
    const installation = await ctx.store.get('channelInstallations', 'discord:' + guildId);
    if (!installation) return;
    ownerId = installation.ownerId;
    webhookIds = new Set(Object.values(installation.webhooks ?? {}).map((hook) => hook.id));
    rows = all.filter((row) => row.installationId === installation.id);
  } else {
    // A DM: the sender must be the platform account an owner is bound to; anyone else is not let into an owner's chat.
    rows = all.filter((row) => authorId !== undefined && row.ownerExternalId === authorId);
    ownerId = rows[0]?.ownerId;
  }
  if (ownerId === undefined) return;
  const mine = rows.filter((row) => row.ownerId === ownerId);
  const agentPost = routeAgentDiscordPost(message, { botUserId, webhookIds }, mine);
  if (agentPost !== null) return admitAgentPost(ctx, ownerId, agentPost);
  const routed = routeSharedDiscordMessage(message, botUserId, mine, await mainRowOf(ctx.store, ownerId, mine));
  if (routed === null) return;
  const owner = ownerId;
  // A mention in a voice channel's text chat carries the recent transcript.
  const event = voice === undefined ? routed.event : voice.decorate(SHARED_VOICE_ROW_ID, routed.event);
  for (const row of [routed.row, ...routed.others]) {
    const result = await runWithOwner(owner, () => admitChannelEvent(scopedDeps(ctx, owner), owner, 'discord', row.channelId, event));
    if (result.status >= 400) log.warn({ channel: row.channelId, status: result.status }, 'shared discord message was not admitted');
  }
}

/** A button tap on the shared bot: the tapped message names the agent's row. */
async function sharedInteraction(ctx: ChannelRunnerContext, data: unknown): Promise<void> {
  const click = discordAdapter.inbound.parseClick(data);
  if (click === undefined) return;
  const channelId = await channelIdOfToken(ctx.store, click.token);
  const row = channelId === undefined ? null : await ctx.store.get('channels', channelRowId('discord', channelId));
  if (!row || row.installationId === undefined || channelId === undefined) return;
  await answerChannelClick(scopedDeps(ctx, row.ownerId), row.ownerId, 'discord', channelId, data);
}

/** The shared bot joined (or reconnected to) a server: finish what the redirect could not (missing roles, the inviter). */
async function sharedGuild(ctx: ChannelRunnerContext, token: string, botUserId: string, guild: unknown): Promise<void> {
  const guildId = typeof guild === 'object' && guild !== null ? str((guild as Record<string, unknown>)['id']) : undefined;
  const installation = guildId === undefined ? null : await ctx.store.get('channelInstallations', 'discord:' + guildId);
  if (!installation) return;
  const deps = { store: ctx.store, ...(ctx.channelFetch ? { channelFetch: ctx.channelFetch } : {}) };
  let current = installation;
  if (current.installedBy === undefined) {
    const inviter = await discordInviter(ctx.channelFetch ?? fetch, token, botUserId, guild);
    if (inviter !== undefined) current = await ctx.store.patch('channelInstallations', current.id, { installedBy: inviter, updatedAt: new Date().toISOString() });
  }
  for (const row of (await sharedRows(ctx.store)).filter((candidate) => candidate.installationId === current.id)) {
    const agent = await ctx.store.get('agents', row.agentId);
    if (!agent) continue;
    if (row.roleId === undefined && row.handleStatus === 'failed') await provisionDiscordAgent(deps, current, agent);
    else if (row.ownerExternalId === undefined && current.installedBy !== undefined) await ctx.store.patch('channels', row.id, { ownerExternalId: current.installedBy, updatedAt: new Date().toISOString() });
  }
}

export interface SharedDiscordHooks {
  onMessage(message: unknown): void;
  onInteraction(data: unknown): void;
  onGuild(guild: unknown): void;
}

export function sharedHooks(ctx: ChannelRunnerContext, token: string, botUserId: string, voice?: DiscordVoice): SharedDiscordHooks {
  const guard = (what: string) => (err: unknown): void => { log.warn({ err }, 'shared discord ' + what + ' failed'); };
  return {
    onMessage: (message) => { void admitSharedDiscordMessage(ctx, botUserId, message, voice).catch(guard('message')); },
    onInteraction: (data) => { void sharedInteraction(ctx, data).catch(guard('interaction')); },
    onGuild: (guild) => { void sharedGuild(ctx, token, botUserId, guild).catch(guard('guild')); },
  };
}

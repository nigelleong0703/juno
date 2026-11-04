/**
 * The shared Juno Slack app (`mode: 'oauth'`): one app for everyone, a user group per agent so people can @-mention it.
 *
 * The app belongs to Juno (env SLACK_CLIENT_ID / SLACK_CLIENT_SECRET / SLACK_SIGNING_SECRET); an owner installs it into a workspace
 * once (OAuth v2), which stores one `channelInstallations` row `slack:<teamId>` with the sealed bot token. Every agent of the owner
 * then gets a `channels` row (`channelId` `<teamId>.<agentId>`) pointing at the installation, plus a Slack user group named after
 * the agent. Events from all workspaces arrive at one URL (`/v1/channels/slack/events`, verified by the api with the shared signing
 * secret), are routed by `team_id` to the installation, and a message that mentions `<!subteam^ID>` goes to the agent owning that
 * group; DMs and plain @-mentions of the app go to the owner's main agent. Replies are posted with the agent's own name and picture.
 *
 * Free workspaces cannot create user groups (`paid_teams_only`): the agent stays connected without a handle (`handleStatus:
 * needs_paid_plan`) and the groups are retried at most once a day when the workspace talks to us, so upgrading turns them on.
 */
import type { Context } from 'hono';
import type { Agent } from '@agent-desktop/public-contracts';
import { channelRowId, type ChannelInstallation, type ChannelRow, type Store } from '@agent-desktop/contracts';
import { decryptSecret, encryptSecret } from '@agent-desktop/contracts/secrets';
import { resolveSlackMentions, slackUserNamer } from '@agent-desktop/channels/slack/mentions';
import { isChannelMessage, isReply, slackFiles } from '@agent-desktop/channels/slack/api';
import { handleSlackNativeEvent, handleSlackShortcut, SLACK_ASK_SHORTCUT, SLACK_SUGGESTED_PROMPTS } from './native.js';
import { withSlackExternal } from './external.js';
import { jobAgent } from 'juno-agent/modules/memory/jobs/agent';
import { admitChannelEvent, type AdmitDeps, type AdmitResult } from '../../routes/channels.js';
import { docOwnerId } from '../../routes/relationships.js';
import { getOwnerId } from '../../auth.js';
import type { AgentdDeps } from '../../routes/index.js';
import { failSharedInstall, openSharedInstall, sharedAppPage, type SharedAppSpec } from '../shared-app.js';
import { newSecret } from '../bind.js';
import { channelIdOfToken } from '../origin.js';
import { slackAdapter } from '@agent-desktop/channels/sdk';
import { answerChannelClick } from '../interactions.js';
import { settlePending } from '../pending.js';
import { channelsPublicUrl } from '../public-url.js';

export const SLACK_SHARED_BOT_SCOPES = [
  'app_mentions:read', 'chat:write', 'chat:write.customize',
  'channels:history', 'groups:history', 'im:history', 'im:read', 'im:write',
  'channels:read', 'groups:read', 'reactions:write', 'files:read', 'files:write',
  'users:read', 'users:read.email', 'usergroups:read', 'usergroups:write',
  // BACKEND 6.8: the `/juno` command and the "Ask <agent> about this" message shortcut, long results as a canvas, the AI-app surface.
  'commands', 'canvases:write', 'assistant:write',
];
export const SLACK_SHARED_BOT_EVENTS = ['app_mention', 'message.im', 'message.channels', 'message.groups', 'assistant_thread_started', 'app_home_opened', 'member_joined_channel'];
/** What the owner of the shared app has to re-approve after BACKEND 6.8: the scopes and events added to an already installed app. */
export const SLACK_SCOPES_ADDED_6_8 = ['commands', 'canvases:write', 'assistant:write'];

const HANDLE_RETRY_MS = 24 * 60 * 60_000;
const PLAN_ERRORS = new Set(['paid_teams_only', 'plan_upgrade_required', 'paid_only']);

export interface SharedSlackConfig { clientId: string; clientSecret: string; signingSecret: string }

/** The shared app's credentials from the environment; undefined when it is not set up on this server. */
export function sharedSlackConfig(): SharedSlackConfig | undefined {
  const clientId = process.env['SLACK_CLIENT_ID']?.trim();
  const clientSecret = process.env['SLACK_CLIENT_SECRET']?.trim();
  const signingSecret = process.env['SLACK_SIGNING_SECRET']?.trim();
  return clientId && clientSecret && signingSecret ? { clientId, clientSecret, signingSecret } : undefined;
}

/** What to paste into "Create app from manifest" once, when setting up the shared app. */
export function slackSharedManifest(publicUrl: string): Record<string, unknown> {
  return {
    display_information: { name: 'Juno' },
    features: {
      // The Home tab lists the agent's open tasks and routines (native.ts); the Messages tab is where assistant threads live.
      app_home: { home_tab_enabled: true, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: 'Juno', always_online: true },
      // docs.slack.dev/reference/app-manifest: a new app can only use agent_view (assistant_view is the older surface); needs a description.
      agent_view: {
        agent_description: 'Your Juno agents: ask them for anything, in a DM, a thread or a channel.',
        suggested_prompts: SLACK_SUGGESTED_PROMPTS,
      },
      slash_commands: [{ command: '/juno', url: publicUrl + '/v1/channels/slack/commands', description: 'Ask your Juno agent', usage_hint: '[agent] what you need', should_escape: false }],
      shortcuts: [{ name: 'Ask Juno about this', type: 'message', callback_id: SLACK_ASK_SHORTCUT, description: 'Ask your Juno agent about this message' }],
    },
    oauth_config: { redirect_urls: [publicUrl + '/v1/channels/slack/oauth/callback'], scopes: { bot: SLACK_SHARED_BOT_SCOPES } },
    settings: {
      event_subscriptions: { request_url: publicUrl + '/v1/channels/slack/events', bot_events: SLACK_SHARED_BOT_EVENTS },
      interactivity: { is_enabled: true, request_url: publicUrl + '/v1/channels/slack/interactions' },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
    },
  };
}

type SlackResult = { ok: true; data: Record<string, unknown> } | { ok: false; error: string; unreachable: boolean };

async function slack(fetchFn: typeof fetch, method: string, form: Record<string, string>, token?: string): Promise<SlackResult> {
  let response: Response;
  try {
    response = await fetchFn('https://slack.com/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(token === undefined ? {} : { authorization: 'Bearer ' + token }) },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    return { ok: false, error: 'unreachable', unreachable: true };
  }
  const payload: unknown = await response.json().catch(() => null);
  const data = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  if (response.status >= 500) return { ok: false, error: 'unreachable', unreachable: true };
  if (data['ok'] !== true) return { ok: false, error: typeof data['error'] === 'string' ? data['error'] : 'failed', unreachable: false };
  return { ok: true, data };
}

/** The @-mention handle for an agent name: lowercase letters, digits and `-`, at most 21 characters (Slack's limit is 21). */
export function handleSlug(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 18).replace(/-+$/, '');
  return slug === '' ? 'agent' : slug;
}

type GroupResult = { ok: true; id: string; handle: string } | { ok: false; plan: boolean; error: string };

/** Creates the agent's user group; a taken handle gets a numeric suffix. */
async function createUserGroup(fetchFn: typeof fetch, installation: ChannelInstallation, name: string): Promise<GroupResult> {
  const token = decryptSecret(installation.botToken);
  const base = handleSlug(name);
  let withUsers = true;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const handle = attempt === 1 ? base : base + '-' + String(attempt);
    const res = await slack(fetchFn, 'usergroups.create', { name, handle, ...(withUsers ? { users: installation.botUserId } : {}) }, token);
    if (res.ok) {
      const group = res.data['usergroup'];
      const id = typeof group === 'object' && group !== null ? (group as Record<string, unknown>)['id'] : undefined;
      return typeof id === 'string' ? { ok: true, id, handle } : { ok: false, plan: false, error: 'no_usergroup_id' };
    }
    if (PLAN_ERRORS.has(res.error)) return { ok: false, plan: true, error: res.error };
    if (res.error === 'invalid_users' && withUsers) { withUsers = false; attempt--; continue; }
    if (res.error === 'handle_already_exists' || res.error === 'name_already_exists') continue;
    return { ok: false, plan: false, error: res.error };
  }
  return { ok: false, plan: false, error: 'handle_already_exists' };
}

function groupFields(result: GroupResult): Pick<ChannelRow, 'usergroupId' | 'handle' | 'handleStatus'> {
  if (result.ok) return { usergroupId: result.id, handle: result.handle, handleStatus: 'ok' };
  return { handleStatus: result.plan ? 'needs_paid_plan' : 'failed' };
}

function sharedRowId(teamId: string, agentId: string): { id: string; channelId: string } {
  const channelId = teamId + '.' + agentId;
  return { id: channelRowId('slack', channelId), channelId };
}

/**
 * The agent's `channels` row on this installation, with a user group when the workspace allows it. `withGroup: false` makes a plain
 * row (DMs to the app for an agent nobody mentioned by name). Idempotent.
 */
export async function provisionSlackAgent(
  deps: { store: Store; channelFetch?: typeof fetch },
  installation: ChannelInstallation,
  agent: Pick<Agent, 'id' | 'name'>,
  withGroup = true,
): Promise<ChannelRow> {
  const { id, channelId } = sharedRowId(installation.teamId, agent.id);
  const existing = await deps.store.get('channels', id);
  if (existing && (existing.usergroupId !== undefined || !withGroup)) return existing;
  const group = withGroup ? await createUserGroup(deps.channelFetch ?? fetch, installation, agent.name) : undefined;
  const now = new Date().toISOString();
  const row: ChannelRow = {
    ...(existing ?? { id, ownerId: installation.ownerId, agentId: agent.id, kind: 'slack', channelId, secretHashHex: newSecret().hashHex, createdAt: now }),
    installationId: installation.id,
    displayName: agent.name,
    ...(installation.installedBy === undefined ? {} : { ownerExternalId: existing?.ownerExternalId ?? installation.installedBy }),
    ...(group === undefined ? {} : groupFields(group)),
    status: 'active',
    updatedAt: now,
  };
  return deps.store.put('channels', row);
}

/** Tries again to give agents without a user group one; at most once a day per workspace. */
export async function retryMissingHandles(deps: { store: Store; channelFetch?: typeof fetch }, installation: ChannelInstallation, now = Date.now()): Promise<void> {
  if (installation.handlesCheckedAt !== undefined && now - Date.parse(installation.handlesCheckedAt) < HANDLE_RETRY_MS) return;
  const page = await deps.store.list('channels', { where: { kind: 'slack' }, limit: 500 });
  const waiting = page.items.filter((row) => row.installationId === installation.id && row.handleStatus === 'needs_paid_plan');
  if (waiting.length === 0) return;
  await deps.store.patch('channelInstallations', installation.id, { handlesCheckedAt: new Date(now).toISOString() });
  for (const row of waiting) {
    const agent = await deps.store.get('agents', row.agentId);
    if (agent) await provisionSlackAgent(deps, installation, agent);
  }
}

/** Best effort: the agent's user group is switched off (Slack has no delete); never throws. */
export async function disconnectSlackShared(deps: { store: Store; channelFetch?: typeof fetch }, row: ChannelRow): Promise<void> {
  try {
    const installation = row.installationId === undefined ? null : await deps.store.get('channelInstallations', row.installationId);
    if (!installation || row.usergroupId === undefined) return;
    await slack(deps.channelFetch ?? fetch, 'usergroups.disable', { usergroup: row.usergroupId }, decryptSecret(installation.botToken));
  } catch {
    // The row is removed regardless.
  }
}

export async function slackInstallationsOf(store: Store, ownerId: string): Promise<ChannelInstallation[]> {
  const page = await store.list('channelInstallations', { where: { kind: 'slack' }, limit: 100 });
  return page.items.filter((item) => docOwnerId(item) === ownerId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function authorizeUrl(config: SharedSlackConfig, publicUrl: string, state: string): string {
  return 'https://slack.com/oauth/v2/authorize?' + new URLSearchParams({
    client_id: config.clientId,
    scope: SLACK_SHARED_BOT_SCOPES.join(','),
    redirect_uri: publicUrl + '/v1/channels/slack/oauth/callback',
    state,
  }).toString();
}

/** The shared Slack app's install (`SharedAppInstall` walk, see shared-app.ts). */
export const slackSharedApp: SharedAppSpec<SharedSlackConfig> = {
  platform: 'slack',
  config: sharedSlackConfig,
  notConfiguredMessage: 'The shared Slack app is not set up on this server (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET)',
  publicUrlMessage: 'Slack must reach this server: set CHANNELS_PUBLIC_URL first',
  installUrl: authorizeUrl,
};

/** The OAuth redirect of a shared install: code to bot token, installation row, the agent's row and user group. */
export async function completeSharedSlackInstall(c: Context, deps: AgentdDeps): Promise<Response> {
  const ownerId = getOwnerId(c);
  const code = c.req.query('code');
  const opened = await openSharedInstall(c, deps, 'slack');
  if (opened instanceof Response) return opened;
  const { state, request } = opened;
  const config = sharedSlackConfig();
  const publicUrl = channelsPublicUrl();
  if (code === undefined || code === '' || c.req.query('error') !== undefined) {
    return failSharedInstall(c, deps, state, 'The installation was cancelled', 'The installation was cancelled. You can start again from Juno.', 400);
  }
  const agent = await deps.store.get('agents', request.agentId);
  if (!config || publicUrl === undefined || !agent) {
    return failSharedInstall(c, deps, state, 'The shared Slack app is not set up', 'Something went wrong. Please start again from Juno.', 500);
  }
  const access = await slack(deps.channelFetch ?? fetch, 'oauth.v2.access', {
    client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: publicUrl + '/v1/channels/slack/oauth/callback',
  });
  const botToken = access.ok ? access.data['access_token'] : undefined;
  const botUserId = access.ok ? access.data['bot_user_id'] : undefined;
  const team = access.ok ? access.data['team'] : undefined;
  const teamId = typeof team === 'object' && team !== null ? (team as Record<string, unknown>)['id'] : undefined;
  if (!access.ok || typeof botToken !== 'string' || typeof botUserId !== 'string' || typeof teamId !== 'string') {
    return failSharedInstall(c, deps, state, 'Slack refused the install: ' + (access.ok ? 'no bot token' : access.error), 'Slack refused the installation. Please start again from Juno.', 502);
  }
  const id = 'slack:' + teamId;
  const prior = await deps.store.get('channelInstallations', id);
  if (prior && docOwnerId(prior) !== ownerId) {
    return failSharedInstall(c, deps, state, 'This workspace is already connected to another Juno account', 'This Slack workspace is already connected to another Juno account.', 409);
  }
  const authed = access.data['authed_user'];
  const installer = typeof authed === 'object' && authed !== null ? (authed as Record<string, unknown>)['id'] : undefined;
  const now = new Date().toISOString();
  // The OAuth answer lists the bot's scopes as one comma-separated string (`scope`); a reinstall replaces the list.
  const scopeText = access.data['scope'];
  const scopes = typeof scopeText === 'string' ? scopeText.split(',').map((scope) => scope.trim()).filter((scope) => scope !== '') : [];
  const teamName = typeof team === 'object' && team !== null ? (team as Record<string, unknown>)['name'] : undefined;
  const label = typeof teamName === 'string' && teamName.trim() !== '' ? teamName.trim().slice(0, 80) : prior?.label;
  const installation = await deps.store.put('channelInstallations', {
    id, ownerId, kind: 'slack', teamId, botToken: encryptSecret(botToken), botUserId,
    ...(typeof installer === 'string' ? { installedBy: installer } : prior?.installedBy === undefined ? {} : { installedBy: prior.installedBy }),
    ...(label === undefined ? {} : { label }),
    grantedScopes: scopes,
    createdAt: prior?.createdAt ?? now, updatedAt: now,
  });
  const row = await provisionSlackAgent(deps, installation, agent);
  await settlePending(deps.store, state, { state: 'connected', resultRowId: row.id });
  return c.html(sharedAppPage('Connected. You can close this tab and go back to Juno.'));
}

// --- events ----------------------------------------------------------------------------------------------

/** Whether a Slack event_callback carries files (`event.files`): the one kind whose admission fetches bytes before the wake, so it is answered first. */
export function slackCarriesFiles(body: unknown): boolean {
  const event = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['event'] : undefined;
  const files = typeof event === 'object' && event !== null ? (event as Record<string, unknown>)['files'] : undefined;
  return Array.isArray(files) && files.length > 0;
}

const SUBTEAM = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g;

interface SlackEventBody {
  team_id?: unknown;
  event?: Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The row an event is for and the normalized message, or null when the agent should not hear it. */
function routeSharedEvent(rows: ChannelRow[], installation: ChannelInstallation, event: Record<string, unknown>, dmRow: ChannelRow | undefined) {
  const type = str(event['type']);
  const channel = str(event['channel']);
  const user = str(event['user']);
  const ts = str(event['ts']);
  const raw = typeof event['text'] === 'string' ? event['text'] : undefined;
  // A file_share message (files attached, maybe no text) is a message; every other subtype is not the agent's business.
  if ((event['subtype'] !== undefined && event['subtype'] !== 'file_share') || event['bot_id'] !== undefined || channel === undefined || user === undefined || ts === undefined || raw === undefined) return null;
  if (user === installation.botUserId) return null;
  const groupIds = [...raw.matchAll(SUBTEAM)].map((match) => match[1]);
  const named = rows.find((row) => row.usergroupId !== undefined && groupIds.includes(row.usergroupId));
  const isDm = type === 'message' && event['channel_type'] === 'im';
  let targets: ChannelRow[] = [];
  // A channel message nobody addressed (no user group, no @-mention of the app): every agent of the workspace is offered it, and each one's
  // ingress decides whether it is part of that thread or listens to that channel (channels/listening.ts).
  const heard = !isDm && named === undefined && isChannelMessage({ type: type ?? '', channel_type: str(event['channel_type']), text: raw }, installation.botUserId);
  if (isDm) targets = dmRow === undefined ? [] : [dmRow];
  else if (type === 'message') targets = named !== undefined ? [named] : heard ? rows : [];
  else if (type === 'app_mention') targets = named === undefined && dmRow !== undefined ? [dmRow] : [];
  if (targets.length === 0) return null;
  const text = raw.replace(SUBTEAM, '').split('<@' + installation.botUserId + '>').join('').trim();
  const files = slackFiles(event['files']);
  if (text.length === 0 && files.length === 0) return null;
  const threadTs = str(event['thread_ts']) ?? (isDm ? undefined : ts);
  return {
    targets,
    message: {
      ...(heard ? { addressed: false } : {}),
      chatId: channel,
      chatType: isDm ? ('private' as const) : ('group' as const),
      // A message of the channel itself that nobody addressed is kept in the channel's own conversation; one in a thread, in that thread's.
      threadId: threadTs === undefined || (heard && !isReply({ ts, thread_ts: str(event['thread_ts']) })) ? channel : channel + ':' + threadTs,
      externalMessageId: channel + ':' + ts,
      from: { id: user, name: '' },
      text,
      ...(files.length === 0 ? {} : { files }),
    },
  };
}

/** One event_callback from the shared app, already signature-checked by the api and forwarded as the installation's owner. */
export async function handleSharedSlackEvent(deps: AdmitDeps, ownerId: string, body: unknown): Promise<AdmitResult> {
  const record: SlackEventBody = typeof body === 'object' && body !== null ? (body as SlackEventBody) : {};
  const teamId = str(record.team_id);
  const installation = teamId === undefined ? null : await deps.store.get('channelInstallations', 'slack:' + teamId);
  if (!installation || docOwnerId(installation) !== ownerId) return { status: 404, body: { error: { code: 'INSTALLATION_NOT_FOUND', message: 'No such workspace installation' } } };
  await retryMissingHandles(deps, installation).catch(() => undefined);
  const event = record.event;
  if (event === undefined) return { status: 200, body: { received: false } };
  const page = await deps.store.list('channels', { where: { kind: 'slack' }, limit: 500 });
  const rows = page.items.filter((row) => row.installationId === installation.id);
  const main = (await jobAgent(deps.store, ownerId))?.agent;
  // A DM or a plain @-mention of the app goes to the owner's main agent when it is enabled in this workspace, else to whichever agent is.
  const dmRow = rows.find((row) => row.agentId === main?.id) ?? rows[0];
  if (dmRow === undefined) return { status: 200, body: { received: false } };
  const native = await handleSlackNativeEvent(deps, installation, rows, dmRow, event);
  if (native) return { status: 200, body: { received: true, native: true } };
  const routed = routeSharedEvent(rows, installation, event, dmRow);
  if (routed === null) return { status: 200, body: { received: false } };
  const token = decryptSecret(installation.botToken);
  const nameOf = slackUserNamer(deps.channelFetch ?? fetch, token);
  const resolved = await resolveSlackMentions(nameOf, routed.message.text);
  // The speaker's name as Slack has it (the event carries only the id).
  const message = { ...routed.message, from: { ...routed.message.from, name: await nameOf(routed.message.from.id) }, text: resolved.text, ...(resolved.mentions.length === 0 ? {} : { mentions: resolved.mentions }) };
  const external = await withSlackExternal(deps.channelFetch ?? fetch, token, message);
  const results: AdmitResult[] = [];
  for (const target of routed.targets) results.push(await admitChannelEvent(deps, ownerId, 'slack', target.channelId, external));
  return results.find((result) => result.status === 202) ?? results[0] ?? { status: 200, body: { received: false } };
}

/** A button tap on the shared app: the workspace gives the installation, the tapped message gives the agent's row. */
export async function handleSharedSlackInteraction(deps: AdmitDeps, ownerId: string, form: Record<string, unknown>): Promise<void> {
  // A message shortcut ("Ask Juno about this") is not a button tap.
  const raw = form['payload'];
  if (typeof raw === 'string') {
    const payload: unknown = (() => { try { return JSON.parse(raw); } catch { return null; } })();
    if (typeof payload === 'object' && payload !== null && (payload as Record<string, unknown>)['type'] === 'message_action') {
      await handleSlackShortcut(deps, ownerId, payload as Record<string, unknown>);
      return;
    }
  }
  const click = slackAdapter.inbound.parseClick(form['payload']);
  if (click === undefined) return;
  const channelId = await channelIdOfToken(deps.store, click.token);
  if (channelId === undefined) return;
  const row = await deps.store.get('channels', channelRowId('slack', channelId));
  if (!row || row.installationId === undefined || docOwnerId(row) !== ownerId) return;
  await answerChannelClick(deps, ownerId, 'slack', channelId, form['payload']);
}

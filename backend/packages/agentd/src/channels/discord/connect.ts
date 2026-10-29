/**
 * Discord connector: the shared Juno bot only (`{mode:'oauth'}`, see shared.ts). Juno has no per-agent Discord bots any more: nobody
 * creates a bot or pastes a token. The bot's owner binding after an invite reads the audit log (`discordInviter`).
 */
import type { ChannelConnector } from '../connect.js';
import { discordCall } from '@agent-desktop/channels/discord/api';
import { startSharedInstall } from '../shared-app.js';
import { discordSharedApp, disconnectDiscordShared } from './shared.js';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Whoever added the bot to a server (the BOT_ADD audit log entry, action type 28, targeting our bot; needs View Audit Log), else the
 * server's owner.
 */
export async function discordInviter(
  fetchFn: typeof fetch,
  token: string,
  botUserId: string,
  guild: unknown,
): Promise<string | undefined> {
  if (typeof guild !== 'object' || guild === null) return undefined;
  const record = guild as Record<string, unknown>;
  const guildId = str(record['id']);
  if (guildId === undefined) return undefined;
  const log = await discordCall(fetchFn, token, 'GET', '/guilds/' + guildId + '/audit-logs?action_type=28&limit=50');
  const entries = log.ok && typeof log.body === 'object' && log.body !== null ? (log.body as Record<string, unknown>)['audit_log_entries'] : undefined;
  const added = Array.isArray(entries)
    ? entries.map((entry: unknown) => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {})).find((entry) => entry['target_id'] === botUserId)
    : undefined;
  return str(added?.['user_id']) ?? str(record['owner_id']);
}

export const discordConnector: ChannelConnector = {
  async connect(ctx) {
    const mode = typeof ctx.body === 'object' && ctx.body !== null ? (ctx.body as Record<string, unknown>)['mode'] : undefined;
    if (mode !== 'oauth') return { ok: false, status: 400, code: 'UNSUPPORTED_CONNECT_MODE', message: "Discord connects through the shared Juno bot: send {mode:'oauth'}" };
    return startSharedInstall(ctx, discordSharedApp);
  },

  // On the shared bot the agent's role goes.
  async disconnect(deps, row) {
    if (row.installationId !== undefined) await disconnectDiscordShared(deps, row);
  },
};

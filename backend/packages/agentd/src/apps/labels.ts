/**
 * One-off backfill of the human names the Apps page shows for chat installations (BACKEND 10.18): a Discord server's or Slack
 * workspace's name on its `channelInstallations` row (`label`), and the Feishu app's / Slack workspace's / Discord bot's name on an agent's own bot
 * (`channels.accountName`). New installs and connects store the name themselves; this asks each platform once, with the credential
 * the row already holds, for the rows that were made before. A call that fails leaves the row as it is (the page then says "Discord
 * server" instead of a raw id) and keeps the marker unwritten, so the next boot tries again; rows that already have a name are not asked.
 */
import type { ChannelInstallation, ChannelRow, Store } from 'juno-agent/contracts';
import { decryptSecret } from '@agent-desktop/contracts/secrets';
import { discordCall } from '@agent-desktop/channels/discord/api';
import { fetchFeishuBotInfo } from '@agent-desktop/channels/feishu/api';
import { getRow, newRow, putRow } from 'juno-agent/modules/home/mirror';
import { listAll } from 'juno-agent/modules/memory/util';

export const LABELS_MARKER = '__migrations/apps-labels-v1';

export interface LabelBackfill {
  skipped: boolean;
  named: number;
  failed: number;
}

const clean = (name: unknown): string | undefined => (typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 80) : undefined);

/** The workspace name Slack gives for a bot token (`auth.test`); undefined when the call or the token fails. */
async function slackTeamName(fetchFn: typeof fetch, token: string): Promise<string | undefined> {
  try {
    const response = await fetchFn('https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
    const payload: unknown = await response.json().catch(() => null);
    return typeof payload === 'object' && payload !== null && (payload as Record<string, unknown>)['ok'] === true ? clean((payload as Record<string, unknown>)['team']) : undefined;
  } catch {
    return undefined;
  }
}

async function installationName(fetchFn: typeof fetch, installation: ChannelInstallation): Promise<string | undefined> {
  const token = decryptSecret(installation.botToken);
  if (installation.kind === 'slack') return slackTeamName(fetchFn, token);
  if (installation.kind !== 'discord') return undefined;
  const guild = await discordCall(fetchFn, token, 'GET', '/guilds/' + installation.teamId);
  return guild.ok && typeof guild.body === 'object' && guild.body !== null ? clean((guild.body as Record<string, unknown>)['name']) : undefined;
}

async function ownBotName(fetchFn: typeof fetch, row: ChannelRow): Promise<string | undefined> {
  if (row.botToken === undefined) return undefined;
  const secret = decryptSecret(row.botToken);
  if (row.kind === 'slack') return slackTeamName(fetchFn, secret);
  if (row.kind === 'discord') {
    const me = await discordCall(fetchFn, secret, 'GET', '/users/@me');
    return me.ok && typeof me.body === 'object' && me.body !== null ? clean((me.body as Record<string, unknown>)['username']) : undefined;
  }
  if (row.kind !== 'feishu') return undefined;
  const bot = await fetchFeishuBotInfo(fetchFn, { appId: row.channelId, appSecret: secret, domain: row.domain ?? 'feishu' });
  return bot.ok ? clean(bot.data.name) : undefined;
}

export async function backfillLabels(store: Store, fetchFn: typeof fetch = fetch): Promise<LabelBackfill> {
  if ((await getRow(store, 'system', LABELS_MARKER)) !== null) return { skipped: true, named: 0, failed: 0 };
  let named = 0;
  let failed = 0;
  const attempt = async (find: () => Promise<string | undefined>, save: (name: string) => Promise<unknown>): Promise<void> => {
    let name: string | undefined;
    try {
      name = await find();
    } catch {
      name = undefined;
    }
    if (name === undefined) {
      failed += 1;
      return;
    }
    await save(name);
    named += 1;
  };
  for (const installation of await listAll(store, 'channelInstallations')) {
    if (installation.label !== undefined) continue;
    await attempt(() => installationName(fetchFn, installation), (label) => store.patch('channelInstallations', installation.id, { label }));
  }
  for (const row of await listAll(store, 'channels')) {
    if (row.installationId !== undefined || row.accountName !== undefined || !['slack', 'feishu', 'discord'].includes(row.kind) || row.status === 'pending_install' || row.botToken === undefined) continue;
    await attempt(() => ownBotName(fetchFn, row), (accountName) => store.patch('channels', row.id, { accountName }));
  }
  if (failed === 0) await putRow(store, newRow('system', LABELS_MARKER, '', 'platform', new Date().toISOString()));
  return { skipped: false, named, failed };
}

/**
 * One-time move to the shared Juno app on Slack and Discord (channel SDK C5). Those two platforms no longer connect a bot of an agent's
 * own (a Slack app made from a manifest or pasted token + signing secret, a Discord bot token): a row that was made that way is the one
 * that holds its own `botToken` (the shared app's rows point at an installation, which holds the token). Such a row is switched off with
 * the status the Apps page already shows as "reconnect" (`invalid_token`): its runner and ingress are gone, its credentials stay sealed
 * on the row until the owner removes it, and reconnecting goes through the shared app. Telegram and Feishu rows are never touched here.
 * A marker row makes later boots skip it.
 */
import type { Store } from 'juno-agent/contracts';
import { getRow, newRow, putRow } from 'juno-agent/modules/home/mirror';
import { listAll } from 'juno-agent/modules/memory/util';

export const MARKER = '__migrations/shared-app-only-v1';

/** The platforms that dropped per-agent bots: frozen at the time of this migration. */
const SHARED_APP_ONLY = new Set(['slack', 'discord']);

export async function migrateSelfBots(store: Store): Promise<{ skipped: boolean; disabled: number }> {
  if ((await getRow(store, 'system', MARKER)) !== null) return { skipped: true, disabled: 0 };
  let disabled = 0;
  for (const row of await listAll(store, 'channels')) {
    if (!SHARED_APP_ONLY.has(row.kind) || row.installationId !== undefined || row.botToken === undefined || row.status === 'invalid_token') continue;
    await store.put('channels', { ...row, status: 'invalid_token', updatedAt: new Date().toISOString() });
    disabled += 1;
  }
  await putRow(store, newRow('system', MARKER, '', 'platform', new Date().toISOString()));
  return { skipped: false, disabled };
}

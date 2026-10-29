/**
 * The names the Apps page shows for chat installations (BACKEND 10.18): never a raw platform id. The boot backfill asks each platform
 * once for rows made before the names were stored; a platform that cannot be asked leaves the row to the "<Platform> server" wording
 * and is tried again at the next boot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { encryptSecret } from '@agent-desktop/contracts/secrets';
import { clearFeishuTokenCache } from '@agent-desktop/channels/feishu/api';
import { createStoredCatalog } from 'juno-agent/modules/apps/catalog';
import { BUILTIN_CATALOG_ENTRIES } from 'juno-agent/modules/mcp/catalog';
import { testChannels } from '../../__tests__/test-app.js';
import { seedRows } from '../seed.js';
import { listApps } from '../view.js';
import { backfillLabels, LABELS_MARKER } from '../labels.js';
import { getRow } from 'juno-agent/modules/home/mirror';

const NOW = '2026-10-26T00:00:00.000Z';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Discord, Slack and Feishu as the three platforms answer; `down` makes every call fail. */
function platforms(options: { down?: boolean } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (options.down) throw new Error('unreachable');
    if (url.endsWith('/guilds/G1')) return json({ id: 'G1', name: 'Test server' });
    if (url.endsWith('/users/@me')) return json({ id: 'D5', username: 'junobot' });
    if (url.endsWith('/auth.test')) return json({ ok: true, team: 'Acme', team_id: 'T9' });
    if (url.endsWith('/tenant_access_token/internal')) return json({ code: 0, tenant_access_token: 't', expire: 7200 });
    if (url.endsWith('/bot/v3/info')) return json({ code: 0, bot: { open_id: 'ou_1', app_name: 'Juno Bot' } });
    return json({}, 404);
  }) as typeof fetch;
}

async function seeded() {
  const store = createMemoryStore();
  const base = { ownerId: 'o1', createdAt: NOW, updatedAt: NOW };
  await store.put('channelInstallations', { id: 'discord:G1', kind: 'discord', teamId: 'G1', botToken: encryptSecret('bot'), botUserId: 'B', ...base } as never);
  await store.put('channelInstallations', { id: 'slack:T1', kind: 'slack', teamId: 'T1', botToken: encryptSecret('xoxb'), botUserId: 'B', label: 'Already named', ...base } as never);
  await store.put('channels', { id: 'feishu:cli_1', agentId: 'a1', kind: 'feishu', channelId: 'cli_1', secretHashHex: 'x', botToken: encryptSecret('secret'), status: 'active', ...base } as never);
  await store.put('channels', { id: 'slack:s1', agentId: 'a1', kind: 'slack', channelId: 's1', secretHashHex: 'x', botToken: encryptSecret('xoxb-own'), teamId: 'T9', status: 'active', ...base } as never);
  await store.put('channels', { id: 'discord:D5', agentId: 'a1', kind: 'discord', channelId: 'D5', secretHashHex: 'x', botToken: encryptSecret('dbot'), status: 'active', ...base } as never);
  await store.put('channels', { id: 'telegram:my_bot', agentId: 'a1', kind: 'telegram', channelId: 'my_bot', secretHashHex: 'x', botToken: encryptSecret('tg'), status: 'active', ...base } as never);
  return store;
}

async function labelsOf(store: Awaited<ReturnType<typeof seeded>>): Promise<Record<string, string>> {
  const catalog = await createStoredCatalog({ store, seed: seedRows(BUILTIN_CATALOG_ENTRIES, ['slack', 'discord', 'telegram', 'feishu']) });
  const view = await listApps({ store, channels: testChannels, catalog }, 'o1');
  return Object.fromEntries(view.flatMap((app) => app.installations.map((installation) => [installation.id, installation.label] as const)));
}

beforeEach(() => {
  vi.stubEnv('SECRETS_KEY', Buffer.alloc(32, 7).toString('base64'));
  clearFeishuTokenCache();
});
afterEach(() => vi.unstubAllEnvs());

describe('backfillLabels', () => {
  it('names an installation and an own bot from the platform, leaves a named one alone, and runs once', async () => {
    const store = await seeded();
    expect(await backfillLabels(store, platforms())).toEqual({ skipped: false, named: 4, failed: 0 });
    expect(await labelsOf(store)).toEqual({
      'discord:D5': 'junobot',
      'discord:G1': 'Test server',
      'slack:T1': 'Already named',
      'feishu:cli_1': 'Juno Bot',
      'slack:s1': 'Acme',
      'telegram:my_bot': '@my_bot',
    });
    expect(await backfillLabels(store, platforms())).toEqual({ skipped: true, named: 0, failed: 0 });
  });

  it('a platform that cannot be asked leaves "<Platform> server" instead of the raw id, and the next boot tries again', async () => {
    const store = await seeded();
    expect(await backfillLabels(store, platforms({ down: true }))).toEqual({ skipped: false, named: 0, failed: 4 });
    expect(await getRow(store, 'system', LABELS_MARKER)).toBeNull();
    expect(await labelsOf(store)).toMatchObject({ 'discord:G1': 'Discord server', 'feishu:cli_1': 'Feishu bot', 'slack:s1': 'Slack bot' });
    expect(await backfillLabels(store, platforms())).toMatchObject({ skipped: false, named: 4, failed: 0 });
  });
});

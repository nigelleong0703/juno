/**
 * The move to the shared Juno app on Slack and Discord: a row made with the agent's own bot is switched off (the Apps page shows
 * "reconnect"); shared-app rows and every Telegram or Feishu row are left alone; a second run does nothing.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { migrateSelfBots } from '../self-bots.js';

const NOW = '2026-10-29T00:00:00.000Z';
const row = (id: string, kind: string, extra: object) => ({ id, ownerId: 'o1', agentId: 'a1', kind, channelId: id.split(':')[1], secretHashHex: 'x', status: 'active', createdAt: NOW, updatedAt: NOW, ...extra }) as never;

describe('migrateSelfBots', () => {
  it('switches off Slack and Discord rows holding their own bot token, and nothing else', async () => {
    const store = createMemoryStore();
    await store.put('channels', row('slack:sOwn', 'slack', { botToken: 'enc', signingSecret: 'enc' }));
    await store.put('channels', row('discord:555', 'discord', { botToken: 'enc' }));
    await store.put('channels', row('slack:T1.a1', 'slack', { installationId: 'slack:T1' }));
    // A Telegram managed bot and a Feishu app hold their own token too: they are not touched.
    await store.put('channels', row('telegram:JunoBot', 'telegram', { botToken: 'enc' }));
    await store.put('channels', row('feishu:cli_1', 'feishu', { botToken: 'enc' }));
    expect(await migrateSelfBots(store)).toEqual({ skipped: false, disabled: 2 });
    const status = async (id: string) => (await store.get('channels', id))?.status;
    expect([await status('slack:sOwn'), await status('discord:555')]).toEqual(['invalid_token', 'invalid_token']);
    expect([await status('slack:T1.a1'), await status('telegram:JunoBot'), await status('feishu:cli_1')]).toEqual(['active', 'active', 'active']);
    expect(await migrateSelfBots(store)).toEqual({ skipped: true, disabled: 0 });
  });
});

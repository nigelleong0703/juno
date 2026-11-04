/**
 * The owner's settings for a platform group (BACKEND 6.8): `GET` / `PUT /v1/conversations/:id/group`, for any conversation of the group
 * (a Slack thread, the channel itself). The settings live on the agent's channel row under the platform's chat id, so every thread of
 * the channel shares them. Only the owner reads or changes them.
 */
import { type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { channelRowId, type ChannelRow } from '@agent-desktop/contracts';
import { chatCapabilities, groupDelegableCategorySchema, updateGroupSettingsInputSchema, type Conversation, type GroupSettings } from '@agent-desktop/public-contracts';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { channelMetaOf } from './channels.js';
import { docOwnerId } from './relationships.js';

const notAGroup = { error: { code: 'NOT_A_GROUP', message: 'This conversation is not a platform group' } };

/** The settings of a chat as the clients read them. */
export function groupSettingsOf(row: ChannelRow, chatId: string, title: string | undefined): GroupSettings {
  const setting = row.groups?.[chatId];
  const delegated = (setting?.delegated ?? []).flatMap((category) => {
    const parsed = groupDelegableCategorySchema.safeParse(category);
    return parsed.success ? [parsed.data] : [];
  });
  return {
    platform: row.kind,
    ...(title === undefined ? {} : { title }),
    observes: chatCapabilities(row.kind, row.grantedScopes ?? []).hears === 'all',
    speak: setting?.speak === true,
    delegated,
    ...(setting?.backfill === undefined ? {} : { backfill: setting.backfill }),
  };
}

async function groupOf(deps: AgentdDeps, ownerId: string, conversationId: string): Promise<{ conv: Conversation; row: ChannelRow; chatId: string } | null> {
  const conv = await deps.store.get('conversations', conversationId);
  if (conv === null || docOwnerId(conv) !== ownerId || conv.kind !== 'room') return null;
  const meta = channelMetaOf(conv);
  if (meta === undefined) return null;
  const row = await deps.store.get('channels', channelRowId(meta.kind, meta.channelId));
  return row === null || docOwnerId(row) !== ownerId ? null : { conv, row, chatId: meta.chatId };
}

export function registerGroupSettings(app: Hono, deps: AgentdDeps): void {
  app.get('/v1/conversations/:id/group', async (c) => {
    const found = await groupOf(deps, getOwnerId(c), c.req.param('id'));
    return found === null ? c.json(notAGroup, 404) : c.json(groupSettingsOf(found.row, found.chatId, found.conv.title));
  });

  app.put('/v1/conversations/:id/group', zValidator('json', updateGroupSettingsInputSchema), async (c) => {
    const found = await groupOf(deps, getOwnerId(c), c.req.param('id'));
    if (found === null) return c.json(notAGroup, 404);
    const input = c.req.valid('json');
    const before = found.row.groups?.[found.chatId] ?? {};
    const next = {
      ...before,
      ...(input.speak === undefined ? {} : { speak: input.speak }),
      ...(input.delegated === undefined ? {} : { delegated: [...new Set(input.delegated)] }),
    };
    const row = await deps.store.patch('channels', found.row.id, { groups: { ...found.row.groups, [found.chatId]: next }, updatedAt: new Date().toISOString() });
    return c.json(groupSettingsOf(row, found.chatId, found.conv.title));
  });
}

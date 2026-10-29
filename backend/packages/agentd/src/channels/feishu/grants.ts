/**
 * The optional Feishu permissions a channel row was granted (`grantedScopes`): reading a group's messages (`im:message.group_msg`,
 * the tenant admin approves it) and reactions (`im:message.reactions:write_only`). The capability row widens only for what the row
 * lists (public-contracts `chatCapabilities`), so the row must follow what Feishu actually answers:
 *  - a call that succeeds records the scope it needed;
 *  - a call Feishu refuses for a missing scope takes it off again;
 *  - until the group read is granted, each admitted Feishu group message makes one cheap probe (`history`, one message), so an
 *    approval is noticed on the next group message without a timer. The probe is fire and forget and never fails a wake.
 */
import { channelRowId, type ChannelRow, type Store } from '@agent-desktop/contracts';
import { FEISHU_SCOPE_GROUP_MESSAGES } from '@agent-desktop/channels/feishu/abilities';
import { feishuPermissionDenied } from '@agent-desktop/channels/feishu/abilities';
import type { AdapterResult } from '@agent-desktop/channels/abilities';
import type { ChannelRegistry } from '../registry.js';
import { openChannelRow } from '../credentials.js';

export interface GrantDeps {
  store: Store;
  channels: ChannelRegistry;
  channelFetch?: typeof fetch;
}

/** Writes one scope in or out of the row's `grantedScopes`; a row that already says so is not written. */
export async function recordFeishuScope(store: Store, row: ChannelRow, scope: string, granted: boolean): Promise<void> {
  const current = row.grantedScopes ?? [];
  if (current.includes(scope) === granted) return;
  const next = granted ? [...current, scope] : current.filter((seen) => seen !== scope);
  await store.patch('channels', channelRowId(row.kind, row.channelId), { grantedScopes: next, updatedAt: new Date().toISOString() });
}

/** What a call that needed `scope` answered: success grants it, a refusal for a missing scope revokes it, anything else changes nothing. */
export async function recordFeishuOutcome(store: Store, row: ChannelRow, scope: string, result: { status: string; error?: string }): Promise<void> {
  if (result.status === 'ok') return recordFeishuScope(store, row, scope, true);
  if (result.status === 'failed' && feishuPermissionDenied(result.error)) return recordFeishuScope(store, row, scope, false);
}

/** While the group read is not granted: one history call on this chat (limit 1). Its answer is what the row records. */
export async function syncFeishuGroupGrant(deps: GrantDeps, row: ChannelRow, chat: { chatId: string; threadId: string }): Promise<void> {
  if ((row.grantedScopes ?? []).includes(FEISHU_SCOPE_GROUP_MESSAGES)) return;
  const adapter = deps.channels.get('feishu')?.adapter;
  if (adapter === undefined) return;
  const opened = await openChannelRow(deps.store, row);
  if ('error' in opened) return;
  const probe: AdapterResult<unknown> = await adapter.abilities.history(deps.channelFetch ?? fetch, adapter.identity.authOf(opened.channel), { chatId: chat.chatId, threadId: chat.threadId, limit: 1 });
  await recordFeishuOutcome(deps.store, row, FEISHU_SCOPE_GROUP_MESSAGES, probe);
}

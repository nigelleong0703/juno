/**
 * Feishu / Lark one-scan app creation (CH7): the SDK's `registerApp` device flow (RFC 8628).
 *
 * connect starts the flow and answers with the `verificationUrl` the owner opens (or scans) in Feishu
 * to approve a new app. While the owner decides, a background task holds the SDK's polling promise;
 * when it resolves with the new app's id and secret the real `feishu` row is written (secret sealed)
 * and the long-connection runner picks it up on its next rescan. When the SDK reports the approving
 * user's open_id the owner is bound on the spot, otherwise connect also returned a bind code to DM.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { createLogger } from '@agent-desktop/log';
import { channelRowId, type ChannelRow, type Store } from '@agent-desktop/contracts';
import { encryptSecret } from '@agent-desktop/contracts/secrets';
import { runWithOwner } from 'juno-agent/owner-context';
import type { ConnectContext, ConnectOutcome } from '../connect.js';
import { newSecret } from '../bind.js';
import { fetchFeishuBotInfo, lookupFeishuOpenIdByEmail } from '@agent-desktop/channels/feishu/api';
import { createPending, loadPending, settlePending } from '../pending.js';

const log = createLogger({ service: 'feishu-register' });

/** The SDK's `registerApp` type is declared with the other injected deps (routes/index.ts); re-exported for this platform's tests. */
import type { FeishuRegisterApp } from '../../routes/index.js';
export type { FeishuRegisterApp };

const bodySchema = z.object({ mode: z.literal('register'), domain: z.enum(['feishu', 'lark']).optional() });

/** Hosts of the SDK's accounts pages. */
const ACCOUNTS_HOST = { feishu: 'accounts.feishu.cn', lark: 'accounts.larksuite.com' } as const;

function scoped(store: Store, ownerId: string): Store {
  return typeof store.forOwner === 'function' ? store.forOwner(ownerId) : store;
}

async function finish(
  store: Store,
  pending: ChannelRow,
  result: Awaited<ReturnType<FeishuRegisterApp>>,
  fallbackDomain: 'feishu' | 'lark',
  fetchFn: typeof fetch,
  ownerEmail: string | undefined,
): Promise<void> {
  // A request the owner cancelled or that ran out of time creates nothing.
  const current = await loadPending(store, pending.channelId);
  const pendingData = current?.pending;
  if (pendingData === undefined || pendingData.state !== 'pending') return;
  const id = channelRowId('feishu', result.client_id);
  const existing = await store.get('channels', id);
  if (existing && existing.agentId !== pending.agentId) {
    await settlePending(store, pending.channelId, { state: 'failed', error: 'This app is already connected to another agent' });
    return;
  }
  const domain = result.user_info?.tenant_brand ?? fallbackDomain;
  const openId = result.user_info?.open_id
    ?? (ownerEmail === undefined ? undefined : await lookupFeishuOpenIdByEmail(fetchFn, { appId: result.client_id, appSecret: result.client_secret, domain }, ownerEmail));
  // The app's name shows on the Apps page; a Feishu that cannot be asked right now leaves it to the boot backfill's next try.
  const bot = await fetchFeishuBotInfo(fetchFn, { appId: result.client_id, appSecret: result.client_secret, domain });
  const now = new Date().toISOString();
  const row: ChannelRow = {
    id,
    ownerId: pending.ownerId,
    agentId: pending.agentId,
    kind: 'feishu',
    channelId: result.client_id,
    domain,
    ...(bot.ok && bot.data.name !== '' ? { accountName: bot.data.name } : {}),
    secretHashHex: newSecret().hashHex,
    botToken: encryptSecret(result.client_secret),
    ...(openId === undefined ? {} : { ownerExternalId: openId }),
    status: 'active',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  try {
    await store.put('channels', row);
  } catch {
    await settlePending(store, pending.channelId, { state: 'failed', error: 'This app is already connected to another agent' });
    return;
  }
  await settlePending(store, pending.channelId, { state: 'connected', resultRowId: id });
}

export async function connectFeishuRegister({ deps, ownerId, agentId, ownerEmail, body }: ConnectContext): Promise<ConnectOutcome> {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'domain must be feishu or lark' };
  const domain = parsed.data.domain ?? 'feishu';
  const register = deps.feishuRegisterApp ?? lark.registerApp;
  const controller = new AbortController();

  let ready!: (info: { url: string; expireIn: number }) => void;
  const qr = new Promise<{ url: string; expireIn: number }>((resolve) => { ready = resolve; });
  const flow = register({
    domain: ACCOUNTS_HOST[domain],
    source: 'juno',
    signal: controller.signal,
    onQRCodeReady: ready,
  });
  // Rejections after the link is out are handled below; before it, they decide the response.
  const early = flow.then(() => null, (err: unknown) => err);
  const first = await Promise.race([qr, early]);
  if (first === null || !('url' in (first as object))) {
    log.warn({ err: first }, 'feishu registerApp failed before the link was issued');
    controller.abort();
    return { ok: false, status: 502, code: 'FEISHU_UNREACHABLE', message: 'Feishu could not start the app registration' };
  }
  const info = first as { url: string; expireIn: number };
  const pending = await createPending(deps.store, {
    ownerId,
    agentId,
    ttlMs: info.expireIn * 1000,
    data: { platform: 'feishu', domain, verificationUrl: info.url },
  });
  void flow
    .then((result) => runWithOwner(ownerId, () => finish(scoped(deps.store, ownerId), pending, result, domain, deps.channelFetch ?? fetch, ownerEmail)))
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Feishu app registration failed';
      log.info({ pending: pending.channelId, message }, 'feishu registerApp ended without an app');
      await runWithOwner(ownerId, () => settlePending(scoped(deps.store, ownerId), pending.channelId, { state: 'failed', error: message })).catch(() => undefined);
    });
  return { ok: true, pending, verificationUrl: info.url };
}

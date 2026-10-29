// The ChatGPT subscription credential an owner's `openai` provider holds: a sealed OAuth token bundle.
// Read per call; refreshed when the access token is near expiry, with the rotated bundle written back.
// A refresh token is redeemed once (it rotates), and several workers may need the same owner's token, so the
// refresh runs inside a transaction that holds the provider row lock: the next process waits, then reads the bundle
// the first one stored instead of redeeming the old token again. A refused refresh marks the provider
// `reauth_required` and fails the run: the owner's key is never swapped for ours.
import { z } from 'zod';
import type { Store } from '../../contracts/index.js';
import type { ModelProviderRecord } from '../../contracts/model-providers.js';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { ModelSelectionError } from './model-selection-error.js';
import { openProviderKey, sealProviderKey } from './provider-secrets.js';

/** The token bundle as pi-ai's OAuth refresh reads and returns it (no secret beyond these fields is kept). */
export const chatGPTBundleSchema = z.object({
  type: z.literal('oauth'),
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number(),
  clientId: z.string().min(1),
  scopes: z.array(z.string()).optional(),
});
export type ChatGPTBundle = z.infer<typeof chatGPTBundleSchema>;

/** Refresh one bundle. Injected in tests; production is pi-ai's own ChatGPT refresh. */
export type ChatGPTRefresh = (bundle: ChatGPTBundle, signal: AbortSignal) => Promise<ChatGPTBundle>;

/** pi-ai's OpenAI refresh, reached through the public provider factory (its login is not used). */
export const pinnedChatGPTRefresh: ChatGPTRefresh = async (bundle, signal) => {
  const oauth = openaiProvider().auth.oauth;
  if (oauth === undefined) throw new Error('ChatGPT sign-in is not available in this build');
  return chatGPTBundleSchema.parse(await oauth.refresh(bundle, signal));
};

export const REAUTH_MESSAGE = 'Your ChatGPT sign-in has expired or was revoked. Sign in with ChatGPT again in Settings > Models.';

/** Seal a bundle for storage, with its non-secret expiry for display. */
export function sealChatGPTBundle(bundle: ChatGPTBundle): { apiKey: string; accessExpiresAt: string } {
  return { apiKey: sealProviderKey(JSON.stringify(bundle)), accessExpiresAt: new Date(bundle.expires).toISOString() };
}

/** Open and validate a stored bundle. A damaged row is an unreadable key, never a silent fallback. */
export function openChatGPTBundle(stored: string): ChatGPTBundle {
  let plain: unknown;
  try {
    plain = JSON.parse(openProviderKey(stored));
  } catch {
    throw new ModelSelectionError('provider-key-unreadable', 'The stored ChatGPT sign-in cannot be read; sign in with ChatGPT again');
  }
  const parsed = chatGPTBundleSchema.safeParse(plain);
  if (!parsed.success) throw new ModelSelectionError('provider-key-unreadable', 'The stored ChatGPT sign-in cannot be read; sign in with ChatGPT again');
  return parsed.data;
}

/** A refresh pi-ai reports as refused by OpenAI (bad or revoked refresh token), as opposed to a network fault. */
export function isRefreshRefused(error: unknown): boolean {
  return error instanceof Error && /token request failed \((400|401|403)\)|invalid_grant/.test(error.message);
}

/** The access token for a ChatGPT-backed provider row, refreshing it first when it is near expiry. */
export async function chatGPTAccessToken(input: {
  store: Store;
  ownerId: string;
  record: ModelProviderRecord;
  refresh: ChatGPTRefresh;
}): Promise<string> {
  const bundle = openChatGPTBundle(input.record.apiKey);
  if (bundle.expires > Date.now()) return bundle.access;
  return (await refreshAndStore(input)).access;
}

type Refreshed = { kind: 'bundle'; bundle: ChatGPTBundle } | { kind: 'refused' };

/**
 * Redeem the refresh token under the provider row lock. The bundle read here is the stored one, not the caller's
 * copy: when another process refreshed first, its bundle is still valid and is used without a second redeem.
 * A refusal is recorded inside the transaction and thrown after it commits (a throw would roll the mark back).
 */
async function refreshAndStore(input: { store: Store; ownerId: string; record: ModelProviderRecord; refresh: ChatGPTRefresh }): Promise<ChatGPTBundle> {
  const { store, ownerId, record, refresh } = input;
  const outcome = await store.tx(async (tx): Promise<Refreshed> => {
    if (tx.getForUpdate === undefined) throw new Error('the ChatGPT refresh needs a store with row locks (getForUpdate)');
    const locked = await tx.getForUpdate('modelProviders', record.id);
    if (locked === null || locked.ownerId !== ownerId) throw new ModelSelectionError('provider-key-unreadable', 'The ChatGPT provider is no longer available; add it again');
    const stored = openChatGPTBundle(locked.apiKey);
    if (stored.expires > Date.now()) return { kind: 'bundle', bundle: stored };
    let next: ChatGPTBundle;
    try {
      next = await refresh(stored, AbortSignal.timeout(20_000));
    } catch (error) {
      if (!isRefreshRefused(error)) throw error;
      await tx.patch('modelProviders', record.id, { status: 'reauth_required', updatedAt: new Date().toISOString() });
      return { kind: 'refused' };
    }
    await tx.patch('modelProviders', record.id, { ...sealChatGPTBundle(next), status: 'connected', updatedAt: new Date().toISOString() });
    return { kind: 'bundle', bundle: next };
  });
  if (outcome.kind === 'refused') throw new ModelSelectionError('reauth-required', REAUTH_MESSAGE);
  return outcome.bundle;
}

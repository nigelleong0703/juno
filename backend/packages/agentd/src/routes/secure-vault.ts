/**
 * `GET|PUT /v1/secure-vault/keys` (BACKEND 8.7): the free LABELS of what the owner keeps on their phone ("Visa ending 4242",
 * "Shopee password" ...). The values never reach the server: the phone prefills a secure-input form from its own vault,
 * then encrypts what the user confirms. The agent only learns which labels exist, so it can point a requested field at
 * the matching entry by `vaultId`. One row per owner, owner-scoped by the store.
 */
import { type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { secureVaultIdFor, secureVaultKeysSchema, type SecureVaultKeys } from '@agent-desktop/public-contracts';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';

export function registerSecureVault(app: Hono, deps: AgentdDeps): void {
  app.get('/v1/secure-vault/keys', async (c) => {
    const row = await deps.store.get('secureVault', secureVaultIdFor(getOwnerId(c)));
    const body: SecureVaultKeys = { entries: row?.entries ?? [] };
    return c.json(body);
  });

  app.put('/v1/secure-vault/keys', zValidator('json', secureVaultKeysSchema), async (c) => {
    const entries = [...new Map(c.req.valid('json').entries.map((entry) => [entry.id, entry])).values()];
    await deps.store.put('secureVault', { id: secureVaultIdFor(getOwnerId(c)), entries, updatedAt: new Date().toISOString() });
    const body: SecureVaultKeys = { entries };
    return c.json(body);
  });
}

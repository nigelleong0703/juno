/**
 * The owner's vault entry LABELS (BACKEND 8.7). The values stay on the phone; the server keeps only which entries exist
 * (`PUT /v1/secure-vault/keys`) so the model can point a secure-input field at one by `vaultId`.
 */
import { secureVaultIdFor, type SecureVaultEntry } from '@agent-desktop/public-contracts';
import type { Store } from '../../contracts/index.js';

/** The owner's vault entries; empty when none are stored or the row cannot be read. */
export async function readVaultEntries(store: Store, ownerId: string | undefined): Promise<SecureVaultEntry[]> {
  if (ownerId === undefined) return [];
  try {
    const row = await store.get('secureVault', secureVaultIdFor(ownerId));
    return row?.entries ?? [];
  } catch {
    return [];
  }
}

/** The compact block for the agent's context: labels and kinds only. Empty when there are none. */
export function vaultSection(entries: SecureVaultEntry[]): string {
  if (entries.length === 0) return '';
  return "## Your user's secure vault\nSecrets kept on the user's phone (you never see values). For a secret field that fits one, pass its vaultId in request_secure_input so the phone can prefill it:\n"
    + entries.map((entry) => `- ${entry.label} (${entry.kind}) vaultId ${entry.id}`).join('\n');
}

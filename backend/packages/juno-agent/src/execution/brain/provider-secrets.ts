// Seal and open an owner's provider secrets, and read an owner's provider document. Shared by the
// provider call path, the ChatGPT credential refresh and the login flow, so none of them imports another.
import type { ModelProviderRecord } from '../../contracts/model-providers.js';
import type { Store } from '../../contracts/index.js';
import { decryptSecret, encryptSecret, SecretsError } from '../../contracts/secrets.js';

const SEALED_PREFIX = 'enc:v1:';

/** Seal a provider API key for storage (AES-256-GCM, SECRETS_KEY). The only write path for keys. */
export function sealProviderKey(plain: string): string {
  return encryptSecret(plain);
}

/** Open a stored provider key. Refuses anything that is not sealed: a plaintext key is never sent. */
export function openProviderKey(stored: string): string {
  if (!stored.startsWith(SEALED_PREFIX)) throw new SecretsError('stored provider key is not sealed');
  return decryptSecret(stored);
}

/** The owner's provider document, or undefined when missing or owned by someone else. */
export async function readOwnedProvider(store: Store, ownerId: string, id: string): Promise<ModelProviderRecord | undefined> {
  const doc = await store.get('modelProviders', id);
  if (doc === null || doc.ownerId !== ownerId) return undefined;
  return doc;
}

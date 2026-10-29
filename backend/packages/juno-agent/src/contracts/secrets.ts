// Secrets at rest (H-50): AES-256-GCM with one key from SECRETS_KEY (32 bytes, base64).
// A stored secret is "enc:v1:" + base64url(iv | tag | ciphertext). Anything without that prefix is a
// legacy plaintext value and is returned as-is, so rows written before encryption keep working and
// are encrypted the next time they are written. There is no rotation and no KMS by design.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const SECRETS_KEY_ENV = 'SECRETS_KEY';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The key is missing or invalid, or a stored value is damaged. Never carries a secret value. */
export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsError';
  }
}

/** The configured key, read lazily so callers that never touch a secret do not need it. */
export function readSecretsKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env[SECRETS_KEY_ENV] ?? '';
  if (raw === '') {
    throw new SecretsError(SECRETS_KEY_ENV + ' is required: secrets are encrypted at rest and there is no built-in key');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) {
    throw new SecretsError(SECRETS_KEY_ENV + ' must be 32 random bytes encoded as base64 (openssl rand -base64 32)');
  }
  return key;
}

/** Boot-time check used by services that store or read secrets: refuse to start without a valid key. */
export function requireSecretsKey(env: Record<string, string | undefined> = process.env): void {
  readSecretsKey(env);
}

export function encryptSecret(plain: string, key: Buffer = readSecretsKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** Decrypts an `enc:v1:` value; any other value is legacy plaintext and is returned unchanged. */
export function decryptSecret(stored: string, key?: Buffer): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const bytes = Buffer.from(stored.slice(PREFIX.length), 'base64url');
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new SecretsError('stored secret is damaged');
  const decipher = createDecipheriv('aes-256-gcm', key ?? readSecretsKey(), bytes.subarray(0, IV_BYTES));
  decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretsError('stored secret failed authentication: tampered, or encrypted with a different ' + SECRETS_KEY_ENV);
  }
}

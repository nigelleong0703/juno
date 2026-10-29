// Owner-scoped model providers (per-user API keys). One document per provider. The API key is the only
// secret and is stored sealed (`enc:v1:`, see contracts/secrets.ts); it is never copied into a public
// response, a journal entry, a log line or a run snapshot. `toPublicModelProvider` is the only mapping
// that leaves this module, so a field added later cannot leak by accident.
import type { ModelProvider, ModelWire } from '@agent-desktop/public-contracts';

export interface ModelProviderRecord {
  id: string;
  ownerId: string;
  kind: 'builtin' | 'custom' | 'systemone';
  name: string;
  /** Built-in catalog id (pi-ai provider id) for kind `builtin`. */
  providerId?: string;
  /** Custom endpoint for kind `custom`; SSRF-checked on save and again on every call. */
  baseUrl?: string;
  wire?: ModelWire;
  /** Kind `systemone`: the model ids the endpoint offers (`baseUrl` is its root; SSRF-checked like a custom endpoint). */
  models?: string[];
  /**
   * Sealed secret (`enc:v1:...`): the API key for `auth: apiKey`, or the sealed OAuth token bundle for
   * `auth: chatgpt`. Empty only for a row whose secret was never stored.
   */
  apiKey: string;
  /** Absent means an API key. */
  auth?: 'apiKey' | 'chatgpt';
  /** `reauth_required` once a ChatGPT refresh was refused; the owner must sign in again. */
  status?: 'connected' | 'reauth_required';
  /** ChatGPT only: when the access token expires (not secret). */
  accessExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** A pending ChatGPT sign-in: one-time, expiring. The PKCE verifier is sealed and the state is only hashed. */
export interface ModelProviderLogin {
  id: string;
  ownerId: string;
  /** Sealed PKCE code verifier (`enc:v1:...`). */
  verifier: string;
  /** sha256 of the OAuth state sent to the browser. */
  stateHash: string;
  createdAt: string;
  expiresAt: string;
  /** Set on the first attempt; a consumed login can never be completed again. */
  consumedAt?: string;
  /** Reauthorization only: the client id OpenAI issued at registration; the callback must carry it or none. */
  clientId?: string;
  /** How the attempt ended (set once it has): the provider row it stored, the error the owner sees, or the reauthorization it handed over to. */
  outcome?: { status: 'connected'; providerId: string } | { status: 'failed'; code: string; message: string } | { status: 'reauthorize'; nextLoginId: string };
}

export function toPublicModelProvider(record: ModelProviderRecord): ModelProvider {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    hasKey: record.apiKey.length > 0,
    ...(record.auth === undefined ? {} : { auth: record.auth }),
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.accessExpiresAt === undefined ? {} : { accessExpiresAt: record.accessExpiresAt }),
    ...(record.providerId === undefined ? {} : { providerId: record.providerId }),
    ...(record.baseUrl === undefined ? {} : { baseUrl: record.baseUrl }),
    ...(record.wire === undefined ? {} : { wire: record.wire }),
    ...(record.models === undefined ? {} : { models: record.models }),
  };
}

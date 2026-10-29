/**
 * What the api and agentd see in their environment when they run inside an embedded Juno. The backend reads its
 * settings from process.env, so the embedded runtime sets them there (and restores them on stop). This module decides
 * the values: the runtime's own (database, ports, auth URLs, internal tokens) and the caller's (`env`, e.g. the model).
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';

/** Ports of the dev stack, the live e2e stack and the agents. The embedded runtime never picks one of these. */
export const RESERVED_PORTS: readonly number[] = [5199, 8787, 8788, 8791, 8792, 8795, 9080, 54329, 54330];

/** Set by the runtime. A caller's `env` may not set these: a second database, a fixed port or a known secret would break the isolation. */
const MANAGED_KEYS: ReadonlySet<string> = new Set([
  'DATABASE_URL', 'API_HOST', 'API_PORT', 'AGENTD_PORT', 'AGENTD_URL', 'AUTH_MODE', 'AUTH_TRUSTED_ORIGINS', 'BETTER_AUTH_URL',
  'BETTER_AUTH_SECRET', 'INTERNAL_AGENTD_TOKEN', 'SECRETS_KEY', 'ARTIFACT_URL_SECRET', 'SPACE_URL_SECRET', 'ARTIFACT_HOST',
  'SPACE_DOMAIN', 'BLOB_DIR', 'MEDIA_CACHE_DIR', 'SITE_ICON_CACHE_DIR',
]);

/** Dropped from the inherited environment unless `env` sets them: a developer's shell or .env must not switch a computer on. */
const OPT_IN_KEYS: readonly string[] = ['COMPUTERD_URL', 'COMPUTERD_TOKEN', 'COMPUTER_PROVIDER', 'SCREEN_TICKET_SECRET'];

/** Empty unless `env` sets them: the memory search must not call a hosted embeddings API that a shell happens to configure. */
const EMPTY_UNLESS_SET: readonly string[] = ['EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'EMBEDDING_MODEL'];

export interface EmbeddedSecrets {
  internalToken: string;
  authSecret: string;
  secretsKey: string;
  screenTicketSecret: string;
  artifactUrlSecret: string;
  spaceUrlSecret: string;
  computerdToken: string;
}

/** Fresh secrets for one run: they only ever protect this run's throwaway database. */
export function generateSecrets(): EmbeddedSecrets {
  const hex = (): string => randomBytes(32).toString('hex');
  return {
    internalToken: hex(),
    authSecret: hex(),
    // requireSecretsKey wants a base64 encoding of 32 bytes.
    secretsKey: randomBytes(32).toString('base64'),
    screenTicketSecret: hex(),
    artifactUrlSecret: hex(),
    spaceUrlSecret: hex(),
    computerdToken: hex(),
  };
}

export interface EmbeddedEnvInput {
  /** The process environment the backend would otherwise inherit. */
  inherited: NodeJS.ProcessEnv;
  /** The caller's `env` option. */
  caller: Readonly<Record<string, string>>;
  databaseUrl: string;
  apiPort: number;
  agentdPort: number;
  /** Root of the file store (blobs and caches). */
  dataDir: string;
  secrets: EmbeddedSecrets;
}

/**
 * The full environment for the api and agentd. Throws when the caller sets a managed key. Opt-in keys (a computer)
 * are off unless the caller gives them. Everything else inherited (the model provider, for one) is kept.
 */
export function buildEmbeddedEnv(input: EmbeddedEnvInput): Record<string, string> {
  for (const key of Object.keys(input.caller)) {
    if (MANAGED_KEYS.has(key)) throw new Error(`env.${key} is set by the embedded runtime; remove it from env`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.inherited)) {
    if (value !== undefined && !OPT_IN_KEYS.includes(key) && !EMPTY_UNLESS_SET.includes(key)) env[key] = value;
  }
  for (const key of EMPTY_UNLESS_SET) env[key] = '';
  Object.assign(env, input.caller);
  const apiUrl = `http://127.0.0.1:${String(input.apiPort)}`;
  Object.assign(env, {
    DATABASE_URL: input.databaseUrl,
    API_HOST: '127.0.0.1',
    API_PORT: String(input.apiPort),
    AGENTD_PORT: String(input.agentdPort),
    AGENTD_URL: `http://127.0.0.1:${String(input.agentdPort)}`,
    AUTH_MODE: 'account',
    AUTH_TRUSTED_ORIGINS: apiUrl,
    BETTER_AUTH_URL: apiUrl,
    BETTER_AUTH_SECRET: input.secrets.authSecret,
    INTERNAL_AGENTD_TOKEN: input.secrets.internalToken,
    SECRETS_KEY: input.secrets.secretsKey,
    ARTIFACT_URL_SECRET: input.secrets.artifactUrlSecret,
    SPACE_URL_SECRET: input.secrets.spaceUrlSecret,
    ARTIFACT_HOST: `usercontent.localhost:${String(input.apiPort)}`,
    SPACE_DOMAIN: `spaces.localhost:${String(input.apiPort)}`,
    BLOB_DIR: join(input.dataDir, 'blobs'),
    MEDIA_CACHE_DIR: join(input.dataDir, 'media'),
    SITE_ICON_CACHE_DIR: join(input.dataDir, 'site-icons'),
  });
  // Opt-in values: the caller's if given, else a fresh secret (agentd and the api need one to boot, whether or not a computer exists).
  env['COMPUTERD_TOKEN'] ??= input.secrets.computerdToken;
  env['SCREEN_TICKET_SECRET'] ??= input.secrets.screenTicketSecret;
  return env;
}

/** Set `env` as the process environment for the backend, dropping the opt-in keys it does not carry. Returns the restore. */
export function applyEnv(env: Readonly<Record<string, string>>): () => void {
  const keys = new Set([...Object.keys(env), ...OPT_IN_KEYS]);
  const before = new Map<string, string | undefined>();
  for (const key of keys) before.set(key, process.env[key]);
  for (const key of OPT_IN_KEYS) {
    if (!(key in env)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  return () => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) done(address.port);
        else fail(new Error('no port'));
      });
    });
  });
}

/** `count` distinct free ports on 127.0.0.1, none of them a reserved port. */
export async function pickFreePorts(count: number): Promise<number[]> {
  const picked: number[] = [];
  while (picked.length < count) {
    const port = await freePort();
    if (!RESERVED_PORTS.includes(port) && !picked.includes(port)) picked.push(port);
  }
  return picked;
}

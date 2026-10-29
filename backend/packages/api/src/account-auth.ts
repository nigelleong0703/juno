/**
 * Account authentication via Better Auth (email/password, durable Postgres sessions).
 *
 * Token mode stays the default so existing single-user setups keep working. Account mode
 * activates only with explicit, valid config (secret + base URL + Postgres) and resolves the
 * request owner from the Better Auth session instead of a shared bearer token.
 * The stable auth user ID becomes the domain ownerId; email is never an ownership key and
 * automatic account linking stays disabled until an explicit verified linking flow exists.
 * Google/OAuth providers are not configured, so their endpoints stay disabled.
 */
import { betterAuth } from 'better-auth';
import { bearer, deviceAuthorization } from 'better-auth/plugins';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { EventBus, Store } from '@agent-desktop/contracts';
import type { AuthResolver } from './auth.js';

/** Table prefix keeps auth tables clear of the existing domain collections. */
export const AUTH_TABLE_PREFIX = 'auth_';

/** Native clients allowed to pair through the device flow (the watch shows a code, the signed-in phone approves it). */
export const DEVICE_CLIENT_IDS = ['juno-watch'] as const;

/** The only credential provider account mode offers; OAuth lands separately. */
export const ACCOUNT_PROVIDERS = ['credential'] as const;

/**
 * Origins allowed to use cookie sessions. Matches the agentd CORS list: local web dev plus
 * the desktop shell. Origin validation itself stays enabled in Better Auth.
 */
export const TRUSTED_APP_ORIGINS = [
  'http://localhost:5199',
  'http://127.0.0.1:5199',
  // The desktop dev server runs on its own port (JUNO_DESKTOP_PORT) so the web dev server can keep 5199.
  ...(process.env.JUNO_DESKTOP_PORT === undefined ? [] : [`http://localhost:${process.env.JUNO_DESKTOP_PORT}`]),
  'electron://app',
];

const accountEnvSchema = z.object({
  AUTH_MODE: z.enum(['token', 'account']).default('token'),
  BETTER_AUTH_SECRET: z.string().default(''),
  BETTER_AUTH_URL: z.string().default(''),
  AUTH_TRUSTED_ORIGINS: z.string().default(''),
});

export interface TokenMode {
  mode: 'token';
}

export interface AccountModeConfig {
  mode: 'account';
  secret: string;
  baseURL: string;
  databaseUrl: string;
  trustedOrigins: string[];
}

/** Extra exact app origins from AUTH_TRUSTED_ORIGINS (comma-separated). Only valid http(s) origins, no wildcards. */
export function parseExtraTrustedOrigins(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes('*')) continue;
    let origin: string;
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      origin = url.origin;
    } catch {
      continue;
    }
    if (origin.includes('*')) continue;
    if (seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

/**
 * Decide the auth mode from agentd-local env (the shared config schema lives in agentd,
 * so account fields are parsed here instead). Throws in account mode when any required
 * value is missing or malformed, so misconfiguration fails fast instead of half-enabling.
 */
export function resolveAuthMode(
  env: Record<string, string | undefined> = process.env,
  databaseUrl: string,
): TokenMode | AccountModeConfig {
  const parsed = accountEnvSchema.parse(env);
  if (parsed.AUTH_MODE !== 'account') return { mode: 'token' };
  if (parsed.BETTER_AUTH_SECRET.length < 32) {
    throw new Error(
      'AUTH_MODE=account needs BETTER_AUTH_SECRET of at least 32 characters (generate with: openssl rand -base64 32)',
    );
  }
  if (!parsed.BETTER_AUTH_URL) {
    throw new Error('AUTH_MODE=account needs BETTER_AUTH_URL (public base URL of agentd)');
  }
  let baseURL: string;
  try {
    baseURL = new URL(parsed.BETTER_AUTH_URL).toString().replace(/\/$/, '');
  } catch {
    throw new Error('AUTH_MODE=account needs BETTER_AUTH_URL to be a valid URL');
  }
  if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error('AUTH_MODE=account needs DATABASE_URL pointing at Postgres');
  }
  return {
    mode: 'account',
    secret: parsed.BETTER_AUTH_SECRET,
    baseURL,
    databaseUrl,
    trustedOrigins: parseExtraTrustedOrigins(parsed.AUTH_TRUSTED_ORIGINS),
  };
}

export interface AccountAuthInput {
  secret: string;
  baseURL: string;
  trustedOrigins?: string[];
  /** Called once when an account is created (awaited, so the new account's default agent exists when sign-up returns; a failure is the caller's to log). */
  onUserCreated?: (ownerId: string, name: string) => Promise<void>;
}

/**
 * The exact Better Auth options this service runs with. Kept free of the database pool so
 * the migration generator can derive the Postgres schema from this same object.
 */
export function buildAccountAuthOptions(input: AccountAuthInput) {
  const extra = Array.isArray(input.trustedOrigins) ? parseExtraTrustedOrigins(input.trustedOrigins.join(',')) : [];
  const trustedOrigins = [...TRUSTED_APP_ORIGINS];
  for (const origin of extra) {
    if (!trustedOrigins.includes(origin)) trustedOrigins.push(origin);
  }
  return {
    baseURL: input.baseURL,
    basePath: '/auth',
    secret: input.secret,
    emailAndPassword: {
      enabled: true,
      // No delivery/verification flow yet, so email ownership is unverified (see AUTH.md).
      requireEmailVerification: false,
      autoSignIn: true,
    },
    account: {
      modelName: `${AUTH_TABLE_PREFIX}account`,
      // No automatic merges by email; linking needs an explicit verified flow.
      accountLinking: { enabled: false },
    },
    user: { modelName: `${AUTH_TABLE_PREFIX}user` },
    databaseHooks: {
      user: { create: { after: async (user: { id: string; name?: string }) => { await input.onUserCreated?.(user.id, user.name ?? ''); } } },
    },
    session: { modelName: `${AUTH_TABLE_PREFIX}session` },
    verification: { modelName: `${AUTH_TABLE_PREFIX}verification` },
    // Lets the Electron shell send the session as an Authorization bearer token.
    plugins: [
      bearer(),
      deviceAuthorization({
        validateClient: (clientId) => (DEVICE_CLIENT_IDS as readonly string[]).includes(clientId),
        expiresIn: '10m',
        interval: '5s',
        userCodeLength: 8,
        schema: { deviceCode: { modelName: `${AUTH_TABLE_PREFIX}deviceCode` } },
      }),
    ],
    trustedOrigins,
  };
}

/** Build the live Better Auth instance on a Postgres pool. Creates no tables; migrations apply separately. */
export function createAccountAuth(input: AccountAuthInput & { database: Pool }) {
  return betterAuth({
    ...buildAccountAuthOptions(input),
    database: input.database,
  });
}

/** Minimal session surface the resolver needs (keeps the full Auth type out of the seam). */
export interface SessionReader {
  api: {
    getSession(input: {
      headers: Headers;
    }): Promise<{ user: { id: string; email?: string | null } } | null>;
  };
}

/** Resolve the request owner from the Better Auth session (cookie or bearer token). */
export function createAccountResolver(auth: SessionReader): AuthResolver {
  return {
    mode: 'account',
    providers: [...ACCOUNT_PROVIDERS],
    resolve: async (req: Request) => {
      const session = await auth.api.getSession({ headers: req.headers });
      const userId = session?.user?.id;
      if (!userId) return null;
      const email = session?.user?.email;
      return email ? { ownerId: userId, email } : { ownerId: userId };
    },
  };
}

export interface AuthInfo {
  mode: 'token' | 'account';
  providers: string[];
}

export function tokenAuthInfo(): AuthInfo {
  return { mode: 'token', providers: [] };
}

export function accountAuthInfo(): AuthInfo {
  return { mode: 'account', providers: [...ACCOUNT_PROVIDERS] };
}

/**
 * Account mode is only meaningful with owner-scoped stores. Refuse to enable it on raw
 * stores instead of silently serving cross-owner data; the scoped implementations land
 * separately from this auth slice.
 */
export function requireAccountStores(store: Store, bus: EventBus): void {
  if (typeof store.forOwner !== 'function' || typeof bus.forOwner !== 'function') {
    throw new Error(
      'AUTH_MODE=account requires Store.forOwner and EventBus.forOwner; refusing account mode on unscoped stores',
    );
  }
}

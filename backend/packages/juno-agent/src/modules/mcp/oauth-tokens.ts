// Runtime token source for an OAuth-authorized MCP connection: each request asks for a Bearer header,
// the access token is refreshed shortly before it expires, and refreshes for one connection are serialized
// by the connection row lock, across processes (providers that rotate refresh tokens would otherwise invalidate
// the loser): the next process reads the tokens the first one stored instead of redeeming the old refresh token.
// A refresh the server rejects ends the session as an error the user fixes by reconnecting.
import type { Store } from '../../contracts/index.js';
import { McpConnectionError } from './client.js';
import { clientOf, McpOAuthError, openOAuth, refreshTokens, serverOf, sealOAuth, type OAuthRecord } from './oauth.js';
import { guardedFetch } from '../tools/net/guardedFetch.js';
import { loadConnection } from './manager-support.js';

const REFRESH_MARGIN_MS = 60_000;

/** The stored authorization can no longer be used: the user must connect again. */
export class McpReauthorizationError extends McpConnectionError {
  constructor(message: string) {
    super(message);
    this.name = 'McpReauthorizationError';
  }
}

export interface OAuthAuthorizerInput {
  store: Store;
  ownerId: string;
  connectionId: string;
  fetchImpl?: typeof fetch;
}

/** Yields the `Authorization` header value for one request; refreshes first when the token is near expiry. */
export function createOAuthAuthorizer(input: OAuthAuthorizerInput): () => Promise<string> {
  return async () => 'Bearer ' + (await currentAccessToken(input));
}

function expiring(record: OAuthRecord): boolean {
  return record.expiresAt !== undefined && Date.parse(record.expiresAt) - REFRESH_MARGIN_MS <= Date.now();
}

async function loadRecord(store: Store, input: OAuthAuthorizerInput): Promise<OAuthRecord> {
  const doc = await loadConnection(store, input.ownerId, input.connectionId);
  if (doc === null) throw new McpConnectionError('MCP connection ' + JSON.stringify(input.connectionId) + ' is not available');
  const record = openOAuth(Reflect.get(doc, 'auth'));
  if (record === undefined) throw new McpReauthorizationError('MCP connection ' + JSON.stringify(input.connectionId) + ' is not authorized; connect it again');
  return record;
}

async function currentAccessToken(input: OAuthAuthorizerInput): Promise<string> {
  const record = await loadRecord(input.store, input);
  if (record.accessToken !== undefined && !expiring(record)) return record.accessToken;
  return input.store.tx(async (tx) => {
    if (tx.getForUpdate === undefined) throw new Error('the MCP token refresh needs a store with row locks (getForUpdate)');
    await tx.getForUpdate('connections', input.connectionId);
    return refresh(tx, input);
  });
}

/** Runs holding the connection row lock. */
async function refresh(store: Store, input: OAuthAuthorizerInput): Promise<string> {
  // Re-read under the lock: a refresh that finished a moment ago (any process) may already have fixed the token.
  const record = await loadRecord(store, input);
  if (record.accessToken !== undefined && !expiring(record)) return record.accessToken;
  if (record.refreshToken === undefined) {
    throw new McpReauthorizationError('MCP connection ' + JSON.stringify(input.connectionId) + ' has no refresh token; connect it again');
  }
  let tokens;
  try {
    tokens = await refreshTokens({
      server: serverOf(record),
      client: clientOf(record),
      refreshToken: record.refreshToken,
      resource: record.resource,
      fetchImpl: input.fetchImpl ?? guardedFetch,
    });
  } catch (error) {
    if (error instanceof McpOAuthError) {
      const reason = error.code === 'MCP_OAUTH_INVALID_GRANT' ? 'was revoked' : 'could not be refreshed';
      throw new McpReauthorizationError('MCP authorization ' + reason + '; connect it again');
    }
    throw error;
  }
  // The old expiry is dropped: a response without expires_in must not leave a stale expiry behind.
  const { expiresAt: _previousExpiry, ...kept } = record;
  const scope = tokens.scope ?? record.scope;
  const next: OAuthRecord = {
    ...kept,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? record.refreshToken,
    ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
    ...(scope === undefined ? {} : { scope }),
  };
  await store.patch('connections', input.connectionId, { auth: sealOAuth(next) } as never);
  return tokens.accessToken;
}

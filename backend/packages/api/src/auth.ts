/**
 * Local auth seam for the public gateway.
 *
 * Type only: the gateway authenticates with account sessions (see account-auth.ts and
 * server.ts). There is no token middleware here on purpose; the private agentd trusts only
 * the service bearer plus the authoritative owner this gateway states upstream.
 */

/** Validated request identity from the account session. */
export interface AuthResolver {
  mode: 'token' | 'account';
  providers: string[];
  resolve(req: Request): Promise<{ ownerId: string; email?: string } | null>;
}

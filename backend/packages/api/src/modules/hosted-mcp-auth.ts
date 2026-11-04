/**
 * Who may call the MCP servers this gateway hosts (modules/google-mcp.ts). They are internal:
 * only our own backend (agentd's MCP client) calls them, with the service credential HOSTED_MCP_TOKEN in `Authorization`.
 * The owner's Google / Microsoft token travels in its own header (UPSTREAM_AUTHORIZATION_HEADER), so the tokens of two
 * audiences never share a header and a hosted server is never an open proxy for whatever bearer a caller brings. This
 * follows the MCP authorization spec: a server must not pass through the token it received from the client, and must not
 * accept or transit tokens meant for another resource (https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).
 *
 * Web APIs only (fetch Request/Response, Web Crypto), so these handlers can move to a Worker unchanged.
 */
import { UPSTREAM_AUTHORIZATION_HEADER } from '@agent-desktop/contracts/mcp';

export { UPSTREAM_AUTHORIZATION_HEADER };

const digest = async (text: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

/** True when the request carries `Authorization: Bearer <token>`. Compares fixed-size digests, so timing says nothing about the token. Without a configured token nobody passes. */
export async function isHostedCaller(token: string | undefined, request: Request): Promise<boolean> {
  if (token === undefined || token === '') return false;
  const [expected, given] = await Promise.all([digest(`Bearer ${token}`), digest(request.headers.get('authorization') ?? '')]);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= (expected[index] ?? 0) ^ (given[index] ?? 0);
  return difference === 0;
}

/** Every refusal of a caller without the service credential: 401, no body, no challenge, nothing that says what is served here. */
export const callerRefused = (): Response => new Response(null, { status: 401 });

/** The owner's upstream token as sent (`Bearer ...`), or '' when absent. */
export const upstreamAuthorizationOf = (request: Request): string => request.headers.get(UPSTREAM_AUTHORIZATION_HEADER) ?? '';

// MCP authorization (spec 2025-11-25) in our client: the 401 challenge's parameters, protected resource metadata (RFC 9728) and authorization
// server metadata (RFC 8414 / OIDC), the order a client is chosen in (provided, CIMD, DCR, refuse), PKCE S256, and the 403 step-up error.
import { describe, expect, it } from 'vitest';
import { clientMetadataDocument, chooseClient, configuredClientFor, createPkce, discoverAuthorizationServer, McpOAuthError, probeMcpServer, type AuthorizationServer } from '../oauth.js';
import { McpAuthError } from '../protocol.js';
import { mergeScopes, parseChallenge } from '../challenge.js';
import { HttpMcpTransport } from '../http-transport.js';

const MCP = 'https://mcp.example.com/api/mcp';
const ISSUER = 'https://auth.example.com';

function metadataFetch(options: { prm?: object; as?: object; challenge?: string; status?: number }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url === MCP) return new Response(null, { status: options.status ?? 401, headers: options.challenge === undefined ? {} : { 'www-authenticate': options.challenge } });
    if (url.includes('/.well-known/oauth-protected-resource')) return options.prm === undefined ? new Response(null, { status: 404 }) : Response.json(options.prm);
    if (url.includes('/.well-known/oauth-authorization-server')) return options.as === undefined ? new Response(null, { status: 404 }) : Response.json(options.as);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}
const prm = { resource: MCP, authorization_servers: [ISSUER], scopes_supported: ['read', 'write'] };
const as = { issuer: ISSUER, authorization_endpoint: ISSUER + '/authorize', token_endpoint: ISSUER + '/token', code_challenge_methods_supported: ['S256'] };

describe('the 401 challenge', () => {
  it('names the metadata URL, the scope and the error, quoted or bare', () => {
    expect(parseChallenge('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp", scope="files:read files:write"')).toEqual({
      resourceMetadata: 'https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp', scope: 'files:read files:write',
    });
    expect(parseChallenge('Bearer error="insufficient_scope", scope="admin"')).toEqual({ error: 'insufficient_scope', scope: 'admin' });
    expect(parseChallenge('Bearer error=invalid_token')).toEqual({ error: 'invalid_token' });
    expect(parseChallenge('Basic realm="x"')).toEqual({});
    expect(parseChallenge(null)).toEqual({});
  });

  it('merges scope lists without repeats', () => {
    expect(mergeScopes('a b', ['b', 'c'], undefined, 'c d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('the probe returns the metadata URL and the scope the server asked for', async () => {
    const probe = await probeMcpServer(MCP, metadataFetch({ challenge: 'Bearer resource_metadata="https://mcp.example.com/prm", scope="read"' }));
    expect(probe).toEqual({ open: false, resourceMetadataUrl: 'https://mcp.example.com/prm', challengeScope: 'read' });
    expect(await probeMcpServer(MCP, metadataFetch({ status: 200 }))).toEqual({ open: true });
  });
});

describe('discovery', () => {
  it('finds the authorization server through the protected resource metadata, and keeps its scopes_supported and CIMD support', async () => {
    const server = await discoverAuthorizationServer(MCP, undefined, metadataFetch({ prm, as: { ...as, client_id_metadata_document_supported: true, registration_endpoint: ISSUER + '/register' } }));
    expect(server).toMatchObject({ issuer: ISSUER, registrationEndpoint: ISSUER + '/register', clientIdMetadataDocumentSupported: true, scopesSupported: ['read', 'write'] });
  });

  it('refuses a server whose metadata does not advertise PKCE S256', async () => {
    const noPkce = { ...as, code_challenge_methods_supported: undefined };
    await expect(discoverAuthorizationServer(MCP, undefined, metadataFetch({ prm, as: noPkce }))).rejects.toThrow(/PKCE S256/);
    await expect(discoverAuthorizationServer(MCP, undefined, metadataFetch({ prm, as: { ...as, code_challenge_methods_supported: ['plain'] } }))).rejects.toThrow(/PKCE S256/);
  });

  it('the PKCE challenge is the S256 of the verifier', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).not.toBe(verifier);
  });
});

describe('choosing the client: provided, then CIMD, then DCR, otherwise a clear refusal', () => {
  const server = (extra: Partial<AuthorizationServer> = {}): AuthorizationServer => ({ issuer: ISSUER, authorizationEndpoint: ISSUER + '/a', tokenEndpoint: ISSUER + '/t', ...extra });
  const provided = { clientId: 'ours' };
  const cimdUrl = 'https://gw.example.com/oauth/mcp/client-metadata.json';

  it('ours first, then a hosted client metadata document, then dynamic registration', () => {
    const everything = server({ clientIdMetadataDocumentSupported: true, registrationEndpoint: ISSUER + '/register' });
    expect(chooseClient({ server: everything, provided, cimdUrl })).toEqual({ kind: 'provided', client: provided });
    expect(chooseClient({ server: everything, provided: undefined, cimdUrl })).toEqual({ kind: 'cimd', clientId: cimdUrl });
    expect(chooseClient({ server: server({ registrationEndpoint: ISSUER + '/register' }), provided: undefined, cimdUrl })).toEqual({ kind: 'dcr' });
    // No public https address, no CIMD: a server that supports both gets DCR.
    expect(chooseClient({ server: everything, provided: undefined })).toEqual({ kind: 'dcr' });
  });

  it('refuses with a message when the server offers nothing we can use', () => {
    expect(() => chooseClient({ server: server(), provided: undefined, cimdUrl })).toThrow(/neither a client metadata document nor dynamic registration/);
  });

  it('a package that forces a kind gets that kind or a refusal that says why', () => {
    const everything = server({ clientIdMetadataDocumentSupported: true, registrationEndpoint: ISSUER + '/register' });
    expect(chooseClient({ server: everything, provided, mode: 'dcr', cimdUrl })).toEqual({ kind: 'dcr' });
    expect(chooseClient({ server: everything, provided: undefined, mode: 'cimd', cimdUrl })).toEqual({ kind: 'cimd', clientId: cimdUrl });
    expect(() => chooseClient({ server: server({ registrationEndpoint: ISSUER + '/register' }), provided: undefined, mode: 'cimd', cimdUrl })).toThrow(McpOAuthError);
    expect(() => chooseClient({ server: everything, provided: undefined, mode: 'provided', cimdUrl })).toThrow(/needs an OAuth client configured/);
  });

  it('the client metadata document names the client id and the redirect URIs and holds no secret', () => {
    const doc = clientMetadataDocument(cimdUrl, ['https://gw.example.com/oauth/mcp/callback']);
    expect(doc).toMatchObject({ client_id: cimdUrl, redirect_uris: ['https://gw.example.com/oauth/mcp/callback'], token_endpoint_auth_method: 'none' });
    expect(Object.keys(doc).some((key) => key.includes('secret'))).toBe(false);
  });

  it('a provided client is read from the deployment secrets an app package NAMES', () => {
    const env = { OK_CLIENT_ID: 'id-1', OK_CLIENT_SECRET: 'secret-1' };
    expect(configuredClientFor('https://auth.ok.test', env, { idName: 'OK_CLIENT_ID', secretName: 'OK_CLIENT_SECRET' })).toMatchObject({ clientId: 'id-1', clientSecret: 'secret-1' });
    expect(configuredClientFor('https://auth.ok.test', {}, { idName: 'OK_CLIENT_ID' })).toBeUndefined();
    expect(configuredClientFor('https://auth.ok.test', env)).toBeUndefined();
  });
});

describe('a 403 insufficient_scope', () => {
  it('carries the scope the server wants, so the sign-in can be extended; a plain 403 or 401 does not', async () => {
    const answer = (status: number, challenge?: string) => (async () => new Response(null, { status, headers: challenge === undefined ? {} : { 'www-authenticate': challenge } })) as typeof fetch;
    const call = (fetchImpl: typeof fetch) => new HttpMcpTransport({ url: MCP, fetchImpl, authorize: async () => 'Bearer t' }).request(1, 'tools/list', {});
    const stepUp = await call(answer(403, 'Bearer error="insufficient_scope", scope="admin:write"')).catch((error: unknown) => error);
    expect(stepUp).toBeInstanceOf(McpAuthError);
    expect((stepUp as McpAuthError).insufficientScope).toBe('admin:write');
    const plain = await call(answer(403)).catch((error: unknown) => error);
    expect((plain as McpAuthError).insufficientScope).toBeUndefined();
    const expired = await call(answer(401, 'Bearer error="invalid_token"')).catch((error: unknown) => error);
    expect((expired as McpAuthError).insufficientScope).toBeUndefined();
  });
});

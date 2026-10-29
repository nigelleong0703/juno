import { describe, expect, it } from 'vitest';
import { buildAuthorizationUrl, configuredClientFor, discoverAuthorizationServer, exchangeCode, loopbackRedirectBase, MICROSOFT_ISSUER, refreshTokens } from '../oauth.js';

const MCP = 'https://gw.example.com/mcp/google/outlook-mail';
const RESOURCE = { resource: MCP, authorization_servers: [MICROSOFT_ISSUER] };

/** A fetch that only knows our protected-resource metadata; any request to Microsoft would fail the test. */
const onlyOurMetadata = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.startsWith('https://gw.example.com/.well-known/oauth-protected-resource')) return Response.json(RESOURCE);
  throw new Error('unexpected fetch ' + url);
}) as typeof fetch;

describe('Microsoft common authority', () => {
  it('is a configured client only when both env values are set', () => {
    expect(configuredClientFor(MICROSOFT_ISSUER, {})).toBeUndefined();
    expect(configuredClientFor(MICROSOFT_ISSUER, { MICROSOFT_CLIENT_ID: 'id', MICROSOFT_CLIENT_SECRET: 's' })).toMatchObject({ clientId: 'id', clientSecret: 's' });
    expect(configuredClientFor(MICROSOFT_ISSUER + '/', { MICROSOFT_CLIENT_ID: 'id' })).toMatchObject({ clientId: 'id' });
  });

  it('discovery gives the fixed v2.0 endpoints without asking Microsoft (its metadata names a templated tenant issuer)', async () => {
    const server = await discoverAuthorizationServer(MCP, undefined, onlyOurMetadata);
    expect(server).toEqual({
      issuer: MICROSOFT_ISSUER,
      authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    });
  });

  it('other issuers still need matching metadata: a lookalike issuer gets no shortcut', async () => {
    const lookalike = 'https://login.microsoftonline.com/common/v2.0.evil';
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('oauth-protected-resource')) return Response.json({ resource: MCP, authorization_servers: [lookalike] });
      if (url.includes('openid-configuration') || url.includes('oauth-authorization-server')) {
        return Response.json({ issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0', authorization_endpoint: 'https://x.example/a', token_endpoint: 'https://x.example/t', code_challenge_methods_supported: ['S256'] });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    await expect(discoverAuthorizationServer(MCP, undefined, fetchImpl)).rejects.toThrow(/different issuer/);
  });

  it('a desktop client on a random port is sent to localhost, the one loopback host whose port Microsoft ignores', () => {
    expect(loopbackRedirectBase('http://127.0.0.1:54321', MICROSOFT_ISSUER)).toBe('http://localhost:54321');
    expect(loopbackRedirectBase('http://[::1]:54321', MICROSOFT_ISSUER)).toBe('http://localhost:54321');
    // Google documents 127.0.0.1 with any port (and warns localhost can hit a firewall), so its base stays as given.
    expect(loopbackRedirectBase('http://127.0.0.1:54321', 'https://accounts.google.com')).toBe('http://127.0.0.1:54321');
    // A public deployment already matches by its real host.
    expect(loopbackRedirectBase('https://api.example.com', MICROSOFT_ISSUER)).toBe('https://api.example.com');
    expect(loopbackRedirectBase('not a url', MICROSOFT_ISSUER)).toBe('not a url');
  });

  it('sends no `resource` parameter to Microsoft (v2.0 refuses it) but still does to other servers', async () => {
    const server = await discoverAuthorizationServer(MCP, undefined, onlyOurMetadata);
    const url = new URL(buildAuthorizationUrl({ server, clientId: 'id', redirectUri: 'https://gw.example.com/oauth/mcp/callback', state: 's', challenge: 'c', resource: MCP, extraAuthParams: { scope: 'Mail.ReadWrite offline_access' } }));
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('scope')).toBe('Mail.ReadWrite offline_access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.has('resource')).toBe(false);

    const bodies: string[] = [];
    const tokenFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
    }) as typeof fetch;
    await exchangeCode({ server, client: { clientId: 'id', clientSecret: 's' }, code: 'c', verifier: 'v', redirectUri: 'https://gw.example.com/oauth/mcp/callback', resource: MCP, fetchImpl: tokenFetch });
    await refreshTokens({ server, client: { clientId: 'id', clientSecret: 's' }, refreshToken: 'r', resource: MCP, fetchImpl: tokenFetch });
    for (const body of bodies) expect(new URLSearchParams(body).has('resource')).toBe(false);

    const other = { issuer: 'https://accounts.google.com', authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token' };
    expect(new URL(buildAuthorizationUrl({ server: other, clientId: 'id', redirectUri: 'https://gw.example.com/cb', state: 's', challenge: 'c', resource: MCP })).searchParams.get('resource')).toBe(MCP);
  });
});

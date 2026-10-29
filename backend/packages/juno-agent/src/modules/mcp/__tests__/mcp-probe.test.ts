// The probe behind the custom-server confirm step and the admin draft (BACKEND 10.18.3): what a URL asks of the person, without any credential.
import { describe, expect, it } from 'vitest';
import { McpOAuthError } from '../oauth.js';
import { probeMcpEndpoint } from '../probe.js';

const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Server {
  /** Answer the MCP POST: a Response, or undefined to answer as an open server. */
  mcp?: (message: { method: string; id?: number }) => Response | undefined;
  documents?: Record<string, unknown>;
}

/** A fetch that serves one MCP endpoint at https://mcp.test/mcp and the metadata documents the test lists. */
function fetchFor(server: Server, tools: unknown[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url === 'https://mcp.test/mcp') {
      const message = JSON.parse(String(init.body)) as { method: string; id?: number };
      const custom = server.mcp?.(message);
      if (custom !== undefined) return custom;
      if (message.method === 'initialize') return json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'x', version: '1' } } });
      if (message.method === 'tools/list') return json({ jsonrpc: '2.0', id: message.id, result: { tools } });
      if (message.method === 'server/discover') return json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } });
      return new Response(null, { status: 202 });
    }
    const document = server.documents?.[url];
    return document === undefined ? new Response('not found', { status: 404 }) : json(document);
  }) as typeof fetch;
}

const unauthorized = (challenge?: string) => (): Response => new Response(null, { status: 401, ...(challenge === undefined ? {} : { headers: { 'www-authenticate': challenge } }) });

describe('probing an MCP server by URL', () => {
  it('an open server lists its tools with a suggestion each: a read hint is a read, no hint is a change', async () => {
    const found = await probeMcpEndpoint('https://mcp.test/mcp', {
      fetchImpl: fetchFor({}, [{ name: 'list_things', annotations: { readOnlyHint: true } }, { name: 'make_thing' }, { name: 'drop_thing', annotations: { destructiveHint: true } }]),
    });
    expect(found).toMatchObject({ auth: 'none', tools: [
      { name: 'list_things', suggested: 'read', basis: 'annotation' },
      { name: 'make_thing', suggested: 'change', basis: 'unmarked' },
      { name: 'drop_thing', suggested: 'change', basis: 'annotation' },
    ] });
  });

  it('a sign-in server is classified by the client it would use: dynamic registration, a client of ours, or none we can use', async () => {
    const prm = { resource: 'https://mcp.test/mcp', authorization_servers: ['https://auth.test'], scopes_supported: ['read'] };
    const as = (extra: Record<string, unknown>) => ({ issuer: 'https://auth.test', authorization_endpoint: 'https://auth.test/authorize', token_endpoint: 'https://auth.test/token', code_challenge_methods_supported: ['S256'], ...extra });
    const documents = (extra: Record<string, unknown>) => ({ 'https://mcp.test/.well-known/oauth-protected-resource/mcp': prm, 'https://auth.test/.well-known/oauth-authorization-server': as(extra) });
    const probe = (extra: Record<string, unknown>, env: Record<string, string> = {}) => probeMcpEndpoint('https://mcp.test/mcp', { fetchImpl: fetchFor({ mcp: unauthorized(), documents: documents(extra) }), env });

    expect((await probe({ registration_endpoint: 'https://auth.test/register' })).oauth).toMatchObject({ issuer: 'https://auth.test', scopes: ['read'], client: 'dcr', usable: true });
    expect((await probe({})).oauth).toMatchObject({ client: 'provided', usable: false });
    expect((await probe({ client_id_metadata_document_supported: true, registration_endpoint: 'https://auth.test/register' }, {})).oauth?.client).toBe('dcr');
    const cimd = await probeMcpEndpoint('https://mcp.test/mcp', { fetchImpl: fetchFor({ mcp: unauthorized(), documents: documents({ client_id_metadata_document_supported: true }) }), cimd: true });
    expect(cimd.oauth).toMatchObject({ client: 'cimd', usable: true });
  });

  it('a server that wants a credential but names no authorization server is an API-key server', async () => {
    expect(await probeMcpEndpoint('https://mcp.test/mcp', { fetchImpl: fetchFor({ mcp: unauthorized() }) })).toEqual({ url: 'https://mcp.test/mcp', auth: 'api_key' });
  });

  it('protected-resource metadata that names another resource is refused, not bent (RFC 9728)', async () => {
    const metadata = 'https://mcp.test/.well-known/oauth-protected-resource';
    const failing = probeMcpEndpoint('https://mcp.test/mcp', {
      fetchImpl: fetchFor({ mcp: unauthorized(`Bearer resource_metadata="${metadata}"`), documents: { [metadata]: { resource: 'https://other.test/mcp', authorization_servers: ['https://auth.test'] } } }),
    });
    await expect(failing).rejects.toBeInstanceOf(McpOAuthError);
    await expect(failing).rejects.toMatchObject({ code: 'MCP_OAUTH_DISCOVERY' });
  });
});

import { describe, expect, it } from 'vitest';
import { stackUrls } from '../harness/client';

/**
 * The connectors the api hosts are internal (BACKEND 10.18.4), checked across the two real processes: the api's hosted Gmail endpoint answers
 * a request that carries HOSTED_MCP_TOKEN (agentd's MCP client sends it), while a caller from outside with no credential, or with any other
 * bearer, gets a bare 401.
 */
describe('a hosted connector', () => {
  it('answers agentd with the service credential and nobody else', async () => {
    const { apiUrl, hostedMcpToken } = stackUrls();
    const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    for (const authorization of [undefined, 'Bearer wrong', 'Bearer ' + stackUrls().internalToken]) {
      const denied = await fetch(apiUrl + '/mcp/google/gmail', { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) }, body: list });
      expect(denied.status).toBe(401);
      expect(await denied.text()).toBe('');
      expect(denied.headers.get('www-authenticate')).toBeNull();
    }
    expect((await fetch(apiUrl + '/mcp/google/gmail', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + hostedMcpToken }, body: list })).status).toBe(200);
  });
});

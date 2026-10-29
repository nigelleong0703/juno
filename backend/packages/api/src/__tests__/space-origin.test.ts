import { describe, expect, it } from 'vitest';
import { parseApiConfig } from '../config.js';
import { checkEdgeHosts, hostKind, registrableDomain } from '../edge-hosts.js';
import { forwardHeaders, parseSpaceHost, signSpaceToken, verifySpaceToken } from '../space-origin.js';
import { spaceStatuses } from '../modules/spaces.js';

const claims = { spaceId: 'spaceaaaa1234567890', ownerId: 'owner-1', expiresAt: 2_000_000 };

describe('space tokens', () => {
  it('bind kind, space and owner, and refuse expired, forged and re-signed ones', () => {
    const open = signSpaceToken({ kind: 'open', ...claims }, 'secret');
    expect(verifySpaceToken(open, 'secret', 'open', claims.spaceId, 1_000_000)).toEqual({ kind: 'open', ...claims });
    expect(verifySpaceToken(open, 'secret', 'session', claims.spaceId, 1_000_000)).toBeNull();
    expect(verifySpaceToken(open, 'secret', 'open', 'spacebbbb1234567890', 1_000_000)).toBeNull();
    expect(verifySpaceToken(open, 'secret', 'open', claims.spaceId, 2_000_000)).toBeNull();
    expect(verifySpaceToken(open, 'other', 'open', claims.spaceId, 1_000_000)).toBeNull();
    expect(verifySpaceToken(open + 'x', 'secret', 'open', claims.spaceId, 1_000_000)).toBeNull();
    expect(verifySpaceToken(signSpaceToken({ kind: 'open', ...claims }, ''), '', 'open', claims.spaceId, 1_000_000)).toBeNull();
    const withoutKind = Buffer.from(JSON.stringify(claims)).toString('base64url');
    expect(verifySpaceToken(withoutKind + '.x', 'secret', 'open', claims.spaceId, 1_000_000)).toBeNull();
  });
});

describe('parseSpaceHost', () => {
  it('takes the space id from <id>.<domain> with the configured port and nothing else', () => {
    expect(parseSpaceHost('spaceaaaa1234567890.spaces.localhost:8793', 'spaces.localhost:8793')).toBe('spaceaaaa1234567890');
    expect(parseSpaceHost('SPACEAAAA1234567890.Spaces.Localhost:8793', 'spaces.localhost:8793')).toBe('spaceaaaa1234567890');
    for (const host of [undefined, '', 'spaces.localhost:8793', 'a.b.spaces.localhost:8793', 'short.spaces.localhost:8793', 'spaceaaaa1234567890.spaces.localhost', 'spaceaaaa1234567890.evil.test:8793', 'x_x_x_x_x_x_x_x.spaces.localhost:8793']) {
      expect(parseSpaceHost(host, 'spaces.localhost:8793')).toBeUndefined();
    }
  });
});

describe('forwardHeaders', () => {
  it('drops our cookie and every platform or hop header, keeps the app\'s own, and states the space', () => {
    const out = forwardHeaders(new Headers({
      host: 'x', cookie: 'juno_space=abc; mine=1', 'x-owner-id': 'o', 'x-agent-id': 'a', 'x-juno-anything': '1', 'x-forwarded-for': '1.2.3.4',
      forwarded: 'for=1.2.3.4', 'accept-encoding': 'gzip', connection: 'keep-alive', authorization: 'Bearer app', 'content-type': 'text/plain',
    }), 'spaceid', 'spaceid.spaces.localhost:8793', 'https', 'k'.repeat(64));
    expect(Object.fromEntries(out)).toEqual({
      authorization: 'Bearer app', 'content-type': 'text/plain', cookie: 'mine=1', 'x-juno-space': 'spaceid',
      'x-forwarded-host': 'spaceid.spaces.localhost:8793', 'x-forwarded-proto': 'https',
      'x-juno-gateway-key': 'k'.repeat(64),
    });
    expect(forwardHeaders(new Headers({ cookie: 'juno_space=abc', 'x-juno-gateway-key': 'client-supplied' }), 's', 'h', 'http', 'real').has('cookie')).toBe(false);
    expect(forwardHeaders(new Headers({ 'x-juno-gateway-key': 'client-supplied' }), 's', 'h', 'http', 'real').get('x-juno-gateway-key')).toBe('real');
  });
});

describe('edge hosts and config', () => {
  const ok = { apiOrigin: 'https://api.203-0-113-10.sslip.io', artifactHost: '203-0-113-10.nip.io', spaceDomain: '203-0-113-10.nip.io' };
  it('accepts separate registrable domains and dev hosts', () => {
    expect(checkEdgeHosts(ok)).toEqual([]);
    expect(checkEdgeHosts({ apiOrigin: 'http://127.0.0.1:8787', artifactHost: 'usercontent.localhost:8787', spaceDomain: 'spaces.localhost:8787' })).toEqual([]);
    expect(registrableDomain('a.b.sslip.io:8787')).toBe('b.sslip.io');
    expect(registrableDomain('x.example.co.uk')).toBe('example.co.uk');
  });

  it('refuses a host that equals or contains the API host, or shares its site over https; warns over http', () => {
    expect(() => checkEdgeHosts({ ...ok, spaceDomain: 'api.203-0-113-10.sslip.io' })).toThrow(/API host/);
    expect(() => checkEdgeHosts({ ...ok, artifactHost: '203-0-113-10.sslip.io' })).toThrow(/API host/);
    expect(() => checkEdgeHosts({ ...ok, spaceDomain: 'spaces.203-0-113-10.sslip.io' })).toThrow(/registrable domain/);
    expect(() => checkEdgeHosts({ ...ok, artifactHost: 'usercontent.203-0-113-10.sslip.io' })).toThrow(/registrable domain/);
    expect(checkEdgeHosts({ ...ok, apiOrigin: 'http://api.203-0-113-10.sslip.io', spaceDomain: 'spaces.203-0-113-10.sslip.io' })).toHaveLength(1);
    expect(() => checkEdgeHosts({ ...ok, artifactHost: 'spaceaaaa1234567890.spaces.x.nip.io', spaceDomain: 'spaces.x.nip.io' })).toThrow(/Spaces host/);
  });

  it('routes by Host: artifact host, every host under SPACE_DOMAIN, otherwise the API', () => {
    const hosts = { artifactHost: 'usercontent.localhost:8787', spaceDomain: 'spaces.localhost:8787' };
    expect(hostKind('USERCONTENT.localhost:8787', hosts)).toBe('artifact');
    expect(hostKind('x.spaces.localhost:8787', hosts)).toBe('space');
    for (const host of ['spaces.localhost:8787', '127.0.0.1:8787', 'usercontent.localhost', undefined]) expect(hostKind(host, hosts)).toBe('api');
  });

  const base = { INTERNAL_AGENTD_TOKEN: 't', ARTIFACT_URL_SECRET: 'a', SPACE_URL_SECRET: 's', ARTIFACT_HOST: 'usercontent.localhost:8787' };
  it('needs the secrets and an artifact host, and has no extra listener config', () => {
    expect(parseApiConfig(base)).toMatchObject({ SPACE_DOMAIN: 'spaces.localhost:8787' });
    expect(parseApiConfig(base)).not.toHaveProperty('SPACE_PORT');
    expect(() => parseApiConfig({ ...base, SPACE_URL_SECRET: '' })).toThrow(/SPACE_URL_SECRET/);
    expect(() => parseApiConfig({ ...base, ARTIFACT_HOST: undefined })).toThrow(/ARTIFACT_HOST/);
    expect(() => parseApiConfig({ ...base, SPACE_DOMAIN: 'not a host' })).toThrow();
  });
});

describe('spaceStatuses', () => {
  const rows = [{ id: 'a', port: 7100 }, { id: 'b', port: 7101 }] as never;
  const link = (answer: unknown, ok = true) => ({ url: 'http://computerd.test', token: 't', fetch: (async () => new Response(JSON.stringify(answer), { status: ok ? 200 : 500 })) as typeof fetch });
  it('maps what computerd says, and is unknown whenever it cannot say', async () => {
    expect([...(await spaceStatuses(link({ computer: 'running', listening: ['a'] }), 'o', rows))]).toEqual([['a', 'running'], ['b', 'not_listening']]);
    expect([...(await spaceStatuses(link({ computer: 'paused', listening: [] }), 'o', rows)).values()]).toEqual(['computer_paused', 'computer_paused']);
    expect([...(await spaceStatuses(link({ computer: 'none', listening: [] }), 'o', rows)).values()]).toEqual(['unknown', 'unknown']);
    expect([...(await spaceStatuses(link({}, false), 'o', rows)).values()]).toEqual(['unknown', 'unknown']);
    expect([...(await spaceStatuses(undefined, 'o', rows)).values()]).toEqual(['unknown', 'unknown']);
  });
});

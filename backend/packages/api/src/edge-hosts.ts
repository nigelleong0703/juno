/**
 * The three kinds of host one API port answers to (BACKEND 5.11/5.12): the API's own host, ARTIFACT_HOST (signed HTML
 * pages) and `<spaceId>.<SPACE_DOMAIN>` (agent-built apps). Untrusted content must never share an origin or a cookie
 * scope with the API, so the startup check compares registrable domains.
 */
import { parseSpaceHost } from './space-origin.js';

/** Suffixes under which unrelated parties register names, beyond the plain last label. A short list on purpose: dev/tunnel hosts and common multi-label TLDs. */
const PUBLIC_SUFFIXES = new Set(['localhost', 'sslip.io', 'nip.io', 'github.io', 'vercel.app', 'pages.dev', 'workers.dev', 'netlify.app', 'co.uk', 'org.uk', 'com.cn', 'com.au', 'co.jp', 'com.hk', 'com.sg']);

const withoutPort = (host: string): string => host.toLowerCase().replace(/:\d+$/, '');

/** The name an owner registers under the public suffix (`a.b.sslip.io` -> `b.sslip.io`); an IP address or a bare suffix is its own. */
export function registrableDomain(host: string): string {
  const name = withoutPort(host);
  if (/^[\d.]+$/.test(name) || name.includes(':')) return name;
  const labels = name.split('.');
  let suffixLength = 1;
  for (let length = Math.min(3, labels.length); length >= 1; length -= 1) {
    if (PUBLIC_SUFFIXES.has(labels.slice(-length).join('.'))) {
      suffixLength = length;
      break;
    }
  }
  return labels.slice(-(suffixLength + 1)).join('.');
}

export interface EdgeHosts {
  /** Public API origin (BETTER_AUTH_URL). */
  apiOrigin: string;
  artifactHost: string;
  spaceDomain: string;
}

/**
 * Throws on a layout that would let untrusted content act as the API: a host equal to or containing the API host, or an
 * artifact host that is itself a space host. A host sharing the API's registrable domain throws when the API is served
 * over https (production) and is returned as a warning in plain-http development.
 */
export function checkEdgeHosts(hosts: EdgeHosts): string[] {
  const api = new URL(hosts.apiOrigin);
  const apiName = api.hostname.toLowerCase();
  const warnings: string[] = [];
  for (const [name, value] of [['ARTIFACT_HOST', hosts.artifactHost], ['SPACE_DOMAIN', hosts.spaceDomain]] as const) {
    const bare = withoutPort(value);
    if (apiName === bare || apiName.endsWith('.' + bare)) throw new Error(`${name} (${value}) must not equal or contain the API host (${apiName}): untrusted content must not share an origin with the API`);
    if (registrableDomain(bare) === registrableDomain(apiName)) {
      const message = `${name} (${value}) shares the registrable domain ${registrableDomain(apiName)} with the API host (${apiName}); use a separate domain`;
      if (api.protocol === 'https:') throw new Error(message);
      warnings.push(message);
    }
  }
  if (parseSpaceHost(hosts.artifactHost, hosts.spaceDomain) !== undefined) throw new Error(`ARTIFACT_HOST (${hosts.artifactHost}) is a Spaces host under SPACE_DOMAIN (${hosts.spaceDomain})`);
  return warnings;
}

export type HostKind = 'artifact' | 'space' | 'api';

/** Which handler a request belongs to, by Host: every host under SPACE_DOMAIN is Spaces' (a bad id is a 404 there, never the API's). */
export function hostKind(host: string | undefined, hosts: Pick<EdgeHosts, 'artifactHost' | 'spaceDomain'>): HostKind {
  const lower = host?.toLowerCase();
  if (lower === undefined) return 'api';
  if (lower === hosts.artifactHost.toLowerCase()) return 'artifact';
  return lower.endsWith('.' + hosts.spaceDomain.toLowerCase()) ? 'space' : 'api';
}

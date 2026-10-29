/** The edge's on-demand TLS `ask` endpoint (BACKEND 5.11/5.12): which host names may get a certificate. */
import type { Hono } from 'hono';
import { parseSpaceHost } from '../space-origin.js';

export interface EdgeTlsDeps {
  /** ARTIFACT_HOST; a port in it is ignored. */
  artifactHost: string;
  /** SPACE_DOMAIN; a port in it is ignored. */
  spaceDomain: string;
  /** Whether a published app has this id, for any owner. The answer is yes/no only. */
  spaceExists: (spaceId: string) => Promise<boolean>;
}

const withoutPort = (host: string): string => host.toLowerCase().replace(/:\d+$/, '');

/** `GET /v1/edge/tls-check?domain=<host>`: 200 for the artifact host and for `<existing space id>.<SPACE_DOMAIN>`, 404 for anything else. */
export function registerEdgeTlsCheck(app: Hono, deps: EdgeTlsDeps): void {
  app.get('/v1/edge/tls-check', async (c) => {
    const domain = c.req.query('domain')?.toLowerCase();
    const spaceId = parseSpaceHost(domain, withoutPort(deps.spaceDomain));
    const allowed = domain === withoutPort(deps.artifactHost) || (spaceId !== undefined && (await deps.spaceExists(spaceId)));
    return allowed ? c.text('ok', 200) : c.text('not found', 404);
  });
}

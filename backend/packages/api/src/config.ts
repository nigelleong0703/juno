/**
 * Public API gateway config. The API is the public entry (default :8787) and forwards
 * authenticated requests to the private agentd (default 127.0.0.1:8788) with a service
 * bearer token plus the server-resolved owner. Auth validation itself lives in
 * ./account-auth.js (resolveAuthMode); this file only validates gateway wiring so a
 * half-configured deployment fails fast instead of proxying anonymously or elsewhere.
 */
import { z } from 'zod';

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  }
  return true;
}

const httpUrlSchema = z.string().refine(isHttpUrl, { message: 'must be an http(s) URL with a valid port' });

const apiEnvSchema = z.object({
  /** Public port this gateway listens on. */
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Interface the gateway listens on. Loopback unless set: a server that serves clients directly sets `0.0.0.0` (or its private IP); behind tailscale serve or a reverse proxy on the same machine, loopback is right. */
  API_HOST: z.string().min(1).default('127.0.0.1'),
  /** Private agentd base URL (never exposed to clients). */
  AGENTD_URL: httpUrlSchema.default('http://127.0.0.1:8788'),
  /** Service bearer the gateway uses upstream; user tokens never leave the gateway. */
  INTERNAL_AGENTD_TOKEN: z.string().default(''),
  /** Bearer of the operator's app catalog path (`/admin/v1/apps`, BACKEND 10.18). A secret of its own, never the service bearer. Empty switches the path off (404). */
  ADMIN_TOKEN: z.string().default(''),
  /** Better Auth base URL (public URL of this gateway). Validated by resolveAuthMode. */
  BETTER_AUTH_URL: z.string().default(''),
  /** Postgres connection string for durable auth sessions. Validated by resolveAuthMode. */
  DATABASE_URL: z.string().default(''),
  /** Postgres connections each of the gateway's two pools (the app store, Better Auth's sessions) may hold; default 10, so 20 in all. agentd counts them in its connection budget (BACKEND 2.2c). */
  API_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /** computerd base URL for the signed screen-stream bridge. */
  COMPUTERD_URL: httpUrlSchema.default('http://127.0.0.1:8791'),
  /** HMAC key for screen tickets; empty fails the stream closed instead of open. */
  SCREEN_TICKET_SECRET: z.string().default(''),
  /** Host (with port when not default) that serves published HTML pages at `/a/<token>`, on the API's own port by Host; must be a separate site from the API host (BACKEND 5.11). Dev: usercontent.localhost:8787. */
  ARTIFACT_HOST: z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i, 'must be a host name with an optional port'),
  /** HMAC key for artifact render URLs; required at boot (like the other secrets). */
  ARTIFACT_URL_SECRET: z.string().default(''),
  /** Spaces (BACKEND 5.12): apps open on `<spaceId>.<SPACE_DOMAIN>`, served by the API port itself (dev: *.localhost resolves to this machine); must not equal or contain the API host. */
  SPACE_DOMAIN: z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i, 'must be a host name with an optional port').default('spaces.localhost:8787'),
  /** Scheme of the artifact, Spaces and signed media hosts as clients reach them (an edge proxy may terminate TLS in front of a plain-http API, so media cover/body URLs are signed with this scheme); defaults to BETTER_AUTH_URL's. Absent preserves local-dev behaviour. */
  EDGE_SCHEME: z.enum(['http', 'https']).optional(),
  /** HMAC key for the open links and the session cookie of Spaces; required at boot (like the other secrets). */
  SPACE_URL_SECRET: z.string().default(''),
  /** Where proxied images are kept (BACKEND 5.13); relative paths resolve from the API working directory; the default sits under the git-ignored .data/. */
  MEDIA_CACHE_DIR: z.string().default('.data/media'),
  SITE_ICON_CACHE_DIR: z.string().default('.data/site-icons'),
  /** computerd's bearer; the space listener and status routes call computerd with it. Empty: Spaces cannot reach computers (503). */
  COMPUTERD_TOKEN: z.string().default(''),
  /** Hosted Spaces (BACKEND 5.12, option B): the Cloudflare account that hosts published Spaces (REST API token with D1 edit and R2 write on it). Empty = hosting is off (publish-hosted answers 503 and says what is missing). */
  CF_ACCOUNT_ID: z.string().default(''),
  CF_API_TOKEN: z.string().default(''),
  /** The domain published Spaces live under, `<slug>-<linkId>.<this>`; must be a separate site from the app and the API (the Worker's CONTENT_DOMAIN). */
  SPACES_CONTENT_DOMAIN: z.string().default(''),
  /** `https` in production; `http` only for a local Worker. */
  SPACES_CONTENT_SCHEME: z.enum(['http', 'https']).default('https'),
  /** The D1 database and R2 bucket of the hosted Spaces Worker (see services/spaces-host/README.md). */
  SPACES_HOST_D1_DATABASE_ID: z.string().default(''),
  SPACES_HOST_R2_BUCKET: z.string().default(''),
  /** HMAC key of the owner links; the Worker holds the same value as a secret. */
  SPACES_HOST_SIGNING_KEY: z.string().default(''),
  /** Development only: publish to a local `wrangler dev` of the Worker (services/spaces-host, wrangler.dev.toml) instead of Cloudflare. */
  SPACES_HOST_LOCAL_URL: z.string().default(''),
  SPACES_HOST_LOCAL_ADMIN_TOKEN: z.string().default(''),
});

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export function parseApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const parsed = apiEnvSchema.parse(env);
  if (!parsed.INTERNAL_AGENTD_TOKEN) {
    throw new Error('INTERNAL_AGENTD_TOKEN is required (service bearer for the private agentd)');
  }
  if (!parsed.ARTIFACT_URL_SECRET) {
    throw new Error('ARTIFACT_URL_SECRET is required: it signs the URLs of published HTML pages');
  }
  if (!parsed.SPACE_URL_SECRET) {
    throw new Error('SPACE_URL_SECRET is required: it signs the open links and session cookies of Spaces');
  }
  return parsed;
}

let cachedConfig: ApiConfig | null = null;

export function getConfig(): ApiConfig {
  if (!cachedConfig) cachedConfig = parseApiConfig();
  return cachedConfig;
}

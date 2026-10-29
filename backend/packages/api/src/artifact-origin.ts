/**
 * The artifact origin (BACKEND 5.11): HTML pages an agent published, served from their own origin so they share nothing
 * with the app or the API. The only way in is a signed, short-lived URL the owner asked for through
 * `POST /v1/artifacts/:id/versions/:v/render-url`; the page itself is untrusted. Clients embed it in
 * `<iframe sandbox="allow-scripts">` (never allow-same-origin). The listener serves that HTML and nothing else, with a
 * CSP that only allows the origins the page declared, and neither reads nor sets a cookie.
 */
import { Hono } from 'hono';
import type { BlobStore, Store } from '@agent-desktop/contracts';
import type { ArtifactCsp } from '@agent-desktop/public-contracts';
import { createArtifactsModule } from './modules/artifacts.js';
import { signToken, verifyToken } from './signed-token.js';

/** How long a render URL works; clients ask again when a frame has to reload later. */
export const RENDER_URL_TTL_MS = 60 * 60 * 1000;

export interface ArtifactTokenClaims {
  artifactId: string;
  version: number;
  ownerId: string;
  expiresAt: number;
}

export function signArtifactToken(claims: ArtifactTokenClaims, secret: string): string {
  return signToken(claims, secret);
}

export function verifyArtifactToken(token: string, secret: string, now = Date.now()): ArtifactTokenClaims | null {
  const value = verifyToken(token, secret);
  if (value === null) return null;
  const { artifactId, version, ownerId, expiresAt } = value;
  if (typeof artifactId !== 'string' || typeof ownerId !== 'string' || typeof version !== 'number' || typeof expiresAt !== 'number') return null;
  if (!Number.isInteger(version) || expiresAt <= now) return null;
  return { artifactId, version, ownerId, expiresAt };
}

/** The Content-Security-Policy of a published page: nothing but inline code/style and the origins it declared. */
export function artifactCspHeader(csp: ArtifactCsp | undefined, frameAncestors: readonly string[]): string {
  const declared = csp?.resourceDomains ?? [];
  const sources = (...base: string[]): string => [...base, ...declared].join(' ') || "'none'";
  return [
    "default-src 'none'",
    `script-src ${sources("'unsafe-inline'")}`,
    `style-src ${sources("'unsafe-inline'")}`,
    `img-src ${sources('data:', 'blob:')}`,
    `font-src ${sources()}`,
    `connect-src ${sources()}`,
    `frame-ancestors ${frameAncestors.join(' ') || "'none'"}`,
    "form-action 'none'",
    "base-uri 'none'",
    // Also sandboxed when opened directly instead of in the app's iframe: an opaque origin, scripts only.
    'sandbox allow-scripts',
  ].join('; ');
}

export interface ArtifactOriginDeps {
  store: Store;
  blobs: BlobStore;
  secret: string;
  /** Origins of the apps allowed to embed the page (CSP frame-ancestors). */
  frameAncestors: readonly string[];
}

export function createArtifactOriginApp(deps: ArtifactOriginDeps): Hono {
  const app = new Hono();
  app.get('/a/:token', async (c) => {
    const claims = verifyArtifactToken(c.req.param('token'), deps.secret);
    const page = claims === null || deps.store.forOwner === undefined ? null : await createArtifactsModule(deps.store.forOwner(claims.ownerId), deps.blobs).html(claims.artifactId, claims.version);
    if (page === null) return c.text('not found', 404, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return new Response(new Uint8Array(page.html), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': artifactCspHeader(page.csp, deps.frameAncestors),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'private, no-store',
      },
    });
  });
  return app;
}

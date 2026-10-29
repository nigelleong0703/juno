/** Published artifacts: metadata with versions, per-version downloads and the signed render URL for HTML pages. */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { createAppRepository } from '../app-repository.js';
import { requestOwner } from '../owner.js';
import { RENDER_URL_TTL_MS, signArtifactToken } from '../artifact-origin.js';
import type { AppRoutesDeps } from './index.js';

const notFound = (what: string) => ({ error: { code: 'NOT_FOUND', message: what + ' not found' } });

const downloadQuerySchema = z.object({ part: z.enum(['file', 'preview', 'thumbnail']).default('file') });

export function registerArtifacts(app: Hono, deps: AppRoutesDeps): void {
  const repo = (c: Context) => createAppRepository(deps.store, deps.blobs, requestOwner(c), deps.settingsUpdater);
  const versionParam = (c: Context): number | null => {
    const version = Number(c.req.param('v'));
    return Number.isInteger(version) && version >= 1 ? version : null;
  };

  app.get('/v1/artifacts/:id', async (c) => {
    const artifact = await repo(c).artifacts.get(c.req.param('id'));
    return artifact ? c.json(artifact) : c.json(notFound('artifact'), 404);
  });

  app.get('/v1/artifacts/:id/versions/:v', async (c) => {
    const version = versionParam(c);
    const found = version === null ? null : await repo(c).artifacts.version(c.req.param('id'), version);
    return found ? c.json(found) : c.json(notFound('artifact version'), 404);
  });

  // Same shape and checks as the library download; `part` picks the file, its PDF preview or its first-page PNG.
  app.get('/v1/artifacts/:id/versions/:v/download', async (c) => {
    const version = versionParam(c);
    const query = downloadQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: { code: 'INVALID_PART', message: 'part must be file, preview or thumbnail' } }, 400);
    const result = version === null ? { status: 'not_found' as const } : await repo(c).artifacts.download(c.req.param('id'), version, query.data.part);
    if (result.status === 'not_found') return c.json(notFound('artifact version'), 404);
    if (result.status === 'unavailable') return c.json({ error: { code: 'FILE_UNAVAILABLE', message: result.reason } }, 404);
    return c.json(result.file);
  });

  app.post('/v1/artifacts/:id/versions/:v/render-url', async (c) => {
    if (deps.artifactOrigin === undefined) return c.json({ error: { code: 'ARTIFACTS_UNAVAILABLE', message: 'the artifact origin is not configured' } }, 503);
    const version = versionParam(c);
    const artifacts = repo(c).artifacts;
    const found = version === null ? null : await artifacts.version(c.req.param('id'), version);
    if (version === null || found === null) return c.json(notFound('artifact version'), 404);
    if ((await artifacts.get(c.req.param('id')))?.render !== 'html') return c.json({ error: { code: 'NOT_HTML', message: 'only html artifacts have a render URL' } }, 400);
    const expiresAt = Date.now() + RENDER_URL_TTL_MS;
    const token = signArtifactToken({ artifactId: c.req.param('id'), version, ownerId: requestOwner(c), expiresAt }, deps.artifactOrigin.secret);
    return c.json({ url: deps.artifactOrigin.origin.replace(/\/$/, '') + '/a/' + token, expiresAt: new Date(expiresAt).toISOString() });
  });
}

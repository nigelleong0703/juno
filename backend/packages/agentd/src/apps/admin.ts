/**
 * The admin routes of the app catalog (BACKEND 10.18): how an operator adds, edits, hides or retires an app without a code change or a
 * deploy. They are not owner routes: the service bearer alone opens them (no owner header), the same as `/internal/connector-catalog`, and
 * the gateway forwards them only under its own admin path, guarded by ADMIN_TOKEN (packages/api/src/routes/admin.ts).
 *
 * An app is a package (interface, mcpServers, skills, userConfig, tools, binding, status) at a version; every write is a new version.
 *
 * GET   /v1/admin/apps                 every app at its newest version, retired ones too
 * GET   /v1/admin/apps/:id/versions    every version of one app, oldest first
 * POST  /v1/admin/apps                 add an app (409 when the id exists, retired or not)
 * PATCH /v1/admin/apps/:id             change fields of an app (`null` clears an optional one); status listed or hidden brings a retired app back
 * POST  /v1/admin/apps/:id/retire      take an app off the page and out of every agent's tools
 * POST  /v1/admin/apps/probe          `{url}` or `{composioToolkit}` (+ `id?`, `name?`): probe the server (same probe as the owner's custom-server confirm
 *                                      step) and write a `hidden` draft package; 201 `{app, probe?}`. A server that cannot be drafted answers 422 with the probe and the reason.
 *                                      The admin reviews the draft (marks, text, tags) and PATCHes it to `listed`.
 * (deferred) POST /v1/admin/apps/import   add an app from an OpenAI or Claude plugin package
 *
 * A write is visible at once in this process (the catalog reloads itself) and in the others within the catalog's refresh interval.
 */
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import type { AppCatalogRow } from 'juno-agent/contracts';
import { appCatalogCreateSchema, appCatalogPatchSchema, type CatalogWrite, type StoredCatalog } from 'juno-agent/modules/apps/catalog';
import { McpOAuthError } from 'juno-agent/modules/mcp/oauth';
import { probeMcpEndpoint } from 'juno-agent/modules/mcp/probe';
import { draftFromProbe, draftFromToolkit, draftInputSchema } from './draft.js';

export interface AdminAppsDeps {
  /** Outbound fetch for the probe (the private-network guard in production). */
  fetchImpl: typeof fetch;
  /** The deployment's environment, to know which issuers have a client registered. */
  env: Record<string, string | undefined>;
  catalog: StoredCatalog;
  /** The chat platform kinds this deployment runs, so a chat row cannot name a plugin that is not loaded. */
  chatPlugins: () => readonly string[];
  internalToken: string;
}

const failure = (c: Context, status: 400 | 401 | 404 | 409, code: string, message: string): Response => c.json({ error: { code, message } }, status);

/** What the admin sees of an app: its package at the newest version, `id` being the app id (the stored `<appId>@<version>` row key and the owner every row belongs to are left out). */
function present(row: AppCatalogRow): Omit<AppCatalogRow, 'ownerId' | 'appId'> {
  const { ownerId: _owner, appId, ...rest } = row;
  return { ...rest, id: appId };
}

async function parsed<S extends z.ZodType>(c: Context, schema: S): Promise<{ ok: true; data: z.output<S> } | { ok: false; response: Response }> {
  const result = schema.safeParse(await c.req.json().catch(() => null));
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  return { ok: false, response: failure(c, 400, 'VALIDATION_ERROR', (issue === undefined ? 'Invalid body' : issue.path.join('.') + ': ' + issue.message).replace(/^: /, '')) };
}

export function registerAdminApps(app: Hono, deps: AdminAppsDeps): void {
  app.use('/v1/admin/*', async (c, next) => {
    if (c.req.header('authorization') !== 'Bearer ' + deps.internalToken) return failure(c, 401, 'UNAUTHORIZED', 'Invalid or missing token');
    await next();
    return undefined;
  });
  const answer = (c: Context, outcome: CatalogWrite, status: 200 | 201): Response => outcome.ok ? c.json(present(outcome.row), status) : failure(c, outcome.status, outcome.code, outcome.message);

  app.get('/v1/admin/apps', (c) => c.json({ items: deps.catalog.rows().map(present) }));

  app.get('/v1/admin/apps/:id/versions', (c) => {
    const versions = deps.catalog.versions(c.req.param('id'));
    return versions.length === 0 ? failure(c, 404, 'APP_NOT_FOUND', 'No such app') : c.json({ items: versions.map(present) });
  });

  app.post('/v1/admin/apps/probe', async (c) => {
    const body = await parsed(c, draftInputSchema);
    if (!body.ok) return body.response;
    if ('composioToolkit' in body.data) {
      const { composioToolkit, ...names } = body.data;
      const created = await deps.catalog.create(draftFromToolkit(composioToolkit, names), deps.chatPlugins());
      return created.ok ? c.json({ app: present(created.row) }, 201) : failure(c, created.status, created.code, created.message);
    }
    const { url, ...names } = body.data;
    let probe;
    try {
      probe = await probeMcpEndpoint(url, { fetchImpl: deps.fetchImpl, env: deps.env });
    } catch (error) {
      if (error instanceof McpOAuthError) return failure(c, 400, error.code, error.message);
      throw error;
    }
    const draft = draftFromProbe(probe, names);
    if (!draft.ok) return c.json({ error: { code: 'DRAFT_NOT_POSSIBLE', message: draft.reason }, probe }, 422);
    const created = await deps.catalog.create(draft.create, deps.chatPlugins());
    return created.ok ? c.json({ app: present(created.row), probe }, 201) : failure(c, created.status, created.code, created.message);
  });

  app.post('/v1/admin/apps', async (c) => {
    const body = await parsed(c, appCatalogCreateSchema);
    return body.ok ? answer(c, await deps.catalog.create(body.data, deps.chatPlugins()), 201) : body.response;
  });

  app.patch('/v1/admin/apps/:id', async (c) => {
    const body = await parsed(c, appCatalogPatchSchema);
    if (!body.ok) return body.response;
    if (Object.keys(body.data).length === 0) return failure(c, 400, 'VALIDATION_ERROR', 'Nothing to change');
    return answer(c, await deps.catalog.update(c.req.param('id'), body.data, deps.chatPlugins()), 200);
  });

  app.post('/v1/admin/apps/:id/retire', async (c) => answer(c, await deps.catalog.retire(c.req.param('id')), 200));
}

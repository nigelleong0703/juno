/**
 * Draft an app from what an operator names (BACKEND 10.18.3): an MCP server URL, probed with the same probe the custom-server confirm step uses,
 * or a Composio toolkit slug. The draft is a catalog package written `hidden`: nobody sees it until an admin reviews it (the read / change marks,
 * the listing text, the capability tags) and sets it `listed` with the ordinary PATCH. Nothing here lists an app.
 */
import { z } from 'zod';
import type { McpProbe } from 'juno-agent/modules/mcp/probe';
import { appCatalogCreateSchema, type AppCatalogCreate } from 'juno-agent/modules/apps/catalog';

const idField = z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'a slug of lowercase letters, digits and hyphens (2-40 characters)');
const nameField = z.string().trim().min(1).max(60);

/** `POST /v1/admin/apps/probe`: exactly one of `url` (an MCP server) or `composioToolkit`. `id` and `name` default from the host or the slug. */
export const draftInputSchema = z.union([
  z.object({ url: z.string().min(1).max(500), id: idField.optional(), name: nameField.optional() }).strict(),
  z.object({ composioToolkit: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,59}$/, 'a Composio toolkit slug'), id: idField.optional(), name: nameField.optional() }).strict(),
]);
export type DraftInput = z.infer<typeof draftInputSchema>;

const titleCase = (text: string): string => text.split(/[-_.]+/).filter((word) => word !== '').map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ');

/** The id and name a URL suggests: `mcp.acme.com` -> `acme`, `Acme`. */
function namesOfUrl(raw: string): { id: string; name: string } {
  const host = URL.canParse(raw) ? new URL(raw).hostname : 'app';
  const labels = host.split('.').filter((label) => label !== '' && !['mcp', 'www', 'api', 'com', 'net', 'org', 'io', 'ai', 'app', 'dev'].includes(label));
  const base = (labels[0] ?? host).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  const id = base.length >= 2 ? base.slice(0, 40) : 'app-' + base;
  return { id, name: titleCase(id) };
}

export type Draft = { ok: true; create: AppCatalogCreate } | { ok: false; reason: string };

const LISTING = 'Draft, not reviewed yet.';

/** A hidden draft package for a probed server, or why none can be drafted. */
export function draftFromProbe(probe: McpProbe, input: { id?: string | undefined; name?: string | undefined }): Draft {
  const names = namesOfUrl(probe.url);
  const id = input.id ?? names.id;
  const name = input.name ?? names.name;
  if (probe.auth === 'api_key') return { ok: false, reason: 'The server wants an API key and names no authorization server. Write its package by hand (a sensitive userConfig value in a header, and a probe tool).' };
  const oauth = probe.oauth;
  if (probe.auth === 'oauth' && (oauth === undefined || (oauth.client === 'provided' && oauth.scopes.length === 0))) {
    return { ok: false, reason: 'The server needs an OAuth client of ours registered with its issuer, and it names no scopes to ask for. Write its package by hand.' };
  }
  const marks = Object.fromEntries((probe.tools ?? []).map((tool) => [tool.name, tool.suggested] as const));
  const create = appCatalogCreateSchema.safeParse({
    id,
    category: 'work',
    interface: { displayName: name, shortDescription: LISTING, longDescription: LISTING + ' Added from ' + probe.url + '.', icon: 'automation', defaultPrompts: [] },
    mcpServers: {
      [id]: {
        type: 'streamable-http',
        url: probe.url,
        auth: probe.auth,
        ...(probe.auth === 'oauth' && oauth !== undefined ? { oauth: { ...(oauth.client === 'provided' ? { client: 'provided' as const, issuer: oauth.issuer } : {}), ...(oauth.scopes.length === 0 ? {} : { scopes: oauth.scopes }) } } : {}),
      },
    },
    ...(Object.keys(marks).length === 0 ? {} : { tools: marks }),
    status: 'hidden',
  });
  return create.success ? { ok: true, create: create.data } : { ok: false, reason: (create.error.issues[0]?.path.join('.') ?? '') + ': ' + (create.error.issues[0]?.message ?? 'invalid') };
}

/** A hidden draft for a Composio toolkit. Its tools live behind the owner's own session, so there is nothing to probe; the admin writes the marks. */
export function draftFromToolkit(toolkit: string, input: { id?: string | undefined; name?: string | undefined }): AppCatalogCreate {
  const name = input.name ?? titleCase(toolkit);
  return appCatalogCreateSchema.parse({
    id: input.id ?? (toolkit.length >= 2 ? toolkit.replace(/_/g, '-').slice(0, 40) : toolkit + '-app'),
    category: 'work',
    source: 'composio',
    toolkit,
    interface: { displayName: name, shortDescription: LISTING, longDescription: LISTING + ' Through Composio, which holds the login.', icon: 'automation', defaultPrompts: [] },
    status: 'hidden',
  });
}

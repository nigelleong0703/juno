/**
 * The app catalog as data (BACKEND 10.18): the `appCatalog` rows are the source of truth for what the Apps page lists and what agents can
 * use, so adding or changing an app is a row edit (the admin API), not a code change or a deploy. An entry is an app PACKAGE in the shape the
 * industry uses (OpenAI plugin manifests, Claude `plugin.json`), as data: an `interface` block for the page, `mcpServers` (mcp.json), `skills`
 * (the SKILL.md files), `userConfig` (what the owner supplies), per-tool read/change overrides, a `binding` for chat and web-login apps, a
 * status and a version. Nothing in a package is a credential: OAuth client secrets are NAMES of deployment secrets, the owner's values live
 * sealed on their own connection.
 *
 * The first boot seeds the table from the built-in connectors and the chat platform plugins; a row that exists is never overwritten by a
 * seed, so an edit survives the next deploy, and a new built-in shipped later is added. Every edit writes a new version (`<appId>@<n>`); the
 * runtime reads a snapshot of the newest versions (`list`/`get` are synchronous, as the tools and the MCP manager need), reloaded on every
 * write here and on a short timer, so a change takes effect without a restart.
 *
 * Transports stay code: a chat app's `binding.plugin` names the plugin that carries it.
 */
import { z } from 'zod';
import { appCategorySchema, connectorCategorySchema, type AppAuthKind, type UserConfigField } from '@agent-desktop/public-contracts';
import type { AppCatalogRow, AppMcpServer, AppUserConfigField, Store } from '../../contracts/index.js';
import type { CatalogEntry, ConnectorCatalog } from '../mcp/catalog.js';
import { CAPABILITY_TAGS, type CapabilityTag } from './provides.js';
import { listAll } from '../memory/util.js';

/** Deployment-wide rows belong to this owner, never to an account (so deleting an account leaves the catalog alone). */
export const CATALOG_OWNER = 'system';

/** `${user_config.KEY}`: where an owner's value goes in a server's URL or headers. */
const TEMPLATE = /\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
export const templateKeys = (text: string): string[] => [...text.matchAll(TEMPLATE)].map((match) => match[1] ?? '');
const withoutTemplates = (text: string): string => text.replace(TEMPLATE, 'x');

/** https, loopback http (the e2e fixture) or a path this gateway hosts; a `${user_config.KEY}` may stand in the path or query, never in the host. */
function isOfferedUrl(raw: string): boolean {
  if (raw.startsWith('/mcp/')) return true;
  const hostPart = /^[a-z]+:\/\/[^/]*/i.exec(raw)?.[0] ?? '';
  if (hostPart.includes('${')) return false;
  try {
    const url = new URL(withoutTemplates(raw));
    return url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

const httpsUrl = z.string().max(500).refine((value) => /^https:\/\//.test(value) && URL.canParse(value), 'must be an https URL');
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'a slug of lowercase letters, digits and hyphens (2-40 characters)');
const secretName = z.string().regex(/^[A-Z][A-Z0-9_]{2,60}$/, 'the NAME of a deployment secret (upper-case letters, digits and underscores), never its value');

const oauthSchema = z.object({
  client: z.enum(['provided', 'cimd', 'dcr']).optional(),
  issuer: httpsUrl.optional(),
  scopes: z.array(z.string().min(1).max(300)).max(60).optional(),
  clientIdName: secretName.optional(),
  clientSecretName: secretName.optional(),
  revocationEndpoint: httpsUrl.optional(),
}).strict();

const mcpServerSchema = z.object({
  type: z.literal('streamable-http'),
  url: z.string().max(500).refine(isOfferedUrl, 'must be an https URL, or a path this gateway hosts (/mcp/...); a ${user_config.KEY} may not be in the host'),
  auth: z.enum(['none', 'oauth', 'mixed', 'api_key']),
  oauth: oauthSchema.optional(),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,60}$/, 'a header name'), z.string().max(500)).optional(),
  platformKey: z.literal(true).optional(),
  sharedRooms: z.literal(true).optional(),
  probe: z.object({ tool: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()).optional() }).strict().optional(),
}).strict();

const packageFieldSchema = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  required: z.boolean().optional(),
  default: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
  options: z.array(z.string().min(1).max(100)).min(1).max(30).optional(),
  sensitive: z.boolean().optional(),
}).strict();
const userConfigKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,59}$/, 'a key of letters, digits and underscores');

const interfaceSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  shortDescription: z.string().trim().max(140),
  longDescription: z.string().trim().min(1).max(500),
  developerName: z.string().trim().min(1).max(80).optional(),
  icon: z.string().trim().min(1).max(40),
  brandColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'a #RRGGBB colour').optional(),
  defaultPrompts: z.array(z.string().trim().min(1).max(140)).max(6),
  websiteUrl: httpsUrl.optional(),
  privacyPolicyUrl: httpsUrl.optional(),
  termsOfServiceUrl: httpsUrl.optional(),
}).strict();

const packageSkillSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'a kebab-case skill name').max(64),
  description: z.string().trim().min(1).max(1024),
  instructions: z.string().trim().min(1).max(20_000),
}).strict();

const fields = {
  group: connectorCategorySchema,
  interface: interfaceSchema,
  license: z.string().trim().min(1).max(40),
  keywords: z.array(z.string().trim().min(1).max(40)).max(20),
  packageVersion: z.string().regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/, 'a semantic version'),
  mcpServers: z.record(slug, mcpServerSchema),
  skills: z.array(packageSkillSchema).max(20),
  onboardingSkill: z.string().max(64),
  userConfig: z.record(userConfigKey, packageFieldSchema),
  readOnly: z.literal(true),
  tools: z.record(z.string().min(1).max(100), z.enum(['read', 'change'])),
  provides: z.array(z.enum(CAPABILITY_TAGS as [CapabilityTag, ...CapabilityTag[]])).max(30),
  source: z.literal('composio'),
  /** Composio's toolkit slug (lower-case words, as in the toolkit's docs). */
  toolkit: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,59}$/, 'a Composio toolkit slug'),
  binding: z.object({
    plugin: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/).optional(),
    reach: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/).optional(),
    login: z.enum(['none', 'sandbox']).optional(),
  }).strict(),
};

/** `POST /v1/admin/apps`: a whole app package. Chat and web apps may be listed too; `custom` is the owner's own servers, never a catalog row. */
export const appCatalogCreateSchema = z.object({
  id: slug,
  category: appCategorySchema.exclude(['custom']),
  group: fields.group.optional(),
  interface: fields.interface,
  license: fields.license.optional(),
  keywords: fields.keywords.optional(),
  packageVersion: fields.packageVersion.optional(),
  mcpServers: fields.mcpServers.default({}),
  skills: fields.skills.default([]),
  onboardingSkill: fields.onboardingSkill.optional(),
  userConfig: fields.userConfig.default({}),
  readOnly: fields.readOnly.optional(),
  tools: fields.tools.optional(),
  provides: fields.provides.optional(),
  source: fields.source.optional(),
  toolkit: fields.toolkit.optional(),
  binding: fields.binding.optional(),
  status: z.enum(['listed', 'hidden']).default('listed'),
}).strict();
export type AppCatalogCreate = z.infer<typeof appCatalogCreateSchema>;

/** `PATCH /v1/admin/apps/:id`: any of the fields except the id and the category; the result is a new version. `null` clears an optional field. */
export const appCatalogPatchSchema = z.object({
  group: fields.group.nullable(),
  interface: fields.interface,
  license: fields.license.nullable(),
  keywords: fields.keywords.nullable(),
  packageVersion: fields.packageVersion.nullable(),
  mcpServers: fields.mcpServers,
  skills: fields.skills,
  onboardingSkill: fields.onboardingSkill.nullable(),
  userConfig: fields.userConfig,
  readOnly: fields.readOnly.nullable(),
  tools: fields.tools.nullable(),
  provides: fields.provides.nullable(),
  source: fields.source.nullable(),
  toolkit: fields.toolkit.nullable(),
  binding: fields.binding.nullable(),
  status: z.enum(['listed', 'hidden']),
}).partial().strict();
export type AppCatalogPatch = z.infer<typeof appCatalogPatchSchema>;

const firstServer = (row: Pick<AppCatalogRow, 'mcpServers'>): AppMcpServer | undefined => Object.values(row.mcpServers)[0];

/** The auth kind the Apps page shows: what the (first) server needs, or the chat/web kind. */
export function appAuthOf(row: Pick<AppCatalogRow, 'category' | 'mcpServers' | 'binding'>): AppAuthKind {
  if (row.category === 'chat') return 'bot_install';
  if (row.category === 'web') return row.binding?.login === 'none' ? 'none' : 'sandbox_login';
  return firstServer(row)?.auth ?? 'oauth';
}

/** The auth kind of a server that does not say: a deployment key needs nothing, a sensitive value in a header is a key, the rest sign in. */
export function defaultServerAuth(server: Pick<AppMcpServer, 'platformKey' | 'headers' | 'oauth'>, userConfig: Readonly<Record<string, AppUserConfigField>>): AppMcpServer['auth'] {
  if (server.platformKey === true) return 'none';
  const keyed = Object.values(server.headers ?? {}).some((value) => templateKeys(value).some((key) => userConfig[key]?.sensitive === true));
  return keyed ? 'api_key' : 'oauth';
}

/** The fields of the page's `userConfig` list, from the package's keyed form. */
export function userConfigList(userConfig: Readonly<Record<string, AppUserConfigField>>): UserConfigField[] {
  return Object.entries(userConfig).map(([key, field]) => ({
    key, type: field.type, title: field.title, description: field.description, required: field.required === true, sensitive: field.sensitive === true,
    ...(field.default === undefined ? {} : { default: field.default }),
    ...(field.options === undefined ? {} : { options: field.options }),
  }));
}

/** What is wrong with a whole package across its fields, or undefined: the checks no single field can make. */
export function rowProblem(row: Pick<AppCatalogRow, 'category' | 'mcpServers' | 'userConfig' | 'skills' | 'onboardingSkill' | 'binding' | 'readOnly' | 'tools' | 'source' | 'toolkit'>): string | undefined {
  if ((row.source === undefined) !== (row.toolkit === undefined)) return 'source composio and toolkit go together';
  if (row.source !== undefined && row.category !== 'work') return 'only a work app can come from Composio';
  const names = row.skills.map((skill) => skill.name);
  if (new Set(names).size !== names.length) return 'skill names must be unique';
  if (row.onboardingSkill !== undefined && !names.includes(row.onboardingSkill)) return 'onboardingSkill names a skill the package does not have';
  for (const [key, field] of Object.entries(row.userConfig)) {
    if (field.default !== undefined && typeof field.default !== field.type) return 'userConfig ' + key + ': the default is not a ' + field.type;
    if (field.options !== undefined && field.type !== 'string') return 'userConfig ' + key + ': options belong to a string field';
    if (field.options !== undefined && typeof field.default === 'string' && !field.options.includes(field.default)) return 'userConfig ' + key + ': the default is not one of the options';
  }
  if (row.category !== 'work') {
    if (Object.keys(row.mcpServers).length > 0 || row.readOnly !== undefined || row.tools !== undefined || Object.keys(row.userConfig).length > 0) {
      return 'only a work app has MCP servers, tool marks and user values';
    }
    if (row.category === 'chat') return row.binding?.plugin === undefined ? 'a chat app names the plugin that carries it (binding.plugin)' : undefined;
    if (row.binding?.plugin !== undefined) return 'a web app has no chat plugin';
    if (row.binding?.login !== undefined && (row.binding.reach === undefined || row.skills.length === 0)) return 'a web app that reads through the computer names its Agent Reach channel (binding.reach) and ships the skill that uses it';
    return undefined;
  }
  if (row.binding?.plugin !== undefined) return 'a work app has no chat plugin';
  // A Composio app has no server of its own: Composio makes the per-user MCP address and holds the login.
  if (row.source !== undefined) return Object.keys(row.mcpServers).length > 0 || Object.keys(row.userConfig).length > 0 ? 'a Composio app has no MCP servers or user values of its own' : undefined;
  const servers = Object.entries(row.mcpServers);
  if (servers.length === 0) return 'a work app needs at least one MCP server (mcpServers)';
  const used = new Set<string>();
  for (const [name, server] of servers) {
    const where = 'mcpServers.' + name;
    for (const text of [server.url, ...Object.values(server.headers ?? {})]) for (const key of templateKeys(text)) used.add(key);
    for (const key of templateKeys(server.url)) {
      if (row.userConfig[key]?.sensitive === true) return where + ': a sensitive value goes in a header, not the URL';
    }
    const unknown = [server.url, ...Object.values(server.headers ?? {})].flatMap(templateKeys).find((key) => row.userConfig[key] === undefined);
    if (unknown !== undefined) return where + ': ${user_config.' + unknown + '} is not declared in userConfig';
    if (server.oauth !== undefined && server.auth !== 'oauth' && server.auth !== 'mixed') return where + ': oauth settings belong to an oauth or mixed server';
    if (server.platformKey === true && server.auth !== 'none') return where + ': a server called with the deployment\'s key has auth none';
    if (server.auth === 'api_key') {
      const keyed = Object.values(server.headers ?? {}).some((value) => templateKeys(value).some((key) => row.userConfig[key]?.sensitive === true));
      if (!keyed) return where + ': auth api_key needs a header holding a sensitive ${user_config.KEY}';
      // What the owner typed is only believed after a read-only call with it succeeds (BACKEND 10.18.1).
      if (server.probe === undefined) return where + ': auth api_key needs a probe (a read-only tool to call with the key before the app counts as connected)';
    } else if (server.probe !== undefined && server.auth !== 'none') {
      return where + ': a probe belongs to an api_key or keyless server; a sign-in proves itself';
    }
    const oauth = server.oauth;
    if (oauth?.client === 'provided') {
      if (oauth.issuer === undefined) return where + ': a provided client needs oauth.issuer';
      if (!server.url.startsWith('/') && (oauth.scopes ?? []).length === 0) return where + ': a server that needs a provided client needs the scopes to ask for';
    }
    if (oauth?.client !== 'provided' && (oauth?.clientIdName !== undefined || oauth?.clientSecretName !== undefined || oauth?.issuer !== undefined)) {
      return where + ': oauth.issuer and the client secret names belong to a provided client';
    }
    if ((oauth?.clientIdName === undefined) !== (oauth?.clientSecretName === undefined)) return where + ': name both the client id and the client secret, or neither';
  }
  const unused = Object.keys(row.userConfig).find((key) => !used.has(key));
  if (unused !== undefined) return 'userConfig ' + unused + ' is not used in any server URL or header';
  return undefined;
}

/** Why the install flow cannot add a package yet (the schema accepts what the flow does not), or undefined. */
export function installBlockOf(row: Pick<AppCatalogRow, 'category' | 'mcpServers'>): string | undefined {
  if (row.category !== 'work') return undefined;
  const servers = Object.values(row.mcpServers);
  if (servers.length > 1) return 'Apps with more than one MCP server cannot be added yet';
  if (servers[0]?.auth === 'mixed') return 'Apps with some public tools and some behind a sign-in cannot be added yet';
  return undefined;
}

/** A Composio app (no server of its own) as a catalog row at version 1. */
function composioRow(entry: CatalogEntry, toolkit: string, now: string): AppCatalogRow {
  return {
    id: entry.id + '@1', ownerId: CATALOG_OWNER, appId: entry.id, version: 1, category: 'work', group: entry.category, source: 'composio', toolkit,
    interface: {
      displayName: entry.name,
      shortDescription: entry.blurb ?? entry.description.split(/(?<=[.!?])\s/)[0]?.slice(0, 140) ?? '',
      longDescription: entry.description,
      icon: entry.icon,
      defaultPrompts: entry.tryAsking ?? [],
    },
    mcpServers: {}, skills: [], userConfig: {},
    ...(entry.toolAccess === undefined ? {} : { tools: { ...entry.toolAccess } }),
    ...(entry.provides === undefined ? {} : { provides: [...entry.provides] }),
    ...(entry.readOnly === true ? { readOnly: true as const } : {}),
    status: 'listed', createdAt: now, updatedAt: now,
  };
}

/** A connector a plugin registers (or the built-in list), as a catalog row at version 1. Listing text a plugin did not give is made from the description. */
export function entryRow(entry: CatalogEntry, now: string): AppCatalogRow {
  if (entry.source === 'composio' && entry.toolkit !== undefined) return composioRow(entry, entry.toolkit, now);
  const userConfig: Record<string, AppUserConfigField> = {};
  for (const [key, field] of Object.entries(entry.userConfig ?? {})) userConfig[key] = { ...field };
  const server: AppMcpServer = {
    type: 'streamable-http',
    url: entry.url,
    auth: 'oauth',
    ...(entry.headers === undefined ? {} : { headers: { ...entry.headers } }),
    ...(entry.platformKey === true ? { platformKey: true as const } : {}),
    ...(entry.sharedRooms === true ? { sharedRooms: true as const } : {}),
    ...(entry.probe === undefined ? {} : { probe: entry.probe }),
  };
  server.auth = entry.auth ?? defaultServerAuth(server, userConfig);
  if (server.auth === 'oauth' || server.auth === 'mixed') {
    const provided = entry.oauthClient ?? (entry.configuredClientIssuer === undefined ? undefined : 'provided');
    const oauth = {
      ...(provided === undefined ? {} : { client: provided }),
      ...(entry.configuredClientIssuer === undefined ? {} : { issuer: entry.configuredClientIssuer }),
      ...(entry.scopes === undefined ? {} : { scopes: entry.scopes }),
      ...(entry.clientIdName === undefined ? {} : { clientIdName: entry.clientIdName }),
      ...(entry.clientSecretName === undefined ? {} : { clientSecretName: entry.clientSecretName }),
      ...(entry.revocationEndpoint === undefined ? {} : { revocationEndpoint: entry.revocationEndpoint }),
    };
    if (Object.keys(oauth).length > 0) server.oauth = oauth;
  }
  const skills = (entry.skills ?? []).map((skill) => ({ ...skill }));
  return {
    id: entry.id + '@1',
    ownerId: CATALOG_OWNER,
    appId: entry.id,
    version: 1,
    category: 'work',
    group: entry.category,
    interface: {
      displayName: entry.name,
      shortDescription: entry.blurb ?? entry.description.split(/(?<=[.!?])\s/)[0]?.slice(0, 140) ?? '',
      longDescription: entry.description,
      icon: entry.icon,
      defaultPrompts: entry.tryAsking ?? [],
    },
    mcpServers: { [entry.id]: server },
    skills,
    ...(entry.onboardingSkill === undefined ? {} : { onboardingSkill: entry.onboardingSkill }),
    userConfig,
    ...(entry.readOnly === true ? { readOnly: true as const } : {}),
    ...(entry.toolAccess === undefined ? {} : { tools: { ...entry.toolAccess } }),
    ...(entry.provides === undefined ? {} : { provides: [...entry.provides] }),
    status: 'listed',
    createdAt: now,
    updatedAt: now,
  };
}

/** The flat server entry an MCP app's package describes, as the tools, the MCP manager and the gateway read it; undefined for a package without a server. */
export function rowEntry(row: AppCatalogRow): CatalogEntry | undefined {
  if (row.category === 'work' && row.source !== undefined && row.toolkit !== undefined) {
    return {
      id: row.appId, name: row.interface.displayName, icon: row.interface.icon, description: row.interface.longDescription, category: row.group ?? 'productivity',
      url: '', auth: 'oauth', version: row.version, source: row.source, toolkit: row.toolkit,
      ...(row.readOnly === true ? { readOnly: true as const } : {}),
      ...(row.tools === undefined ? {} : { toolAccess: row.tools }),
      ...(row.provides === undefined ? {} : { provides: row.provides }),
    };
  }
  const server = firstServer(row);
  if (row.category !== 'work' || server === undefined) return undefined;
  const oauth = server.oauth;
  const block = installBlockOf(row);
  return {
    id: row.appId,
    name: row.interface.displayName,
    icon: row.interface.icon,
    description: row.interface.longDescription,
    category: row.group ?? 'productivity',
    url: server.url,
    auth: server.auth,
    version: row.version,
    ...(oauth?.issuer === undefined ? {} : { configuredClientIssuer: oauth.issuer }),
    ...(oauth?.scopes === undefined ? {} : { scopes: oauth.scopes }),
    ...(oauth?.revocationEndpoint === undefined ? {} : { revocationEndpoint: oauth.revocationEndpoint }),
    ...(oauth?.client === undefined ? {} : { oauthClient: oauth.client }),
    ...(oauth?.clientIdName === undefined ? {} : { clientIdName: oauth.clientIdName }),
    ...(oauth?.clientSecretName === undefined ? {} : { clientSecretName: oauth.clientSecretName }),
    ...(server.platformKey === true ? { platformKey: true } : {}),
    ...(server.headers === undefined ? {} : { headers: server.headers }),
    ...(Object.keys(row.userConfig).length === 0 ? {} : { userConfig: row.userConfig }),
    ...(row.readOnly === true ? { readOnly: true as const } : {}),
    ...(row.tools === undefined ? {} : { toolAccess: row.tools }),
    ...(row.provides === undefined ? {} : { provides: row.provides }),
    ...(server.sharedRooms === true ? { sharedRooms: true as const } : {}),
    ...(server.probe === undefined ? {} : { probe: server.probe }),
    ...(row.skills.length === 0 ? {} : { skills: row.skills }),
    ...(row.onboardingSkill === undefined ? {} : { onboardingSkill: row.onboardingSkill }),
    ...(block === undefined ? {} : { installBlock: block }),
  };
}

export type CatalogWrite = { ok: true; row: AppCatalogRow } | { ok: false; status: 400 | 404 | 409; code: string; message: string };

/** The catalog the running deployment reads: the table's newest versions, served from a snapshot that is reloaded on every write. */
export interface StoredCatalog extends ConnectorCatalog {
  /** The newest version of every app, retired ones included (the admin list and the Apps page's chat apps read it), in the page's order. */
  rows(): readonly AppCatalogRow[];
  /** Every version of one app, oldest first. */
  versions(appId: string): readonly AppCatalogRow[];
  /** Reload the snapshot from the table now. */
  refresh(): Promise<void>;
  /** Reload on a timer, so another process's write reaches this one; returns the stop. */
  watch(everyMs: number): () => void;
  create(input: AppCatalogCreate, chatPlugins?: readonly string[]): Promise<CatalogWrite>;
  update(id: string, patch: AppCatalogPatch, chatPlugins?: readonly string[]): Promise<CatalogWrite>;
  retire(id: string): Promise<CatalogWrite>;
}

/** What a reader of the catalog needs; a deployment without a catalog (a test app) reads this empty one and lists no app. */
export type CatalogReader = Pick<StoredCatalog, 'list' | 'get' | 'hidden' | 'rows' | 'web'>;
export const NO_APPS: CatalogReader = { list: () => [], get: () => undefined, hidden: () => [], rows: () => [] };

export interface StoredCatalogDeps {
  store: Store;
  /** Rows to add when the table has no app with the id: the built-in connectors and the chat platforms. An app that exists is left as the admin made it. */
  seed: readonly AppCatalogRow[];
  now?: () => Date;
  /** Called with each version written by create, update or retire (not by the seed), before the write is answered: agentd seeds the package's skills into the platform skill store here. A failure fails the write. */
  afterWrite?: (row: AppCatalogRow) => Promise<void>;
}

export const rowIdOf = (appId: string, version: number): string => appId + '@' + String(version);

export async function createStoredCatalog(deps: StoredCatalogDeps): Promise<StoredCatalog> {
  const store = deps.store.forOwner?.(CATALOG_OWNER) ?? deps.store;
  const now = deps.now ?? (() => new Date());
  let snapshot = { rows: [] as AppCatalogRow[], history: new Map<string, AppCatalogRow[]>(), listed: [] as CatalogEntry[], hidden: [] as CatalogEntry[], usable: new Map<string, CatalogEntry>() };

  const refresh = async (): Promise<void> => {
    const all = await listAll(store, 'appCatalog', { orderBy: 'id' });
    const history = new Map<string, AppCatalogRow[]>();
    for (const row of all) history.set(row.appId, [...(history.get(row.appId) ?? []), row]);
    for (const versions of history.values()) versions.sort((a, b) => a.version - b.version);
    // The page's order is the order the apps were first created in (each seed is a millisecond after the last).
    const rows = [...history.values()].flatMap((versions) => versions.at(-1) ?? []).sort((a, b) => (history.get(a.appId)?.[0]?.createdAt ?? '').localeCompare(history.get(b.appId)?.[0]?.createdAt ?? '') || a.appId.localeCompare(b.appId));
    const entryOf = (status: AppCatalogRow['status']): CatalogEntry[] => rows.filter((row) => row.status === status).flatMap((row) => rowEntry(row) ?? []);
    const listed = entryOf('listed');
    const hidden = entryOf('hidden');
    snapshot = { rows, history, listed, hidden, usable: new Map([...listed, ...hidden].map((entry) => [entry.id, entry] as const)) };
  };

  const existing = new Set((await listAll(store, 'appCatalog')).map((row) => row.appId));
  for (const row of deps.seed) {
    if (!existing.has(row.appId)) await store.put('appCatalog', { ...row, ownerId: CATALOG_OWNER });
  }
  await refresh();

  const find = (id: string): AppCatalogRow | undefined => snapshot.rows.find((row) => row.appId === id);
  const write = async (row: AppCatalogRow): Promise<CatalogWrite> => {
    await store.put('appCatalog', row);
    await refresh();
    await deps.afterWrite?.(row);
    return { ok: true, row };
  };
  const problem = (row: AppCatalogRow, chatPlugins: readonly string[] | undefined): string | undefined =>
    rowProblem(row) ?? (row.category === 'chat' && chatPlugins !== undefined && row.binding?.plugin !== undefined && !chatPlugins.includes(row.binding.plugin) ? 'no chat platform plugin "' + row.binding.plugin + '" is loaded here' : undefined);

  return {
    list: () => snapshot.listed,
    get: (id) => snapshot.usable.get(id),
    hidden: () => snapshot.hidden,
    web(id) {
      const row = find(id);
      if (row?.category !== 'web' || (row.status !== 'listed' && row.status !== 'hidden')) return undefined;
      return {
        // The agent reads this line as "what is it for, when do I use it": the skill's own what/when, not the owner-facing blurb.
        id: row.appId, name: row.interface.displayName, description: row.skills[0]?.description ?? row.interface.longDescription,
        ...(row.skills.length === 0 ? {} : { skills: row.skills }),
        ...(row.onboardingSkill === undefined ? {} : { onboardingSkill: row.onboardingSkill }),
      };
    },
    rows: () => snapshot.rows,
    versions: (appId) => snapshot.history.get(appId) ?? [],
    refresh,
    watch(everyMs) {
      const timer = setInterval(() => { void refresh().catch(() => undefined); }, everyMs);
      timer.unref();
      return () => clearInterval(timer);
    },
    async create(input, chatPlugins) {
      if (find(input.id) !== undefined) return { ok: false, status: 409, code: 'APP_EXISTS', message: 'An app with this id exists already (retired ones too); edit it instead' };
      const at = now().toISOString();
      const { id, ...rest } = input;
      const row: AppCatalogRow = { ...rest, id: rowIdOf(id, 1), ownerId: CATALOG_OWNER, appId: id, version: 1, createdAt: at, updatedAt: at };
      const wrong = problem(row, chatPlugins);
      return wrong === undefined ? write(row) : { ok: false, status: 400, code: 'INVALID_APP', message: wrong };
    },
    async update(id, patch, chatPlugins) {
      const current = find(id);
      if (current === undefined) return { ok: false, status: 404, code: 'APP_NOT_FOUND', message: 'No such app' };
      const { group, license, keywords, packageVersion, onboardingSkill, readOnly, tools, provides, source, toolkit, binding, ...plain } = patch;
      const at = now().toISOString();
      const next: AppCatalogRow = { ...current, ...plain, id: rowIdOf(id, current.version + 1), version: current.version + 1, createdAt: at, updatedAt: at };
      // `null` clears an optional field; the others replace.
      for (const [key, value] of [['group', group], ['license', license], ['keywords', keywords], ['packageVersion', packageVersion], ['onboardingSkill', onboardingSkill], ['readOnly', readOnly], ['tools', tools], ['provides', provides], ['source', source], ['toolkit', toolkit], ['binding', binding]] as const) {
        if (value === undefined) continue;
        if (value === null) Reflect.deleteProperty(next, key);
        else Reflect.set(next, key, value);
      }
      const wrong = problem(next, chatPlugins);
      return wrong === undefined ? write(next) : { ok: false, status: 400, code: 'INVALID_APP', message: wrong };
    },
    async retire(id) {
      const current = find(id);
      if (current === undefined) return { ok: false, status: 404, code: 'APP_NOT_FOUND', message: 'No such app' };
      if (current.status === 'retired') return { ok: true, row: current };
      const at = now().toISOString();
      return write({ ...current, id: rowIdOf(id, current.version + 1), version: current.version + 1, status: 'retired', createdAt: at, updatedAt: at });
    },
  };
}

/**
 * The connector catalog's entries: code-defined, one entry per official remote MCP server. No third-party integration
 * platform sits behind it; each entry is a streamable-HTTP MCP endpoint the vendor documents, and the OAuth
 * grant and its tokens stay with us (BACKEND 10.15). An entry is added only when the vendor's own docs confirm
 * the endpoint and an OAuth login that works with our fixed redirect URI (dynamic registration, or a configured
 * client for the issuer). A Google service with a public API but no Google-run MCP server (YouTube, Tasks) is served by
 * this gateway (modules/google-mcp.ts): its `url` is a path here, made absolute with PUBLIC_URL by `resolveCatalog`,
 * and Google stays the authorization server. Not listed on purpose: Google Photos (since 2025-03-31 the Library
 * API only reads what the app itself uploaded; the Picker API needs the owner to pick photos each time), GitHub
 * (remote server OAuth not confirmed in its docs) and Slack (no dynamic registration; only directory-published
 * apps may connect), until a configured client exists. The entries live here, not in api, so the agent can search them
 * (tools/tools/connectorSearch.ts); agentd's `connectors-builtin` plugin registers them, and api reads the resulting
 * catalog from agentd and adds what only the gateway knows (hosted scopes) in its connector-catalog.ts.
 */

import type { ConnectorCategory } from '@agent-desktop/public-contracts';
import { HOSTED_MCP_PATH, SG_MCP_PATH } from '../tools/net/guardedFetch.js';
import { configuredClientFor, MICROSOFT_ISSUER, type ClientSecretNames } from './oauth.js';
import { PLATFORM_KEY_SERVERS } from './platform-keys.js';

const GOOGLE_MCP_PATH = HOSTED_MCP_PATH;
/** The Hevy server this gateway hosts, and the header the owner's own key travels in. */
export const HEVY_MCP_PATH = '/mcp/hevy';
export const HEVY_KEY_HEADER = 'api-key';

export interface CatalogEntry {
  id: string;
  name: string;
  icon: string;
  description: string;
  category: ConnectorCategory;
  /** The MCP endpoint; a path (`/mcp/google/<service>`) for a server this gateway hosts. */
  url: string;
  /** Provider needs an OAuth client from our configuration (no dynamic registration): the issuer it is keyed by. */
  configuredClientIssuer?: string;
  /** OAuth scopes the vendor documents for this server; sent in the authorization request. A hosted entry leaves them to api, which reads them from the gateway's tool modules. */
  scopes?: string[];
  /**
   * Called with this deployment's API key, not a user sign-in (juno-agent mcp/platform-keys.ts): offered only when the
   * key is set, and connected by default for every owner until they disconnect it.
   */
  platformKey?: boolean;
  /**
   * How the owner is let in: `oauth` (the default when no key is declared), `api_key` (a sensitive `userConfig` value goes into `headers`
   * or the URL), `none` (a platform key or a public server) or `mixed` (not addable yet). Absent: worked out from the other fields.
   */
  auth?: 'none' | 'oauth' | 'mixed' | 'api_key';
  /** The values the owner supplies when adding the app (Claude plugins' `userConfig`), keyed. They are sealed with the connection; `url` and `headers` name them as `${user_config.KEY}`. */
  userConfig?: Readonly<Record<string, { type: 'string' | 'number' | 'boolean'; title: string; description: string; required?: boolean; default?: string | number | boolean; options?: string[]; sensitive?: boolean }>>;
  /** Request headers for the server, values possibly `${user_config.KEY}`. They are resolved and sealed on the connection when the app is added. */
  headers?: Readonly<Record<string, string>>;
  /** `oauth.client: 'provided'` with the NAMES of the deployment secrets holding its client id and secret (instead of the built-in table by issuer). */
  clientIdName?: string;
  clientSecretName?: string;
  /** What the app lets an agent do, as capability tags (modules/apps/provides.ts): how a need ("send email") finds the apps that could meet it. */
  provides?: readonly string[];
  /** Force the kind of OAuth client: ours (`provided`), a hosted client metadata document (`cimd`) or dynamic registration (`dcr`). Absent: the best the server offers. */
  oauthClient?: 'provided' | 'cimd' | 'dcr';
  /**
   * An app added with the owner's own value (an API key) counts as connected only after this read-only call succeeds with it: the server's tool
   * name and arguments. Required for `api_key`; an OAuth app proves itself by signing in and has none (BACKEND 10.18.1).
   */
  probe?: { tool: string; args?: Record<string, unknown> };
  /** The version of the catalog row this entry was read from; absent for an entry a plugin registered but the table has not seen yet. */
  version?: number;
  /** The how-to skills the app ships, and the one to read right after adding it. */
  skills?: ReadonlyArray<{ name: string; description: string; instructions: string }>;
  onboardingSkill?: string;
  /** Why the app cannot be added by this deployment's install flow yet (more than one MCP server, `mixed` auth); absent when it can. */
  installBlock?: string;
  /** RFC 7009 revocation endpoint, when the provider documents one. */
  revocationEndpoint?: string;
  /**
   * Our own word on read versus change, which beats the server's annotation (tool-access.ts): `readOnly` when the server can only read
   * (its documentation says so), `toolAccess` for single tools whose annotation is wrong or missing. A tool nobody marks is a change.
   */
  readOnly?: true;
  toolAccess?: Readonly<Record<string, 'read' | 'change'>>;
  /**
   * Its tools may be offered in a group or a stranger's chat (batch 5b). Without it a connected app's tools are offered only in the
   * owner's own chat, since they reach the owner's data. No entry is marked yet.
   */
  sharedRooms?: true;
  /**
   * `composio`: a long-tail app whose login Composio holds (BACKEND 10.18.3); `url` is empty (the per-user MCP address comes from a Composio
   * session at install) and `toolkit` is its Composio toolkit slug. Absent: an official app, the vendor's own MCP server.
   */
  source?: 'composio';
  toolkit?: string;
  /** Listing text for the Apps page; a plugin's entry may give it, otherwise the first seed makes it from `description`. After the seed it lives in the app catalog table. */
  blurb?: string;
  tryAsking?: string[];
}

/** The deployment secret names an entry gives for its provided OAuth client, when it names its own. */
export function entryClientNames(entry: Pick<CatalogEntry, 'clientIdName' | 'clientSecretName'>): ClientSecretNames | undefined {
  return entry.clientIdName === undefined ? undefined : { idName: entry.clientIdName, ...(entry.clientSecretName === undefined ? {} : { secretName: entry.clientSecretName }) };
}

/** False when the entry needs a provided OAuth client this deployment does not have configured. */
export function entryClientAvailable(entry: CatalogEntry, env: Record<string, string | undefined>): boolean {
  return entry.configuredClientIssuer === undefined || configuredClientFor(entry.configuredClientIssuer, env, entryClientNames(entry)) !== undefined;
}

/** The ids of the catalog entries marked `sharedRooms`. */
export function sharedRoomCatalogIds(entries: readonly CatalogEntry[]): ReadonlySet<string> {
  return new Set(entries.filter((entry) => entry.sharedRooms === true).map((entry) => entry.id));
}

const GOOGLE_ISSUER = 'https://accounts.google.com';
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
const G = 'https://www.googleapis.com/auth/';
const google = (scopes: string[]): Pick<CatalogEntry, 'configuredClientIssuer' | 'scopes' | 'revocationEndpoint'> => ({
  configuredClientIssuer: GOOGLE_ISSUER,
  scopes: scopes.map((scope) => G + scope),
  revocationEndpoint: GOOGLE_REVOKE,
});

/** A Google service hosted by this gateway (api modules/google-mcp.ts): its path here; api adds the scopes its tools need. */
const hosted = (service: string): Pick<CatalogEntry, 'url' | 'configuredClientIssuer' | 'revocationEndpoint'> => ({
  url: GOOGLE_MCP_PATH + service,
  configuredClientIssuer: GOOGLE_ISSUER,
  revocationEndpoint: GOOGLE_REVOKE,
});

/** A Microsoft 365 service hosted by this gateway on Microsoft Graph: Microsoft has no token revocation endpoint to call. */
const microsoft = (service: string): Pick<CatalogEntry, 'url' | 'configuredClientIssuer'> => ({
  url: GOOGLE_MCP_PATH + service,
  configuredClientIssuer: MICROSOFT_ISSUER,
});

/** A server called with this deployment's key: its URL comes from the one table that also holds the key header. */
const keyedUrl = (catalogId: string): string => PLATFORM_KEY_SERVERS.find((server) => server.catalogId === catalogId)?.url ?? '';

/**
 * The catalog as the agent and the gateway read it: built once at startup from the entries plugins registered
 * (agentd: the first-party `connectors-builtin` plugin plus any other), then passed to whatever needs it. Nothing reads
 * the entries from a module constant, so a plugin that is off contributes nothing anywhere.
 */
export interface ConnectorCatalog {
  /** The apps on offer (status `listed`): what the page lists, what an agent can search and what an owner can add. */
  list(): readonly CatalogEntry[];
  /** An app that can be used: listed, or hidden (not offered any more but what was added keeps working); a retired or unknown app is undefined. */
  get(id: string): CatalogEntry | undefined;
  /** The hidden apps: not offered, but shown to the owners who already added them. */
  hidden(): readonly CatalogEntry[];
  /**
   * A web app (category `web`, BACKEND 10.18) that can be used: listed or hidden. It has no MCP server (the agent reads through its computer's
   * shell and the app's how-to skill), so `get` does not know it and no tool, search or install flow sees it. Absent in a catalog without web apps.
   */
  web?(id: string): WebAppEntry | undefined;
}

/** What the agent's prompt and the skill gate need of a web app. */
export type WebAppEntry = Pick<CatalogEntry, 'id' | 'name' | 'description' | 'skills' | 'onboardingSkill'>;

/** A fixed catalog (tests and tools that need no table); the running deployment reads its catalog from the table (apps/catalog.ts). */
export function createConnectorCatalog(entries: readonly CatalogEntry[]): ConnectorCatalog {
  const byId = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error('duplicate connector id: ' + entry.id);
    byId.set(entry.id, entry);
  }
  return { list: () => entries, get: (id) => byId.get(id), hidden: () => [] };
}

/** `toolAccess` for a vendor that publishes its read tools: these are reads, every other tool (a new one included) is a change and asks. */
const readTools = (names: readonly string[]): Record<string, 'read'> => Object.fromEntries(names.map((name) => [name, 'read' as const]));

/** The entries the first-party `connectors-builtin` plugin registers; nothing else reads this table. */
const BUILTIN_ENTRIES: readonly CatalogEntry[] = [
  // Gmail, Calendar, Drive: hosted here on the regular REST APIs (Google's own MCP servers for them need Workspace
  // Developer Preview enrollment, which a personal account may not get).
  {
    id: 'gmail', name: 'Gmail', icon: 'mail', category: 'productivity',
    description: 'Search and read your email, write drafts, send mail and label messages.',
    ...hosted('gmail'),
  },
  {
    id: 'google-calendar', name: 'Google Calendar', icon: 'calendar', category: 'productivity',
    description: 'See your calendars, events and free time, and add, change or answer events.',
    ...hosted('calendar'),
  },
  {
    id: 'google-drive', name: 'Google Drive', icon: 'folder', category: 'files',
    description: 'Find and read files in your Drive, and create or copy them.',
    ...hosted('drive'),
  },
  // Google Workspace MCP servers and their scopes: https://developers.google.com/workspace/guides/configure-mcp-servers
  {
    id: 'google-docs', name: 'Google Docs', icon: 'doc', category: 'files',
    description: 'Read and edit your documents.',
    url: 'https://docsmcp.googleapis.com/mcp/v1',
    ...google(['drive.readonly', 'drive.file', 'documents.readonly', 'documents']),
  },
  {
    id: 'google-sheets', name: 'Google Sheets', icon: 'table', category: 'files',
    description: 'Read and edit your spreadsheets.',
    url: 'https://sheetsmcp.googleapis.com/mcp/v1',
    ...google(['drive.readonly', 'drive.file', 'spreadsheets.readonly', 'spreadsheets']),
  },
  // People API MCP (same guide): contacts.readonly + userinfo.profile; directory.readonly is Workspace-only, left out.
  {
    id: 'google-contacts', name: 'Google Contacts', icon: 'contacts', category: 'productivity',
    description: 'Look up people in your contacts.',
    url: 'https://people.googleapis.com/mcp/v1',
    ...google(['contacts.readonly', 'userinfo.profile']),
  },
  // Maps Grounding Lite MCP with this deployment's key (GOOGLE_MAPS_API_KEY; no user sign-in, no user data):
  // https://developers.google.com/maps/ai/grounding-lite
  {
    id: 'google-maps', name: 'Google Maps', icon: 'map', category: 'travel',
    description: 'Find places, check the weather and get travel times.',
    url: keyedUrl('google-maps'),
    platformKey: true,
  },
  // Hosted here on the Google Tasks API (no Google-run MCP server): https://developers.google.com/workspace/tasks
  {
    id: 'google-tasks', name: 'Google Tasks', icon: 'tasks', category: 'productivity',
    description: 'See, add and complete your to-dos.',
    ...hosted('tasks'),
  },
  // Hosted here on the YouTube Data API v3 (no Google-run MCP server): https://developers.google.com/youtube/v3
  // Public YouTube (search, charts, details, music) on this deployment's YOUTUBE_API_KEY: no sign-in, no user data.
  {
    id: 'youtube', name: 'YouTube', icon: 'video', category: 'media',
    description: 'Search videos and music, and see what is popular.',
    url: GOOGLE_MCP_PATH + 'youtube',
    platformKey: true,
  },
  // Singapore public data, hosted here (modules/sg-mcp.ts): LTA DataMall on LTA_ACCOUNT_KEY (hidden without it).
  // No sign-in, no user data: connected for everyone by default once the key is set.
  {
    id: 'sg-transport', name: 'Singapore transport', icon: 'map', category: 'travel',
    description: 'Bus arrival times, MRT disruptions, car park lots and traffic incidents in Singapore.',
    url: SG_MCP_PATH + 'sg-transport',
    platformKey: true,
  },
  // The owner's own YouTube (playlists, likes, subscriptions), OAuth. YouTube Music has no API of its own and shares these.
  {
    id: 'youtube-account', name: 'YouTube account', icon: 'video', category: 'media',
    description: 'See your playlists, liked videos and music, and subscriptions.',
    ...hosted('youtube-account'),
  },
  // Microsoft 365, hosted here on Microsoft Graph (Microsoft's Enterprise MCP has no dynamic registration): one configured
  // multi-tenant client (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET), work/school and personal accounts alike.
  {
    id: 'outlook-mail', name: 'Outlook Mail', icon: 'mail', category: 'productivity',
    description: 'Search and read your Outlook email, write drafts, reply, forward and send.',
    ...microsoft('outlook-mail'),
  },
  {
    id: 'outlook-calendar', name: 'Outlook Calendar', icon: 'calendar', category: 'productivity',
    description: 'See your Outlook calendars, events and free time, and add, change, delete or answer events.',
    ...microsoft('outlook-calendar'),
  },
  {
    id: 'microsoft-todo', name: 'Microsoft To Do', icon: 'tasks', category: 'productivity',
    description: 'See, add, change, complete and delete your To Do tasks.',
    ...microsoft('microsoft-todo'),
  },
  {
    id: 'onedrive', name: 'OneDrive', icon: 'folder', category: 'files',
    description: 'Find, read and save your OneDrive files, including Word, Excel and PowerPoint.',
    ...microsoft('onedrive'),
  },
  {
    id: 'microsoft-contacts', name: 'Outlook Contacts', icon: 'contacts', category: 'productivity',
    description: 'Look up people in your Outlook contacts, and add new ones.',
    ...microsoft('microsoft-contacts'),
  },
  {
    id: 'teams', name: 'Microsoft Teams', icon: 'contacts', category: 'productivity',
    description: 'Read your Teams chats and channel messages. Read-only. Work or school accounts only; in many organisations an admin must approve the channel permissions first.',
    ...microsoft('teams'),
    readOnly: true,
  },
  // Notion hosted MCP (OAuth): https://developers.notion.com/guides/mcp/get-started-with-mcp
  {
    id: 'notion', name: 'Notion', icon: 'notebook', category: 'productivity',
    description: 'Search and work with your Notion pages and databases.',
    url: 'https://mcp.notion.com/mcp',
  },
  // Linear MCP (OAuth 2.1 with dynamic client registration): https://linear.app/docs/mcp
  {
    id: 'linear', name: 'Linear', icon: 'issues', category: 'projects',
    description: 'Look up and manage issues and projects.',
    url: 'https://mcp.linear.app/mcp',
  },
  // Asana MCP v2 (OAuth): https://developers.asana.com/docs/using-asanas-mcp-server
  {
    id: 'asana', name: 'Asana', icon: 'tasks', category: 'projects',
    description: 'Look up and manage tasks and projects.',
    url: 'https://mcp.asana.com/v2/mcp',
  },
  // Atlassian Rovo MCP (OAuth 2.1): https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/
  {
    id: 'atlassian', name: 'Atlassian', icon: 'jira', category: 'projects',
    description: 'Jira and Confluence: search, read and update work.',
    url: 'https://mcp.atlassian.com/v2/mcp',
  },
  // Stripe MCP (OAuth): https://docs.stripe.com/mcp
  {
    id: 'stripe', name: 'Stripe', icon: 'payments', category: 'finance',
    description: 'Look up customers, payments and invoices, and make changes in your Stripe account.',
    url: 'https://mcp.stripe.com',
    // Documented tools (https://docs.stripe.com/mcp#tools): stripe_api_write runs any POST/PATCH/PUT/DELETE, and the Treasury tools move money.
    toolAccess: { stripe_api_write: 'change', send_money: 'change', transfer_money: 'change', convert_currency: 'change', setup_recipient: 'change', atlas_company_formation: 'change' },
  },
  // Calendly's own MCP (OAuth 2.1 + PKCE S256, dynamic client registration; scopes mcp:scheduling:read / :write): https://developer.calendly.com/calendly-mcp-server
  // Discovery checked 2026-10-29: protected resource https://mcp.calendly.com/ -> AS https://calendly.com/ with registration_endpoint. The vendor does not publish tool names, so the server's own annotations decide read versus change.
  {
    id: 'calendly', name: 'Calendly', icon: 'calendar', category: 'productivity',
    description: 'See your event types and bookings, find open times and manage scheduling.',
    url: 'https://mcp.calendly.com',
  },
  // Todoist's own MCP (Doist/todoist-mcp README: https://github.com/Doist/todoist-mcp; OAuth). Discovery checked 2026-10-29: the protected resource https://ai.todoist.net/mcp
  // names https://todoist.com, whose metadata has a registration_endpoint and S256. Read tools are the repo's find-*, get-*, fetch, search and list-* tools (src/tools); everything else asks.
  {
    id: 'todoist', name: 'Todoist', icon: 'tasks', category: 'productivity',
    description: 'See, add, change and complete your Todoist tasks and projects.',
    url: 'https://ai.todoist.net/mcp',
    toolAccess: readTools(['find-tasks','find-tasks-by-date', 'find-completed-tasks', 'find-projects', 'find-sections', 'find-labels', 'find-filters', 'find-comments', 'find-reminders', 'find-activity', 'find-project-collaborators', 'get-overview', 'get-productivity-stats', 'get-project-health', 'get-project-activity-stats', 'get-workspace-insights', 'list-workspaces', 'analyze-project-health', 'fetch', 'fetch-object', 'search', 'user-info']),
  },
  // Dropbox's remote MCP (beta, https://help.dropbox.com/integrations/connect-dropbox-mcp-server): dynamic registration works only for a trusted list of clients
  // (Claude, ChatGPT, Cursor); we are not on it, so the owner registers a Dropbox app and sets DROPBOX_CLIENT_ID / DROPBOX_CLIENT_SECRET. Hidden-as-unavailable until then.
  // Protected resource https://mcp.dropbox.com/mcp -> AS https://www.dropbox.com (S256). The read tool names are the help page's (wire casing not verified; an unnamed tool asks).
  {
    id: 'dropbox', name: 'Dropbox', icon: 'folder', category: 'files',
    description: 'Find and read your Dropbox files, and create, copy and move them.',
    url: 'https://mcp.dropbox.com/mcp',
    configuredClientIssuer: 'https://www.dropbox.com',
    scopes: ['account_info.read', 'files.metadata.read', 'files.content.read', 'files.metadata.write', 'files.content.write'],
    toolAccess: readTools(['ListFolder','GetFileMetadata', 'GetFileContent', 'Search', 'GetUsageAndQuota', 'WhoAmI', 'CheckJobStatus', 'DownloadLink', 'ListSharedLinks', 'GetSharedLinkMetadata', 'GetFileRequest', 'ListFileRequests', 'ListFileRevisions', 'ListRestoreEvents', 'GetTranscript', 'GetMarkdown']),
  },
  // Strava's own MCP (June 2026; OAuth, read-only, Strava subscribers only): https://support.strava.com/hc/en-us/articles/46190267796237-Strava-MCP-Connector
  // Strava's API terms forbid third-party MCP servers over its REST API, so this is the only way in. It has dynamic
  // registration, but only for a few known clients' redirect URIs (ours is refused), so the client is registered by
  // hand and configured (STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET); the issuer is the one the protected-resource
  // metadata names, https://www.strava.com/mcp-issuer.
  {
    id: 'strava', name: 'Strava', icon: 'fitness', category: 'health',
    description: 'See your runs, rides and training. Read-only; needs a Strava subscription.',
    url: 'https://mcp.strava.com/mcp',
    configuredClientIssuer: 'https://www.strava.com/mcp-issuer',
    scopes: ['activity:read_all', 'profile:read_all'],
    revocationEndpoint: 'https://www.strava.com/oauth/mcp/revoke',
    readOnly: true,
  },
  // Hevy has no MCP server of its own: hosted here on its public API (https://api.hevyapp.com/docs, Hevy Pro), called with
  // the owner's own API key (modules/hevy-mcp.ts).
  {
    id: 'hevy', name: 'Hevy', icon: 'fitness', category: 'health',
    description: 'See your logged workouts and routines, and log new workouts. Needs Hevy Pro and your API key.',
    url: HEVY_MCP_PATH,
    auth: 'api_key',
    userConfig: { api_key: { type: 'string', title: 'Hevy API key', description: 'Your Hevy Pro API key. Find it at https://hevy.com/settings?developer', required: true, sensitive: true } },
    headers: { [HEVY_KEY_HEADER]: '${user_config.api_key}' },
    probe: { tool: 'workout_count' },
  },
  // Zapier MCP (Streamable HTTP, OAuth sign-in): https://docs.zapier.com/mcp/overview/how-connections-work
  {
    id: 'zapier', name: 'Zapier', icon: 'automation', category: 'automation',
    description: 'Run the actions of the apps linked to your Zapier account.',
    url: 'https://mcp.zapier.com/api/v1/connect',
  },
  // Salesforce hosted MCP (generally available 2026): per-user OAuth 2.0 + PKCE against an External Client App the org's Salesforce admin creates first
  // (the overview says hosted servers are "intended only for customers with Flex Credits", usage may be billed:
  // https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/hosted-mcp-servers-overview.html), scope `mcp_api` (+ `refresh_token`). We list only the
  // read-only server, `platform/sobject-reads`. Checked 2026-10-29 against the server itself: https://api.salesforce.com/.well-known/oauth-protected-resource/platform/mcp/v1/platform/sobject-reads
  // names resource = the URL below, authorization server https://login.salesforce.com, scopes_supported [mcp_api, refresh_token]; its OIDC metadata has S256 and a registration_endpoint,
  // but the hosted servers take the admin's own External Client App, so the client is ours (SALESFORCE_CLIENT_ID / SALESFORCE_CLIENT_SECRET), not dynamic registration.
  // Sandbox orgs use /v1/sandbox/ and their own login host: not listed.
  {
    id: 'salesforce', name: 'Salesforce', icon: 'contacts', category: 'productivity',
    description: 'Look up accounts, contacts, leads and deals in your Salesforce org. Read-only. Your org needs Salesforce Flex Credits (usage may be billed), and your Salesforce admin must create an External Client App for Juno first.',
    url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-reads',
    configuredClientIssuer: 'https://login.salesforce.com',
    scopes: ['mcp_api', 'refresh_token'],
    clientIdName: 'SALESFORCE_CLIENT_ID',
    clientSecretName: 'SALESFORCE_CLIENT_SECRET',
    oauthClient: 'provided',
    readOnly: true,
  },
  // Long tail through Composio (BACKEND 10.18.3): Composio holds the login. Neither toolkit has a Composio-managed OAuth app (docs.composio.dev/toolkits/spotify and
  // /toolkits/shopify say so), so each needs our own OAuth app registered as a Composio auth config: its id in COMPOSIO_AUTH_CONFIG_SPOTIFY / COMPOSIO_AUTH_CONFIG_SHOPIFY, else the row is not offered.
  {
    id: 'spotify', name: 'Spotify', icon: 'video', category: 'media',
    description: 'See your playlists and listening, control playback and edit playlists. Your Spotify login is held by Composio.',
    url: '', source: 'composio', toolkit: 'spotify',
  },
  {
    id: 'shopify-admin', name: 'Shopify (store admin)', icon: 'payments', category: 'finance',
    description: 'Manage your own Shopify store: products, orders, inventory and customers. Your Shopify login is held by Composio.',
    url: '', source: 'composio', toolkit: 'shopify',
  },
];

/**
 * What each built-in app does, by capability tag (modules/apps/provides.ts). Written from what its tools really do: Gmail's tools write drafts but
 * cannot send, so it provides `mail.draft` and not `mail.send`; Outlook Mail has a send tool. A tag is only ever claimed for a tool that exists.
 */
const BUILTIN_PROVIDES: Readonly<Record<string, readonly string[]>> = {
  gmail: ['mail.read', 'mail.draft', 'mail.send'],
  'google-calendar': ['calendar.read', 'calendar.write'],
  'google-drive': ['files.read', 'files.write'],
  'google-docs': ['docs.read', 'docs.write'],
  'google-sheets': ['sheets.read', 'sheets.write'],
  'google-contacts': ['contacts.read'],
  'google-maps': ['maps.read'],
  'google-tasks': ['tasks.read', 'tasks.write'],
  youtube: ['video.search'],
  'sg-transport': ['transport.read'],
  'youtube-account': ['video.library'],
  'outlook-mail': ['mail.read', 'mail.draft', 'mail.send'],
  'outlook-calendar': ['calendar.read', 'calendar.write'],
  'microsoft-todo': ['tasks.read', 'tasks.write'],
  onedrive: ['files.read', 'files.write', 'docs.read'],
  'microsoft-contacts': ['contacts.read', 'contacts.write'],
  teams: ['chat.read'],
  notion: ['notes.read', 'notes.write'],
  linear: ['projects.read', 'projects.write'],
  asana: ['tasks.read', 'tasks.write', 'projects.read', 'projects.write'],
  atlassian: ['projects.read', 'projects.write', 'docs.read', 'docs.write'],
  stripe: ['payments.read', 'payments.write'],
  calendly: ['calendar.read', 'calendar.write'],
  todoist: ['tasks.read', 'tasks.write', 'projects.read', 'projects.write'],
  dropbox: ['files.read', 'files.write'],
  strava: ['fitness.read'],
  hevy: ['fitness.read', 'fitness.write'],
  zapier: ['automation.run'],
  salesforce: ['crm.read'],
  spotify: ['music.read', 'music.write'],
  'shopify-admin': ['shop.read', 'shop.write'],
};

export const BUILTIN_CATALOG_ENTRIES: readonly CatalogEntry[] = BUILTIN_ENTRIES.map((entry) => {
  const provides = BUILTIN_PROVIDES[entry.id];
  return provides === undefined ? entry : { ...entry, provides };
});


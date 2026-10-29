/**
 * Mock `/v1/apps*`: a small catalog with the same rules and error codes as the backend routes (BACKEND.md §10.18).
 * A work app is added once and is then on for every agent (no row = on, changes ask first); a chat app is installed into a
 * workspace and an agent is switched on per workspace.
 */
import type { ActionsPolicy, App, AppDetail, AppsApi, AppWorkspaceAgent, CustomAppConfirm, InstallAppResponse, ProbeCustomAppResponse } from '@agent-desktop/client';
import { apiError } from './util.js';

type Seed = {
  id: string;
  name: string;
  category: App['category'];
  /** Where the login and tools come from; official when absent. */
  source?: App['source'];
  group?: App['group'];
  icon: string;
  blurb: string;
  description: string;
  tryAsking: string[];
  auth: App['auth'];
  available?: boolean;
  grants?: App['grants'];
  userConfig?: App['userConfig'];
  capabilities: AppDetail['capabilities'];
  developerName?: string;
  privacyPolicyUrl?: string;
};

const read = (name: string, title: string) => ({ name, title, kind: 'read' as const });
const change = (name: string, title: string, needsReview = false) => ({ name, title, kind: 'change' as const, ...(needsReview ? { needsReview } : {}) });

const SEEDS: Seed[] = [
  {
    id: 'slack', name: 'Slack', category: 'chat', icon: 'slack', auth: 'bot_install', grants: { chatRead: true, actions: false },
    blurb: 'Talk to your agents in channels and DMs',
    description: 'Bring your agents into Slack. People @mention them in channels and DMs; they read the conversation and files shared there and reply in threads.',
    tryAsking: ['@Juno what did we decide on pricing?', '@Juno summarize #product today'],
    capabilities: [read('reply', 'Reply'), read('history', 'Read earlier messages of a chat'), read('files_receive', 'Receive files'), change('files_send', 'Send files'), change('react', 'React to messages'), change('buttons', 'Show buttons to answer')],
    developerName: 'Juno', privacyPolicyUrl: 'https://juno.example.test/privacy',
  },
  {
    id: 'discord', name: 'Discord', category: 'chat', icon: 'discord', auth: 'bot_install', grants: { chatRead: true, actions: false },
    blurb: 'Your agents in your servers',
    description: 'Add the Juno bot to a Discord server. Each agent gets its own role people can @-mention.',
    tryAsking: ['@Juno what did I miss today?'],
    capabilities: [read('reply', 'Reply and read history')],
    developerName: 'Juno',
  },
  {
    id: 'telegram', name: 'Telegram', category: 'chat', icon: 'telegram', auth: 'bot_install', grants: { chatRead: true, actions: false },
    blurb: 'A Telegram bot for an agent',
    description: 'Juno makes a Telegram bot for an agent. You confirm it once in Telegram.',
    tryAsking: [],
    capabilities: [read('reply', 'Reply and read history')],
    developerName: 'Juno',
  },
  {
    id: 'gmail', name: 'Gmail', category: 'work', group: 'productivity', icon: 'mail', auth: 'oauth',
    blurb: 'Read and draft · asks before sending',
    description: 'Search and read your email, and draft messages. Sending asks you first.',
    tryAsking: ['Summarise my unread email', 'Draft a reply to the last message from Sam'],
    capabilities: [read('search_messages', 'Search your email'), read('read_message', 'Read a message'), change('send_message', 'Send an email'), change('create_draft', 'Create a draft', true)],
    developerName: 'Google', privacyPolicyUrl: 'https://policies.google.com/privacy',
  },
  {
    id: 'google-calendar', name: 'Google Calendar', category: 'work', group: 'productivity', icon: 'calendar', auth: 'oauth',
    blurb: 'See and plan your days',
    description: 'See your calendars, events and free time.',
    tryAsking: ['What is on my calendar tomorrow?'],
    capabilities: [read('list_events', 'See your events'), change('create_event', 'Create events')],
    developerName: 'Google',
  },
  {
    id: 'notion', name: 'Notion', category: 'work', group: 'productivity', icon: 'notebook', auth: 'oauth',
    blurb: 'Search and work with your pages',
    description: 'Search and work with your Notion pages and databases.',
    tryAsking: ['Find my notes about the launch'],
    capabilities: [read('search', 'Search pages'), change('create_page', 'Create pages')],
    developerName: 'Notion',
  },
  {
    id: 'hevy', name: 'Hevy', category: 'work', group: 'health', icon: 'automation', auth: 'api_key',
    blurb: 'Read your workouts and routines',
    description: 'Read your workouts and routines from Hevy.',
    tryAsking: ['What did I lift last week?'],
    userConfig: [{ key: 'api_key', type: 'string', title: 'Hevy API key', description: 'Settings, Developer in the Hevy app', required: true, sensitive: true }],
    capabilities: [read('list_workouts', 'See your workouts')],
    developerName: 'Hevy',
  },
  {
    id: 'spotify', name: 'Spotify', category: 'work', source: 'composio', group: 'media', icon: 'video', auth: 'oauth',
    blurb: 'Your playlists and what is playing',
    description: 'Read your playlists and what is playing, and queue songs. The login is held by Composio.',
    tryAsking: ['What was I listening to this morning?'],
    capabilities: [read('get_playlists', 'See your playlists'), change('add_to_queue', 'Queue a song')],
    developerName: 'Spotify',
  },
  {
    id: 'salesforce', name: 'Salesforce', category: 'work', group: 'productivity', icon: 'contacts', auth: 'oauth', available: false,
    blurb: 'Look up accounts and contacts (read only)',
    description: 'Read your Salesforce records. Needs a Salesforce plan with Flex Credits, and your Salesforce admin has to create an External Client App for Juno first.',
    tryAsking: ['Find the account owner for Acme'],
    capabilities: [read('query', 'Look up records')],
    developerName: 'Salesforce',
  },
  {
    id: 'weather', name: 'Weather', category: 'work', group: 'travel', icon: 'map', auth: 'none',
    blurb: 'Forecasts for any place',
    description: 'Forecasts for any place. Needs no sign-in.',
    tryAsking: [],
    capabilities: [read('forecast', 'Get a forecast')],
  },
  {
    id: 'youtube-videos', name: 'YouTube videos', category: 'web', icon: 'video', auth: 'none', grants: { chatRead: true, actions: false },
    blurb: 'Read video transcripts',
    description: 'Let your agents read the transcript and details of a public YouTube video.',
    tryAsking: ['Summarise this YouTube video for me'],
    capabilities: [],
  },
  {
    id: 'xiaohongshu', name: 'Xiaohongshu', category: 'web', icon: 'video', auth: 'sandbox_login', available: false,
    blurb: 'Read notes and comments',
    description: 'Let your agents read notes and comments. You sign in yourself in the agent\'s own browser.',
    tryAsking: ['Find 3 low-sugar breakfast ideas'],
    capabilities: [read('search_notes', 'Search notes and read comments')],
  },
];

export interface AppsMockOptions {
  delay: () => Promise<void>;
  newId: () => string;
  now: () => number;
  /** The owner's agents (ids), read at call time: a new work app is on for all of them. */
  agentIds: () => string[];
}

/** The apps API over a small in-memory catalog; a few apps start added so the page has something to show. */
export function createAppsMock(opts: AppsMockOptions): AppsApi {
  const iso = (): string => new Date(opts.now()).toISOString();
  const apps = new Map<string, AppDetail>(
    SEEDS.map((seed) => {
      const detail: AppDetail = {
        id: seed.id,
        name: seed.name,
        category: seed.category,
        source: seed.source ?? 'official',
        ...(seed.group ? { group: seed.group } : {}),
        icon: seed.icon,
        blurb: seed.blurb,
        description: seed.description,
        tryAsking: seed.tryAsking,
        auth: seed.auth,
        available: seed.available ?? true,
        ...(seed.category === 'chat' ? { workspaceInstall: true } : {}),
        userConfig: seed.userConfig ?? [],
        version: 1,
        ...(seed.developerName ? { developerName: seed.developerName } : {}),
        ...(seed.privacyPolicyUrl ? { privacyPolicyUrl: seed.privacyPolicyUrl } : {}),
        grants: seed.grants ?? { chatRead: true, actions: true },
        installations: [],
        enabledAgents: [],
        capabilities: seed.capabilities,
        pending: [],
        skills: [],
      };
      return [seed.id, detail];
    }),
  );
  const find = (id: string): AppDetail => {
    const found = apps.get(id);
    if (!found) throw apiError(404, 'APP_NOT_FOUND', 'No such app');
    return found;
  };
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const addWork = (app: AppDetail, label: string, status: 'connected' | 'expired' = 'connected'): void => {
    app.installations.push({ id: opts.newId(), appId: app.id, label, status, connectedAt: iso(), agents: [] });
    if (app.enabledAgents.length === 0) app.enabledAgents = opts.agentIds().map((agentId) => ({ agentId, actionsPolicy: 'ask' as ActionsPolicy }));
  };

  // Added at the start: Slack in one workspace, Gmail, and a Calendar whose sign-in has expired.
  const slack = find('slack');
  const first = opts.agentIds()[0];
  slack.installations.push({ id: 'inst-slack-1', appId: 'slack', label: 'Acme Lab', status: 'connected', connectedAt: iso(), bound: true, agents: first ? [{ agentId: first, handle: 'juno' }] : [] });
  addWork(find('gmail'), 'robin@example.com');
  addWork(find('google-calendar'), 'robin@example.com', 'expired');
  addWork(find('weather'), 'Weather');

  const summary = (app: AppDetail): App => {
    const { capabilities: _capabilities, pending: _pending, skills: _skills, ...plain } = copy(app);
    return plain;
  };

  /** What the backend's probe would say: an address with "key" wants a key, with "oauth" signs in, anything else answers without a login and lists its tools. */
  const probe = (url: string): ProbeCustomAppResponse => {
    if (!/^https?:\/\//.test(url)) throw apiError(400, 'VALIDATION', 'Enter the server address, starting with https://');
    if (url.includes('key')) return { url, auth: 'api_key', usable: false, problem: 'This server wants an API key, which a custom app cannot take yet.' };
    if (url.includes('oauth')) return { url, auth: 'oauth', usable: true, oauth: { issuer: new URL(url).origin, scopes: ['read', 'write'], client: 'dcr' } };
    return {
      url,
      auth: 'none',
      usable: true,
      tools: [
        { name: 'search_docs', title: 'Search docs', suggested: 'read', basis: 'annotation' },
        { name: 'get_page', title: 'Get a page', suggested: 'read', basis: 'annotation' },
        { name: 'create_page', title: 'Create a page', suggested: 'change', basis: 'annotation' },
        { name: 'sync', title: 'Sync', suggested: 'change', basis: 'unmarked' },
      ],
    };
  };
  const installCustom = (input: { name?: string; url?: string; confirm?: CustomAppConfirm }): InstallAppResponse => {
    if (input.url !== undefined) {
      if (input.confirm === undefined) throw apiError(400, 'CUSTOM_PROBE_REQUIRED', 'Check the server first, then confirm what it asks for.');
      const now = probe(input.url);
      if (!now.usable) throw apiError(400, 'CUSTOM_NOT_USABLE', now.problem ?? 'This server cannot be added.');
      if (now.auth !== input.confirm.auth) throw apiError(409, 'CUSTOM_PROBE_CHANGED', 'The server now asks for something different. Check it again.');
    }
    const id = opts.newId();
    const name = input.name ?? 'Custom app';
    const detail: AppDetail = {
      id, name, category: 'custom', source: 'custom', icon: 'automation', blurb: input.url ?? 'A custom server', description: `A custom server you added: ${input.url ?? name}.`,
      tryAsking: [], auth: input.confirm?.auth === 'oauth' ? 'oauth' : 'none', available: true, userConfig: [], version: 1, grants: { chatRead: true, actions: true },
      installations: [], enabledAgents: [],
      capabilities: Object.entries(input.confirm?.tools ?? {}).map(([toolName, kind]) => ({ name: toolName, title: toolName, kind })),
      pending: [], skills: [],
    };
    apps.set(id, detail);
    addWork(detail, name);
    const installation = detail.installations[0] ?? null;
    return { appId: id, installation: installation ? copy(installation) : null, pending: null, openUrl: input.confirm?.auth === 'oauth' ? `https://accounts.example.test/auth?app=${id}` : null };
  };

  return {
    async list() {
      await opts.delay();
      return [...apps.values()].map(summary);
    },
    async get(id) {
      await opts.delay();
      return copy(find(id));
    },
    async probeCustom(url) {
      await opts.delay();
      return probe(url);
    },
    async install(id, input = {}): Promise<InstallAppResponse> {
      await opts.delay();
      if (id === 'custom') return installCustom(input as { name?: string; url?: string; confirm?: CustomAppConfirm; connectionId?: string });
      const app = find(id);
      if (!app.available) throw apiError(400, 'APP_NOT_SUPPORTED_YET', 'This app cannot be added yet');
      const body = input as { userConfig?: Record<string, string | number | boolean>; connectionId?: string; mode?: string; agentId?: string };
      if (app.category === 'chat') {
        const installation = { id: opts.newId(), appId: id, label: 'New workspace', status: 'connected' as const, connectedAt: iso(), agents: [] as AppWorkspaceAgent[] };
        app.installations.push(installation);
        return { appId: id, installation: copy(installation), pending: null, openUrl: `https://${id}.example.test/install` };
      }
      const given = body.userConfig ?? {};
      for (const field of app.userConfig) {
        if (field.required && (given[field.key] === undefined || given[field.key] === '')) {
          throw apiError(400, 'CONNECTOR_CONFIG_REQUIRED', `${field.title} is required`);
        }
      }
      for (const key of Object.keys(given)) {
        if (!app.userConfig.some((field) => field.key === key)) throw apiError(400, 'CONNECTOR_CONFIG_UNKNOWN', `Unknown value ${key}`);
      }
      // A key app is only connected once a read-only probe call succeeds with the value (BACKEND 10.18.1).
      if (app.auth === 'api_key' && given.api_key === 'bad-key') {
        throw apiError(400, 'CONNECTOR_PROBE_FAILED', `Could not connect ${app.name}: the server rejected the key (HTTP 401). Check the value and try again.`);
      }
      if (body.connectionId) {
        const again = app.installations.find((entry) => entry.id === body.connectionId);
        if (again) again.status = 'connected';
        return { appId: id, installation: again ? copy(again) : null, pending: null, openUrl: app.auth === 'oauth' ? `https://accounts.example.test/auth?app=${id}` : null };
      }
      addWork(app, app.installations.length === 0 ? 'robin@example.com' : `account ${app.installations.length + 1}`);
      const installation = app.installations[app.installations.length - 1] ?? null;
      return { appId: id, installation: installation ? copy(installation) : null, pending: null, openUrl: app.auth === 'oauth' ? `https://accounts.example.test/auth?app=${id}` : null };
    },
    async removeInstallation(id, installationId) {
      await opts.delay();
      const app = find(id);
      app.installations = app.installations.filter((entry) => entry.id !== installationId);
      if (app.category !== 'chat' && app.installations.length === 0) app.enabledAgents = [];
    },
    async reviewTools(id, input) {
      await opts.delay();
      const app = find(id);
      const reviewed: string[] = [];
      for (const capability of app.capabilities) {
        if (capability.needsReview !== true || (input?.tools !== undefined && !input.tools.includes(capability.name))) continue;
        delete capability.needsReview;
        reviewed.push(capability.name);
      }
      return { reviewed };
    },
    async setAgentApp(agentId, appId, input) {
      await opts.delay();
      const app = find(appId);
      if (app.category === 'chat') throw apiError(400, 'CHAT_APP', 'A chat app is turned on per workspace');
      if (app.installations.length === 0) throw apiError(409, 'APP_NOT_ADDED', 'Add the app first');
      const current = app.enabledAgents.find((entry) => entry.agentId === agentId);
      const actionsPolicy: ActionsPolicy = input.actionsPolicy ?? current?.actionsPolicy ?? 'ask';
      app.enabledAgents = app.enabledAgents.filter((entry) => entry.agentId !== agentId);
      if (input.enabled) app.enabledAgents.push({ agentId, actionsPolicy });
      return { agentId, appId, enabled: input.enabled, actionsPolicy };
    },
    async setWorkspaceAgent(id, installationId, agentId, input) {
      await opts.delay();
      const installation = find(id).installations.find((entry) => entry.id === installationId);
      if (!installation) throw apiError(404, 'NOT_FOUND', 'No such workspace');
      installation.agents = installation.agents.filter((entry) => entry.agentId !== agentId);
      if (input.enabled) installation.agents.push({ agentId, handle: agentId.replace(/^agent-/, '') });
      return copy(installation.agents);
    },
  };
}

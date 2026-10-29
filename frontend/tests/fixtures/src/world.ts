import type {
  AppSettings,
  Agent,
  AuditEntry,
  Computer,
  Conversation,
  Item,
  ArtifactVersion,
  LibraryItem,
  MemoryClaim,
  Plan,
  Plugin,
  PluginCategory,
  PluginTool,
  Request,
  Routine,
  RoutineRun,
  Rule,
  Run,
  SecretMetadata,
  Skill,
  Step,
  StepKind,
  ToolPermission,
  Usage,
} from '@agent-desktop/client';
import { emptyState, type MockState } from './state.js';
import { iso } from './util.js';

/** The one computer every agent shares (one screen). */
export const SHARED_COMPUTER_ID = 'computer-shared';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The default world (ARCHITECTURE 修订 v0.4): six named agents plus one freshly
// created blank agent, and two group chats. Each agent has its own computer
// (one VM, auto-pause when idle). Agents are created by the user and behave like chat contacts.
const NAMED_AGENT_IDS = ['agent-juno', 'agent-patch', 'agent-ledger', 'agent-echo', 'agent-scout', 'agent-atlas'] as const;
const ALL_AGENT_IDS = [...NAMED_AGENT_IDS, 'agent-new'] as const;

// --- small builders ---------------------------------------------------------

const mkStep = (
  runId: string,
  index: number,
  kind: StepKind,
  verb: string,
  target: string,
  startedAtMs: number,
  extra: Partial<Pick<Step, 'screenshotRef' | 'input' | 'output' | 'status' | 'durationMs'>> = {},
): Step => ({
  id: `step-${runId}-${index}`,
  runId,
  index,
  kind,
  verb,
  target,
  screenshotRef: extra.screenshotRef,
  input: extra.input,
  output: extra.output,
  status: extra.status ?? 'completed',
  startedAt: iso(startedAtMs),
  durationMs: extra.durationMs ?? 1400 + index * 350,
});

const genericSteps = (
  runId: string,
  startMs: number,
  entries: ReadonlyArray<readonly [StepKind, string, string]>,
): Step[] => entries.map(([kind, verb, target], i) => mkStep(runId, i, kind, verb, target, startMs + i * 38_000));

const mkRoutineRun = (
  id: string,
  routineId: string,
  status: RoutineRun['status'],
  summary: string,
  startedAtMs: number,
  durationMs: number,
  runId?: string,
): RoutineRun => ({
  id,
  routineId,
  status,
  summary,
  runId,
  startedAt: iso(startedAtMs),
  finishedAt: iso(startedAtMs + durationMs),
  durationMs,
});

const tool = (pluginId: string, name: string, description: string, permission: ToolPermission): PluginTool => ({
  id: `${pluginId}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  pluginId,
  name,
  description,
  permission,
});

interface PluginSeed {
  id: string;
  name: string;
  publisher: string;
  category: PluginCategory;
  description: string;
  icon: string;
  installed?: boolean;
  featured?: boolean;
  tools: ReadonlyArray<readonly [string, string, ToolPermission]>;
}

const buildPlugin = (seed: PluginSeed, usedBy: string[]): Plugin => ({
  id: seed.id,
  name: seed.name,
  publisher: seed.publisher,
  category: seed.category,
  description: seed.description,
  icon: seed.icon,
  installed: seed.installed ?? false,
  featured: seed.featured ?? false,
  tools: seed.tools.map(([name, description, permission]) => tool(seed.id, name, description, permission)),
  accounts: [],
  usedByAgentIds: usedBy,
});

// --- conversation sidebar meta ---------------------------------------------

/** One-line preview of an item for the chat list (v0.3). */
export function previewOfItem(item: Item, runs: readonly Run[] = []): string {
  switch (item.type) {
    case 'user_message':
      return item.text;
    case 'agent_message':
      return item.markdown.split('\n')[0] ?? item.markdown;
    case 'run': {
      const run = runs.find((r) => r.id === item.runId);
      if (!run) return 'Working…';
      return run.status === 'running' ? `Working · ${run.title}` : run.title;
    }
    case 'plan':
      return 'Shared a plan';
    case 'request':
      return 'Waiting on your decision';
    case 'artifact':
      return 'Shared a file';
    case 'routine':
      return item.change === 'created' ? 'Created a routine' : 'Updated a routine';
    case 'handoff':
      return item.direction === 'to_user' ? 'Handed control to you' : 'Took back control';
    case 'system':
      return item.text;
    case 'role_suggestion':
      return 'Suggested a role: ' + item.title;
    case 'feed_ref':
      return 'Posted to Feed: ' + item.title;
  }
}

/** Recompute the sidebar-facing fields (preview, last activity, pending count) for one conversation. */
export function refreshConversation(state: MockState, conversationId: string): void {
  const conv = state.conversations.find((c) => c.id === conversationId);
  if (!conv) return;
  const rows = state.items.get(conversationId) ?? [];
  const last = rows[rows.length - 1];
  if (last) {
    conv.lastItemAt = last.at;
    conv.lastMessagePreview = previewOfItem(last, state.runs);
  }
  conv.needsYou = state.requests.filter((r) => r.conversationId === conversationId && r.status === 'pending').length;

  // Mirror the sidebar-facing fields onto the participating agents.
  for (const agentId of conv.agentIds) {
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent) continue;
    agent.lastActivityAt = conv.lastItemAt;
    agent.needsYou = state.requests.filter((r) => r.agentId === agentId && r.status === 'pending').length;
  }
}

// ---------------------------------------------------------------------------

export function buildWorld(nowMs: number, _seed = 1): MockState {
  const state = emptyState();
  const ago = (minutes: number): string => iso(nowMs - minutes * MINUTE);
  const ahead = (minutes: number): string => iso(nowMs + minutes * MINUTE);
  const agoMs = (minutes: number): number => nowMs - minutes * MINUTE;

  // --- people ---------------------------------------------------------------
  const robin = 'member-robin';
  const priya = 'member-priya';

  // --- skills --------------------------------------------------------------
  // A skill is its definition plus the active version (contracts 0.61.0); every seed starts at version 1.
  const skillSeed = (id: string, name: string, description: string, instructions: string, used: number, ageMinutes: number): Skill => {
    const createdAt = ago(ageMinutes);
    return {
      id,
      scope: 'owner',
      agentId: null,
      createdAt,
      active: {
        id: `${id}-v1`,
        skillId: id,
        version: 1,
        status: 'active',
        name,
        description,
        instructions,
        deps: [],
        origin: 'manual',
        used,
        helpful: 0,
        harmful: 0,
        lastUsedAt: null,
        createdAt,
      },
    };
  };
  const skills: Skill[] = [
    skillSeed('skill-inbox-triage', 'Inbox triage', 'Sort new mail into Action, Waiting, and Read, then draft replies for the Action pile.', 'Group by sender importance, flag anything from a customer, never archive without a label.', 184, 60 * 24 * 90),
    skillSeed('skill-pr-review', 'PR review', 'Read a pull request, run the test suite, and leave a structured review.', 'Check correctness first, then tests, then naming. Summarize blocking vs nit.', 61, 60 * 24 * 75),
    skillSeed('skill-invoice-recon', 'Invoice reconciliation', 'Match Stripe charges against receipts and flag anything without a document.', 'Tolerate a 1% amount drift, always attach the receipt id to the ledger row.', 12, 60 * 24 * 40),
    skillSeed('skill-meeting-notes', 'Meeting notes', 'Turn a recording into decisions, owners and follow-ups in Notion.', 'One decision per bullet, name the owner, link the doc.', 96, 60 * 24 * 60),
    skillSeed('skill-release-notes', 'Release notes', 'Summarize merged commits into user-facing release notes.', 'Lead with user impact, group by area, link the PRs.', 33, 60 * 24 * 55),
    skillSeed('skill-standup-draft', 'Standup draft', 'Collect yesterday’s activity into a three-line standup update.', 'Yesterday, today, blockers — one line each.', 47, 60 * 24 * 30),
    skillSeed('skill-candidate-outreach', 'Candidate outreach', 'Find candidates for a role and draft a warm, specific first message.', 'Reference one concrete project, keep it under 90 words, never mass-send.', 28, 60 * 24 * 48),
    skillSeed('skill-trip-planning', 'Trip planning', 'Turn a destination and a window into a venue, travel and budget plan.', 'Always price two travel options and check the team’s calendar before booking.', 9, 60 * 24 * 22),
  ];
  state.skills = skills;

  // --- plugins -------------------------------------------------------------
  const pluginSeeds: PluginSeed[] = [
    {
      id: 'plugin-gmail',
      name: 'Gmail',
      publisher: 'Google',
      category: 'Productivity',
      description: 'Read, search, label and draft mail in your Gmail account.',
      icon: 'mail',
      installed: true,
      featured: true,
      tools: [
        ['search_threads', 'Search threads and messages', 'always'],
        ['get_thread', 'Read a thread', 'always'],
        ['draft_reply', 'Create a draft reply', 'always'],
        ['send_email', 'Send an email', 'ask'],
        ['archive', 'Archive or label a thread', 'ask'],
      ],
    },
    {
      id: 'plugin-google-calendar',
      name: 'Google Calendar',
      publisher: 'Google',
      category: 'Productivity',
      description: 'Check availability, create and move events.',
      icon: 'calendar',
      installed: true,
      featured: true,
      tools: [
        ['list_events', 'List upcoming events', 'always'],
        ['find_free_slot', 'Find a free slot', 'always'],
        ['create_event', 'Create an event', 'always'],
        ['move_event', 'Move or cancel an event', 'ask'],
      ],
    },
    {
      id: 'plugin-google-drive',
      name: 'Google Drive',
      publisher: 'Google',
      category: 'Productivity',
      description: 'Browse, read and upload files in Drive.',
      icon: 'hard-drive',
      installed: true,
      tools: [
        ['search_files', 'Search files', 'always'],
        ['read_file', 'Read a document', 'always'],
        ['upload_file', 'Upload a file', 'ask'],
      ],
    },
    {
      id: 'plugin-slack',
      name: 'Slack',
      publisher: 'Slack',
      category: 'Productivity',
      description: 'Read channels, post updates and answer mentions.',
      icon: 'hash',
      installed: true,
      featured: true,
      tools: [
        ['list_channels', 'List channels', 'always'],
        ['read_channel', 'Read a channel', 'always'],
        ['post_message', 'Post a message', 'ask'],
        ['upload_file', 'Upload a file', 'ask'],
      ],
    },
    {
      id: 'plugin-github',
      name: 'GitHub',
      publisher: 'GitHub',
      category: 'Engineering',
      description: 'Issues, pull requests and CI status for your repositories.',
      icon: 'github',
      installed: true,
      featured: true,
      tools: [
        ['search_code', 'Search code', 'always'],
        ['list_pull_requests', 'List pull requests', 'always'],
        ['read_checks', 'Read CI check status', 'always'],
        ['create_issue', 'Create an issue', 'ask'],
        ['merge_pull_request', 'Merge a pull request', 'ask'],
        ['push_commit', 'Push a commit', 'ask'],
      ],
    },
    {
      id: 'plugin-linear',
      name: 'Linear',
      publisher: 'Linear',
      category: 'Engineering',
      description: 'Track issues and projects in Linear.',
      icon: 'layout-list',
      installed: true,
      tools: [
        ['list_issues', 'List issues', 'always'],
        ['read_issue', 'Read an issue', 'always'],
        ['create_issue', 'Create an issue', 'ask'],
        ['update_issue', 'Update issue status', 'ask'],
      ],
    },
    {
      id: 'plugin-notion',
      name: 'Notion',
      publisher: 'Notion',
      category: 'Productivity',
      description: 'Read and write pages and databases.',
      icon: 'book-open',
      installed: true,
      tools: [
        ['search_pages', 'Search pages', 'always'],
        ['read_page', 'Read a page', 'always'],
        ['append_block', 'Append to a page', 'always'],
        ['create_page', 'Create a page', 'ask'],
      ],
    },
    {
      id: 'plugin-stripe',
      name: 'Stripe',
      publisher: 'Stripe',
      category: 'Finance',
      description: 'Invoices, charges and payout reconciliation.',
      icon: 'credit-card',
      installed: true,
      tools: [
        ['list_charges', 'List charges', 'always'],
        ['list_invoices', 'List invoices', 'always'],
        ['create_invoice', 'Create an invoice', 'ask'],
        ['refund_charge', 'Refund a charge', 'ask'],
      ],
    },
    {
      id: 'plugin-figma',
      name: 'Figma',
      publisher: 'Figma',
      category: 'Design',
      description: 'Read files, comment on frames and export assets.',
      icon: 'figma',
      tools: [
        ['list_files', 'List design files', 'always'],
        ['read_frames', 'Read frames and comments', 'always'],
        ['post_comment', 'Leave a comment', 'ask'],
      ],
    },
    {
      id: 'plugin-sentry',
      name: 'Sentry',
      publisher: 'Sentry',
      category: 'Engineering',
      description: 'Triage errors and link them to issues.',
      icon: 'alert-triangle',
      featured: true,
      tools: [
        ['list_issues', 'List error groups', 'always'],
        ['read_event', 'Read an error event', 'always'],
        ['resolve_issue', 'Resolve an error group', 'ask'],
      ],
    },
    {
      id: 'plugin-hubspot',
      name: 'HubSpot',
      publisher: 'HubSpot',
      category: 'Sales',
      description: 'Contacts, deals and pipeline updates.',
      icon: 'users',
      tools: [
        ['list_deals', 'List deals', 'always'],
        ['update_deal', 'Update a deal', 'ask'],
      ],
    },
    {
      id: 'plugin-zendesk',
      name: 'Zendesk',
      publisher: 'Zendesk',
      category: 'Support',
      description: 'Tickets, macros and customer replies.',
      icon: 'life-buoy',
      tools: [
        ['list_tickets', 'List tickets', 'always'],
        ['reply_ticket', 'Reply to a ticket', 'ask'],
      ],
    },
    {
      id: 'plugin-quickbooks',
      name: 'QuickBooks',
      publisher: 'Intuit',
      category: 'Finance',
      description: 'Bookkeeping, expenses and reports.',
      icon: 'calculator',
      tools: [
        ['list_expenses', 'List expenses', 'always'],
        ['categorize_expense', 'Categorize an expense', 'ask'],
      ],
    },
    {
      id: 'plugin-airtable',
      name: 'Airtable',
      publisher: 'Airtable',
      category: 'Data',
      description: 'Records, views and automations.',
      icon: 'table',
      tools: [
        ['list_records', 'List records', 'always'],
        ['create_record', 'Create a record', 'ask'],
      ],
    },
    {
      id: 'plugin-postgres',
      name: 'Postgres MCP',
      publisher: 'Community',
      category: 'Data',
      description: 'Query a read-only Postgres replica over MCP.',
      icon: 'database',
      tools: [
        ['query', 'Run a read-only SQL query', 'always'],
        ['describe_table', 'Describe a table', 'always'],
      ],
    },
    {
      id: 'plugin-vercel',
      name: 'Vercel',
      publisher: 'Vercel',
      category: 'Engineering',
      description: 'Deployments, logs and environment variables.',
      icon: 'triangle',
      tools: [
        ['list_deployments', 'List deployments', 'always'],
        ['read_logs', 'Read build logs', 'always'],
        ['promote_deployment', 'Promote a deployment', 'ask'],
      ],
    },
    {
      id: 'plugin-jira',
      name: 'Jira',
      publisher: 'Atlassian',
      category: 'Engineering',
      description: 'Issues, sprints and boards.',
      icon: 'kanban',
      tools: [
        ['list_issues', 'List issues', 'always'],
        ['transition_issue', 'Transition an issue', 'ask'],
      ],
    },
    {
      id: 'plugin-confluence',
      name: 'Confluence',
      publisher: 'Atlassian',
      category: 'Productivity',
      description: 'Spaces, pages and search.',
      icon: 'file-text',
      tools: [
        ['search_pages', 'Search pages', 'always'],
        ['create_page', 'Create a page', 'ask'],
      ],
    },
    {
      id: 'plugin-dropbox',
      name: 'Dropbox',
      publisher: 'Dropbox',
      category: 'Productivity',
      description: 'Files, shared links and folders.',
      icon: 'folder',
      tools: [
        ['search_files', 'Search files', 'always'],
        ['share_file', 'Create a shared link', 'ask'],
      ],
    },
    {
      id: 'plugin-intercom',
      name: 'Intercom',
      publisher: 'Intercom',
      category: 'Support',
      description: 'Conversations and customer messaging.',
      icon: 'message-circle',
      tools: [
        ['list_conversations', 'List conversations', 'always'],
        ['reply', 'Reply to a conversation', 'ask'],
      ],
    },
    {
      id: 'plugin-salesforce',
      name: 'Salesforce',
      publisher: 'Salesforce',
      category: 'Sales',
      description: 'Accounts, opportunities and reports.',
      icon: 'cloud',
      tools: [
        ['list_opportunities', 'List opportunities', 'always'],
        ['update_opportunity', 'Update an opportunity', 'ask'],
      ],
    },
    {
      id: 'plugin-metabase',
      name: 'Metabase',
      publisher: 'Metabase',
      category: 'Data',
      description: 'Saved questions, dashboards and SQL.',
      icon: 'bar-chart',
      tools: [
        ['run_question', 'Run a saved question', 'always'],
        ['run_sql', 'Run SQL against a warehouse', 'always'],
      ],
    },
    {
      id: 'plugin-pulse',
      name: 'Pulse Analytics',
      publisher: 'Pulse Labs',
      category: 'Data',
      description: 'Product analytics for funnels and retention.',
      icon: 'activity',
      tools: [
        ['list_funnels', 'List funnels', 'always'],
        ['export_cohort', 'Export a cohort', 'ask'],
      ],
    },
    {
      id: 'plugin-relay',
      name: 'Relay Notes',
      publisher: 'Relay',
      category: 'Productivity',
      description: 'Lightweight shared notes and highlights.',
      icon: 'sticky-note',
      tools: [
        ['search_notes', 'Search notes', 'always'],
        ['create_note', 'Create a note', 'always'],
      ],
    },
  ];

  // Which agents use each plugin (installed ones only).
  const pluginUsage: Record<string, string[]> = {
    'plugin-gmail': ['agent-juno', 'agent-ledger', 'agent-scout'],
    'plugin-google-calendar': ['agent-juno', 'agent-echo', 'agent-atlas'],
    'plugin-google-drive': ['agent-juno', 'agent-atlas'],
    'plugin-slack': ['agent-patch', 'agent-echo', 'agent-scout', 'agent-atlas'],
    'plugin-github': ['agent-patch'],
    'plugin-linear': ['agent-patch'],
    'plugin-notion': ['agent-juno', 'agent-echo', 'agent-scout'],
    'plugin-stripe': ['agent-ledger'],
  };

  state.plugins = pluginSeeds.map((seed) => {
    const plugin = buildPlugin(seed, seed.installed ? (pluginUsage[seed.id] ?? []) : []);
    plugin.accounts = seed.installed
      ? [{ id: `acct-${seed.id}`, label: `${seed.name} · acme`, status: 'connected', connectedAt: ago(60 * 24 * 45) }]
      : [];
    return plugin;
  });

  const installedPluginIds = state.plugins.filter((p) => p.installed).map((p) => p.id);
  const pluginIdsFor = (agentId: string): string[] =>
    installedPluginIds.filter((id) => (pluginUsage[id] ?? []).includes(agentId));

  // --- one computer, one screen, shared by every agent (owner decision 2026-10-05) ---
  const computers: Computer[] = [
    {
      id: SHARED_COMPUTER_ID,
      agentIds: [...ALL_AGENT_IDS],
      // Juno's inbox triage is the live run that is using the screen right now.
      activeAgentId: 'agent-juno',
      screens: [],
      name: 'Your computer',
      state: 'running',
      controller: 'agent',
      resources: {
        cpu: { used: 46, total: 100, unit: '%', cores: 8 },
        memory: { used: 9120, total: 16 * 1024, unit: 'MB' },
        disk: { used: 41, total: 128, unit: 'GB' },
      },
      size: { vcpu: 8, ramGb: 16, diskGb: 128 },
      idlePauseMinutes: 30,
      updateSchedule: { kind: 'window', window: 'Sun 03:00', tz: 'Asia/Singapore' },
      uptimeSeconds: Math.round(52 * 3600),
      os: 'Debian 13 · Xfce',
      resolution: '1364x1024',
      filesUrl: 'https://files.example.com/computer',
      lastUpdatedAt: ago(3),
    },
  ];
  state.computers = computers;

  // --- agents --------------------------------------------------------------
  const mkChannels = (handle: string, slack?: string, audience = 'Teammates'): Agent['channels'] => [
    { kind: 'chat', status: 'connected', detail: 'In-app chat', audience: 'You' },
    ...(slack ? [{ kind: 'slack' as const, status: 'connected' as const, detail: slack, audience }] : []),
    { kind: 'email', status: 'connected', detail: `${handle}@example.com`, audience },
  ];

  const agents: Array<Agent & { personality: string }> = [
    {
      id: 'agent-juno',
      name: 'Juno',
      handle: 'juno',
      avatar: { shape: 'blob', color: 1, eyes: 'dot', accessory: 'antenna', character: 'bean' },
      title: 'Research & inbox',
      personality:
        'Calm and thorough. Reads sources before forming an opinion, cites everything, and asks before it sends anything on your behalf.',
      status: 'working',
      section: 'Personal',
      pinned: true,
      lastActivity: 'Researching Firecracker vs gVisor',
      unreadCount: 2,
      model: {
        planner: { provider: 'anthropic', model: 'claude-opus-4-6', effort: 'high' },
        computer: { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'medium' },
        fast: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      },
      channels: mkChannels('juno', '#research', 'Anyone in Acme Lab'),
      macAccess: false,
      skillIds: ['skill-inbox-triage', 'skill-standup-draft'],
      pluginIds: pluginIdsFor('agent-juno'),
      sharing: { publishedToTeam: true },
      createdBy: robin,
      createdAt: ago(60 * 24 * 120),
      updatedAt: ago(6),
    },
    {
      id: 'agent-patch',
      name: 'Patch',
      handle: 'patch',
      avatar: { shape: 'squircle', color: 3, eyes: 'wide', accessory: 'glasses', character: 'mint' },
      title: 'Engineering & CI',
      personality: 'Direct and terse. Prefers small PRs, reads the test output before commenting, never force-pushes.',
      status: 'working',
      section: 'Personal',
      pinned: false,
      lastActivity: 'Reviewing PR #214',
      unreadCount: 1,
      model: {
        planner: { provider: 'anthropic', model: 'claude-opus-4-6', effort: 'medium' },
        computer: { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'high' },
        fast: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      },
      channels: mkChannels('patch', '#eng', 'Acme Lab engineers'),
      macAccess: false,
      skillIds: ['skill-pr-review', 'skill-release-notes'],
      pluginIds: pluginIdsFor('agent-patch'),
      sharing: { publishedToTeam: true },
      createdBy: robin,
      createdAt: ago(60 * 24 * 110),
      updatedAt: ago(2),
    },
    {
      id: 'agent-ledger',
      name: 'Ledger',
      handle: 'ledger',
      avatar: { shape: 'circle', color: 5, eyes: 'sleepy', accessory: 'bowtie', character: 'pink' },
      title: 'Finance & expenses',
      personality: 'Precise and conservative. Never moves money without you; double-checks amounts against receipts.',
      status: 'idle',
      section: 'Personal',
      pinned: false,
      lastActivity: 'Reconciled October invoices',
      unreadCount: 0,
      model: {
        planner: { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'medium' },
        computer: { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'low' },
        fast: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      },
      channels: mkChannels('ledger', undefined, 'You'),
      macAccess: false,
      skillIds: ['skill-invoice-recon'],
      pluginIds: pluginIdsFor('agent-ledger'),
      sharing: { publishedToTeam: false },
      createdBy: robin,
      createdAt: ago(60 * 24 * 80),
      updatedAt: ago(60 * 5),
    },
    {
      id: 'agent-echo',
      name: 'Echo',
      handle: 'echo',
      avatar: { shape: 'hexagon', color: 7, eyes: 'happy', accessory: 'headphones', character: 'star' },
      title: 'Meetings & notes',
      personality: 'Organized and concise. Turns recordings into decisions and follow-ups with named owners.',
      status: 'idle',
      section: 'Personal',
      pinned: false,
      lastActivity: 'Filed notes for “Launch prep”',
      unreadCount: 0,
      model: {
        planner: { provider: 'anthropic', model: 'claude-opus-4-6', effort: 'medium' },
        computer: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
        fast: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      },
      channels: mkChannels('echo', '#general', 'Anyone in Acme Lab'),
      macAccess: false,
      skillIds: ['skill-meeting-notes', 'skill-standup-draft'],
      pluginIds: pluginIdsFor('agent-echo'),
      sharing: { publishedToTeam: true },
      createdBy: robin,
      createdAt: ago(60 * 24 * 70),
      updatedAt: ago(60 * 4),
    },
    {
      id: 'agent-scout',
      name: 'Scout',
      handle: 'scout',
      avatar: { shape: 'triangle', color: 2, eyes: 'wink', accessory: 'cap', character: 'blue' },
      title: 'Recruiting & network',
      personality: 'Warm and specific. Keeps a light touch, never mass-sends, and always credits a mutual contact.',
      status: 'idle',
      section: 'Personal',
      pinned: false,
      lastActivity: 'Sourced 8 design candidates',
      unreadCount: 0,
      model: {
        planner: { provider: 'anthropic', model: 'claude-opus-4-6', effort: 'medium' },
        computer: { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'medium' },
        fast: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      },
      channels: mkChannels('scout', '#hiring', 'Acme Lab hiring team'),
      macAccess: false,
      skillIds: ['skill-candidate-outreach'],
      pluginIds: pluginIdsFor('agent-scout'),
      sharing: { publishedToTeam: true },
      createdBy: robin,
      createdAt: ago(60 * 24 * 55),
      updatedAt: ago(20),
    },
    {
      id: 'agent-atlas',
      name: 'Atlas',
      handle: 'atlas',
      avatar: { shape: 'diamond', color: 6, eyes: 'star', accessory: 'crown', character: 'purple' },
      title: 'Travel & calendar',
      personality: 'Practical and well-travelled. Prices two options, checks the shared calendar, and books nothing without a yes.',
      status: 'working',
      section: 'Personal',
      pinned: false,
      lastActivity: 'Planning the Lisbon offsite',
      unreadCount: 0,
      model: {
        planner: { provider: 'anthropic', model: 'claude-opus-4-6', effort: 'medium' },
        computer: { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'medium' },
        fast: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      },
      channels: mkChannels('atlas', '#general', 'Anyone in Acme Lab'),
      macAccess: false,
      skillIds: ['skill-trip-planning'],
      pluginIds: pluginIdsFor('agent-atlas'),
      sharing: { publishedToTeam: true },
      createdBy: robin,
      createdAt: ago(60 * 24 * 50),
      updatedAt: ago(30),
    },
    {
      // Created by the user just now (v0.3: agents are user-created chat contacts).
      // A blank agent: default avatar, no role yet, only a greeting in its thread.
      id: 'agent-new',
      name: 'New agent',
      handle: 'new-agent',
      avatar: { shape: 'circle', color: 2, eyes: 'dot', character: 'mint' },
      title: 'New agent',
      personality: '',
      status: 'idle',
      section: 'Personal',
      pinned: false,
      lastActivity: 'Just created',
      unreadCount: 0,
      model: {
        planner: { provider: 'anthropic', model: 'claude-opus-4-6', effort: 'medium' },
        computer: { provider: 'anthropic', model: 'claude-sonnet-4-6', effort: 'medium' },
        fast: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      },
      channels: [{ kind: 'chat', status: 'connected', detail: 'In-app chat', audience: 'You' }],
      macAccess: false,
      skillIds: [],
      pluginIds: [],
      sharing: { publishedToTeam: false },
      createdBy: robin,
      createdAt: iso(nowMs),
      updatedAt: iso(nowMs),
    },
  ];
  state.agents = agents.map(({ personality: _personality, ...agent }) => agent);
  state.home = agents
    .filter((agent) => agent.personality !== '')
    .map((agent) => ({
      path: `agents/${agent.id}/IDENTITY.md`,
      content: agent.personality,
      hash: `seed-${agent.id}`,
      writer: 'user' as const,
      updatedAt: iso(nowMs),
    }));

  // --- conversations -------------------------------------------------------
  const conversations: Conversation[] = [
    { id: 'conv-new', kind: 'direct', title: 'New agent', agentIds: ['agent-new'], memberIds: [robin], unreadCount: 0, pinned: false, lastItemAt: iso(nowMs), createdAt: iso(nowMs) },
    { id: 'conv-juno', kind: 'direct', title: 'Juno', agentIds: ['agent-juno'], memberIds: [robin], unreadCount: 2, pinned: true, lastItemAt: ago(4), createdAt: ago(60 * 24 * 118) },
    { id: 'conv-patch', kind: 'direct', title: 'Patch', agentIds: ['agent-patch'], memberIds: [robin], unreadCount: 1, pinned: false, lastItemAt: ago(2), createdAt: ago(60 * 24 * 108) },
    { id: 'conv-ledger', kind: 'direct', title: 'Ledger', agentIds: ['agent-ledger'], memberIds: [robin], unreadCount: 0, pinned: false, lastItemAt: ago(60 * 5), createdAt: ago(60 * 24 * 78) },
    { id: 'conv-echo', kind: 'direct', title: 'Echo', agentIds: ['agent-echo'], memberIds: [robin], unreadCount: 0, pinned: false, lastItemAt: ago(60 * 4), createdAt: ago(60 * 24 * 68) },
    { id: 'conv-scout', kind: 'direct', title: 'Scout', agentIds: ['agent-scout'], memberIds: [robin], unreadCount: 0, pinned: false, lastItemAt: ago(20), createdAt: ago(60 * 24 * 52) },
    { id: 'conv-atlas', kind: 'direct', title: 'Atlas', agentIds: ['agent-atlas'], memberIds: [robin], unreadCount: 0, pinned: false, lastItemAt: ago(35), createdAt: ago(60 * 24 * 48) },
    { id: 'conv-launch', kind: 'room', title: 'Launch prep', agentIds: ['agent-juno', 'agent-patch', 'agent-echo'], memberIds: [robin, priya], unreadCount: 1, pinned: true, lastItemAt: ago(50), createdAt: ago(60 * 24 * 20) },
    { id: 'conv-offsite', kind: 'room', title: 'Offsite crew', agentIds: ['agent-atlas', 'agent-ledger', 'agent-scout'], memberIds: [robin], unreadCount: 0, pinned: false, lastItemAt: ago(60 * 5), createdAt: ago(60 * 24 * 9) },
  ];
  state.conversations = conversations;

  // --- runs + steps --------------------------------------------------------
  const researchSteps: Step[] = [
    mkStep('run-research', 0, 'think', 'Planned', 'a 3-source comparison of Firecracker and gVisor', agoMs(176), {
      input: { text: 'Pick sources: official docs, a benchmark paper, and one production write-up.' },
      output: { summary: '3 sources selected, outline ready' }, durationMs: 2600,
    }),
    mkStep('run-research', 1, 'browser', 'Opened chromium →', 'firecracker-microvm.github.io', agoMs(175), {
      screenshotRef: 'shot-juno-firecracker-docs', input: { url: 'https://firecracker-microvm.github.io/' }, durationMs: 3100,
    }),
    mkStep('run-research', 2, 'browser', 'Read', '“Firecracker design and architecture”', agoMs(173), {
      output: { summary: 'KVM-based microVM, ~125ms boot, 5MB overhead, no page-cache sharing' }, screenshotRef: 'shot-juno-firecracker-design', durationMs: 5200,
    }),
    mkStep('run-research', 3, 'file', 'Wrote notes to', '/workspace/notes/firecracker.md', agoMs(171), {
      output: { summary: '18 lines of notes', data: { path: '/workspace/notes/firecracker.md', bytes: 1420 } }, durationMs: 900,
    }),
    mkStep('run-research', 4, 'browser', 'Opened', 'gvisor.dev/docs', agoMs(169), {
      screenshotRef: 'shot-juno-gvisor-docs', input: { url: 'https://gvisor.dev/docs/' }, durationMs: 2400,
    }),
    mkStep('run-research', 5, 'browser', 'Read', '“What is gVisor?”', agoMs(167), {
      output: { summary: 'User-space kernel (Sentry), syscall interception, stronger isolation, higher syscall cost' }, screenshotRef: 'shot-juno-gvisor-arch', durationMs: 6100,
    }),
    mkStep('run-research', 6, 'file', 'Wrote notes to', '/workspace/notes/gvisor.md', agoMs(165), {
      output: { summary: '15 lines of notes', data: { path: '/workspace/notes/gvisor.md', bytes: 1180 } }, durationMs: 780,
    }),
    mkStep('run-research', 7, 'browser', 'Searched', '“firecracker vs gvisor benchmark”', agoMs(163), {
      screenshotRef: 'shot-juno-search', input: { text: 'firecracker vs gvisor benchmark' }, durationMs: 1900,
    }),
    mkStep('run-research', 8, 'browser', 'Read', '“Serverless sandbox benchmarks (2025)”', agoMs(160), {
      output: { summary: 'gVisor adds 20–40% syscall latency; Firecracker wins cold-start' }, durationMs: 7300,
    }),
    mkStep('run-research', 9, 'shell', 'Ran', 'python3 /workspace/bench/summarize.py', agoMs(157), {
      input: { command: 'python3 /workspace/bench/summarize.py benchmarks.csv' },
      output: { text: 'samples=240  firecracker p50=128ms  gvisor p50=171ms' }, durationMs: 2200,
    }),
    mkStep('run-research', 10, 'mcp', 'Called github.search on', '“microvm sandbox”', agoMs(154), {
      output: { summary: '4 repositories reviewed', data: { repos: ['firecracker-microvm/firecracker', 'google/gvisor', 'e2b-dev/E2B', 'cloudflare/workers'] } }, durationMs: 3400,
    }),
    mkStep('run-research', 11, 'think', 'Weighed', 'isolation strength against startup latency', agoMs(151), {
      output: { summary: 'Recommend Firecracker for our workload; keep gVisor for untrusted third-party code' }, durationMs: 4100,
    }),
    mkStep('run-research', 12, 'file', 'Wrote', '/workspace/sandbox-comparison.md', agoMs(148), {
      output: { summary: 'Comparison memo with a decision table', data: { path: '/workspace/sandbox-comparison.md', bytes: 6120 } }, durationMs: 1500,
    }),
    mkStep('run-research', 13, 'computer', 'Captured', 'screenshot of the notes pane', agoMs(147), {
      screenshotRef: 'shot-juno-notes-pane', durationMs: 600,
    }),
    mkStep('run-research', 14, 'browser', 'Saved the memo to', 'Google Drive → Research', agoMs(146), {
      screenshotRef: 'shot-juno-drive-save', durationMs: 2100,
    }),
  ];

  const liveSteps: Step[] = [
    mkStep('run-live', 0, 'think', 'Planned', 'a triage sweep of 37 new inbox threads', agoMs(4), { durationMs: 1800 }),
    mkStep('run-live', 1, 'mcp', 'Called gmail.search_threads', 'label:inbox newer_than:1d', agoMs(3), {
      output: { summary: '37 threads returned' }, durationMs: 2600,
    }),
    mkStep('run-live', 2, 'think', 'Classified', 'threads into Action / Waiting / Read', agoMs(3), { durationMs: 2100 }),
    mkStep('run-live', 3, 'file', 'Wrote', '/workspace/inbox/triage.csv', agoMs(2), {
      output: { summary: '37 rows' }, durationMs: 700,
    }),
  ];

  const prReviewSteps = genericSteps('run-pr-review', agoMs(12), [
    ['mcp', 'Called github.list_pull_requests on', 'acme/agent-desktop'],
    ['browser', 'Opened', 'github.com/acme/agent-desktop/pull/214'],
    ['shell', 'Ran', 'pnpm --filter @agent-desktop/client test'],
    ['think', 'Reviewed', 'the diff for correctness and tests'],
    ['mcp', 'Called github.create_issue', 'LIN-501: flaky pagination test'],
  ]);

  const runs: Run[] = [
    {
      id: 'run-research', agentId: 'agent-juno', conversationId: 'conv-juno',
      title: 'Compare Firecracker and gVisor sandboxes', status: 'completed', kind: 'chat',
      steps: researchSteps,
      usage: { inputTokens: 184_320, outputTokens: 21_450, computeSeconds: 918, costUsd: 4.12, steps: researchSteps.length },
      startedAt: ago(177), finishedAt: ago(146), durationMs: 31 * MINUTE, lastActivityAt: ago(146),
    },
    {
      id: 'run-live', agentId: 'agent-juno', conversationId: 'conv-juno',
      title: 'Triage the inbox and draft replies', status: 'running', kind: 'chat',
      steps: liveSteps,
      usage: { inputTokens: 42_100, outputTokens: 6_240, computeSeconds: 214, costUsd: 0.94, steps: liveSteps.length },
      startedAt: ago(4), lastActivityAt: ago(2),
    },
    {
      id: 'run-inbox-triage', agentId: 'agent-juno', routineId: 'routine-inbox-triage', conversationId: 'conv-juno',
      title: 'Daily inbox triage', status: 'completed', kind: 'routine', triggerLabel: 'Weekdays 8:00 (Asia/Singapore)',
      steps: genericSteps('run-inbox-triage', agoMs(60 * 9), [
        ['mcp', 'Called gmail.search_threads', 'label:inbox'],
        ['think', 'Classified', '21 threads'],
        ['file', 'Wrote', '/workspace/inbox/2026-10-05.csv'],
        ['mcp', 'Called gmail.draft_reply', 'for 3 Action threads'],
      ]),
      usage: { inputTokens: 88_400, outputTokens: 12_100, computeSeconds: 402, costUsd: 1.86, steps: 4 },
      startedAt: ago(60 * 9), finishedAt: ago(60 * 9 - 8), durationMs: 8 * MINUTE, lastActivityAt: ago(60 * 9 - 8),
    },
    {
      id: 'run-weekly-digest', agentId: 'agent-juno', routineId: 'routine-weekly-digest',
      title: 'Weekly research digest', status: 'scheduled', kind: 'scheduled', triggerLabel: 'Weekly on Monday 9:00',
      steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
      startedAt: ahead(60 * 42), lastActivityAt: ago(60 * 24 * 6),
    },
    {
      id: 'run-cleanup', agentId: 'agent-juno', conversationId: 'conv-juno',
      title: 'Clean up stale /workspace drafts', status: 'stopped', kind: 'background',
      steps: genericSteps('run-cleanup', agoMs(60 * 24 * 2), [
        ['shell', 'Listed', '/workspace/drafts (14 files)'],
        ['think', 'Ranked', 'drafts by last access'],
      ]),
      usage: { inputTokens: 6_200, outputTokens: 800, computeSeconds: 24, costUsd: 0.09, steps: 2 },
      startedAt: ago(60 * 24 * 2), finishedAt: ago(60 * 24 * 2 - 1), durationMs: MINUTE, lastActivityAt: ago(60 * 24 * 2 - 1),
    },
    {
      id: 'run-pr-review', agentId: 'agent-patch', routineId: 'routine-pr-review', conversationId: 'conv-patch',
      title: 'Review PR #214', status: 'running', kind: 'routine', triggerLabel: 'New PR in acme/agent-desktop',
      steps: prReviewSteps,
      usage: { inputTokens: 63_200, outputTokens: 9_800, computeSeconds: 356, costUsd: 1.42, steps: prReviewSteps.length },
      startedAt: ago(12), lastActivityAt: ago(1),
    },
    {
      id: 'run-deploy', agentId: 'agent-patch', conversationId: 'conv-patch',
      title: 'Deploy web to staging', status: 'failed', kind: 'manual',
      steps: genericSteps('run-deploy', agoMs(60 * 14), [
        ['shell', 'Ran', 'pnpm release:staging'],
        ['browser', 'Opened', 'vercel.com/acme/agent-desktop'],
        ['shell', 'Ran', 'pnpm smoke:staging'],
      ]).map((step, i) => (i === 2 ? { ...step, status: 'failed' as const, output: { text: 'Error: 2 of 14 smoke checks failed (sign-in flow)' } } : step)),
      usage: { inputTokens: 24_800, outputTokens: 3_100, computeSeconds: 132, costUsd: 0.48, steps: 3 },
      startedAt: ago(60 * 14), finishedAt: ago(60 * 14 - 6), durationMs: 6 * MINUTE, lastActivityAt: ago(60 * 14 - 6),
      error: 'Smoke checks failed: sign-in flow timed out',
    },
    {
      id: 'run-ci-triage', agentId: 'agent-patch', routineId: 'routine-ci-watch', conversationId: 'conv-patch',
      title: 'Triage the failing main build', status: 'queued', kind: 'routine', triggerLabel: 'CI failed on main',
      steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
      startedAt: ago(1), lastActivityAt: ago(1),
    },
    {
      id: 'run-invoice-chase', agentId: 'agent-ledger', routineId: 'routine-invoice-chase',
      title: 'Chase unpaid invoices', status: 'scheduled', kind: 'scheduled', triggerLabel: 'Monthly on the 1st',
      steps: [], usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
      startedAt: ahead(60 * 24 * 3), lastActivityAt: ago(60 * 24 * 24),
    },
    {
      id: 'run-purchase', agentId: 'agent-ledger', conversationId: 'conv-ledger',
      title: 'Buy the annual Figma seats', status: 'waiting_for_input', kind: 'chat',
      steps: genericSteps('run-purchase', agoMs(60 * 6), [
        ['browser', 'Opened', 'figma.com/pricing'],
        ['think', 'Prepared', 'a purchase of 5 annual seats ($360)'],
      ]),
      usage: { inputTokens: 9_400, outputTokens: 1_700, computeSeconds: 62, costUsd: 0.22, steps: 2 },
      startedAt: ago(60 * 6), lastActivityAt: ago(60 * 6 + 3),
    },
    {
      id: 'run-expense-report', agentId: 'agent-ledger', conversationId: 'conv-ledger',
      title: 'Compile the September expense report', status: 'completed', kind: 'manual',
      steps: genericSteps('run-expense-report', agoMs(60 * 22), [
        ['mcp', 'Called stripe.list_charges', 'September 2026'],
        ['file', 'Wrote', '/workspace/finance/expenses-2026-09.csv'],
        ['mcp', 'Called gmail.draft_reply', 'to the accountant'],
      ]),
      usage: { inputTokens: 31_200, outputTokens: 4_100, computeSeconds: 148, costUsd: 0.61, steps: 3 },
      startedAt: ago(60 * 22), finishedAt: ago(60 * 21), durationMs: 34 * MINUTE, lastActivityAt: ago(60 * 21),
    },
    {
      id: 'run-meeting-notes', agentId: 'agent-echo', conversationId: 'conv-echo',
      title: 'Notes for “Launch prep”', status: 'completed', kind: 'manual',
      steps: genericSteps('run-meeting-notes', agoMs(60 * 26), [
        ['shell', 'Transcribed', 'launch-prep-2026-10-04.m4a'],
        ['think', 'Extracted', '6 decisions and 9 follow-ups'],
        ['mcp', 'Called notion.create_page', 'Meetings / Launch prep'],
        ['file', 'Wrote', '/workspace/notes/launch-prep.md'],
      ]),
      usage: { inputTokens: 71_500, outputTokens: 8_900, computeSeconds: 288, costUsd: 1.33, steps: 4 },
      startedAt: ago(60 * 26), finishedAt: ago(60 * 25), durationMs: 46 * MINUTE, lastActivityAt: ago(60 * 25),
    },
    {
      id: 'run-standup', agentId: 'agent-echo', routineId: 'routine-standup', conversationId: 'conv-echo',
      title: 'Draft the daily standup', status: 'completed', kind: 'routine', triggerLabel: 'Weekdays 8:45 (Asia/Singapore)',
      steps: genericSteps('run-standup', agoMs(60 * 8), [
        ['think', 'Collected', 'yesterday’s activity across the team'],
        ['file', 'Wrote', '/workspace/notes/standup-week-40.md'],
        ['mcp', 'Called slack.post_message', '#general'],
      ]),
      usage: { inputTokens: 18_400, outputTokens: 2_300, computeSeconds: 74, costUsd: 0.34, steps: 3 },
      startedAt: ago(60 * 8), finishedAt: ago(60 * 8 - 4), durationMs: 4 * MINUTE, lastActivityAt: ago(60 * 8 - 4),
    },
    {
      id: 'run-sourcing', agentId: 'agent-scout', conversationId: 'conv-scout',
      title: 'Source candidates for the design role', status: 'running', kind: 'chat',
      steps: genericSteps('run-sourcing', agoMs(21), [
        ['browser', 'Searched', 'design portfolios matching the brief'],
        ['think', 'Shortlisted', '8 candidates with a mutual contact'],
        ['file', 'Wrote', '/workspace/recruiting/design-candidates.csv'],
      ]),
      usage: { inputTokens: 27_600, outputTokens: 3_900, computeSeconds: 126, costUsd: 0.52, steps: 3 },
      startedAt: ago(21), lastActivityAt: ago(20),
    },
    {
      id: 'run-intros', agentId: 'agent-scout', conversationId: 'conv-scout',
      title: 'Draft warm intros', status: 'completed', kind: 'manual',
      steps: genericSteps('run-intros', agoMs(60 * 30), [
        ['think', 'Matched', 'candidates to two advisors'],
        ['file', 'Wrote', '/workspace/recruiting/intros.md'],
        ['mcp', 'Called gmail.draft_reply', '3 intro emails'],
      ]),
      usage: { inputTokens: 12_900, outputTokens: 2_100, computeSeconds: 58, costUsd: 0.27, steps: 3 },
      startedAt: ago(60 * 30), finishedAt: ago(60 * 29), durationMs: 12 * MINUTE, lastActivityAt: ago(60 * 29),
    },
    {
      id: 'run-offsite', agentId: 'agent-atlas', conversationId: 'conv-offsite',
      title: 'Plan the Lisbon offsite', status: 'running', kind: 'chat',
      steps: genericSteps('run-offsite', agoMs(45), [
        ['browser', 'Compared', 'three venues in Lisbon'],
        ['mcp', 'Called google-calendar.find_free_slot', 'week of Nov 10'],
        ['think', 'Priced', 'two travel options per person'],
      ]),
      usage: { inputTokens: 22_400, outputTokens: 3_200, computeSeconds: 104, costUsd: 0.44, steps: 3 },
      startedAt: ago(45), lastActivityAt: ago(35),
    },
  ];
  state.runs = runs;

  state.plans = [
    {
      id: 'plan-research', conversationId: 'conv-juno', runId: 'run-research',
      title: 'Sandbox comparison',
      todos: [
        { id: 'todo-r1', text: 'Read the Firecracker architecture docs', status: 'done' },
        { id: 'todo-r2', text: 'Read the gVisor overview and security model', status: 'done' },
        { id: 'todo-r3', text: 'Collect benchmark numbers for both runtimes', status: 'done' },
        { id: 'todo-r4', text: 'Write sandbox-comparison.md with a decision table', status: 'done' },
        { id: 'todo-r5', text: 'Get your sign-off on the recommended runtime', status: 'in_progress', note: 'Waiting on your answer below' },
      ],
      updatedAt: ago(30),
    },
  ] as Plan[];

  // --- requests ------------------------------------------------------------
  const requests: Request[] = [
    {
      id: 'req-juno-email', kind: 'approval', status: 'pending',
      title: 'Send the sandbox summary to the team',
      summary: 'Juno wants to email team@example.com with the Firecracker vs gVisor summary attached.',
      agentId: 'agent-juno', conversationId: 'conv-juno', runId: 'run-research',
      triggeringRuleId: 'rule-builtin-recipient', createdAt: ago(25),
      payload: {
        kind: 'approval', action: 'Send email', target: 'team@example.com', app: 'Gmail',
        recipient: 'team@example.com', why: 'The team asked for the comparison before Thursday’s architecture review.',
        brief: {
          sentence: 'Email the sandbox comparison to team@example.com', sentenceSource: 'agent',
          why: 'The team asked for the comparison before Thursday’s architecture review.',
          ifDenied: 'I will keep the draft and ask again after the review.',
          categories: ['speaking'], primary: 'speaking',
          platform: { kind: 'connector', name: 'Gmail', catalogId: 'gmail', account: 'robin@example.com' },
          facts: {
            audience: { kind: 'people', count: 1, recipients: [{ name: 'Team', address: 'team@example.com' }], source: 'verified' },
            asAccount: { label: 'robin@example.com', catalogId: 'gmail', source: 'verified' },
            reversible: { value: 'no', source: 'declared' },
          },
          binding: { argsHash: 'a1', contentDigest: 'c1', factsHash: 'f1' },
        },
        delegationOffer: {
          delegable: true,
          suggested: [{ category: 'speaking', platform: { kind: 'connector', catalogId: 'gmail' }, limits: { recipients: ['team@example.com'], replyOnly: false, maxPerDay: 10 } }],
        },
        draft: {
          subject: 'Sandbox comparison: Firecracker vs gVisor',
          body: 'Hi team,\n\nI compared Firecracker and gVisor for our agent sandboxes. Recommend Firecracker for our own agents (better cold-start, lower overhead) and gVisor for untrusted third-party code (stronger syscall isolation).\n\nFull memo attached: sandbox-comparison.md\n\n— Juno',
        },
      },
    },
    {
      id: 'req-juno-question', kind: 'question', status: 'pending',
      title: 'Which baseline should I optimise for?',
      summary: 'Juno needs one decision before it finalises the recommendation.',
      agentId: 'agent-juno', conversationId: 'conv-juno', runId: 'run-research', createdAt: ago(19),
      payload: {
        kind: 'question',
        ui: {
          version: 1,
          title: 'Which baseline should I optimise for?',
          blocks: [
            {
              type: 'choices',
              id: 'q-baseline',
              options: [
                { id: 'latency', label: 'Cold-start latency', description: 'Firecracker' },
                { id: 'isolation', label: 'Isolation strength', description: 'gVisor' },
                { id: 'balanced', label: 'Balanced', description: 'Pick per workload' },
              ],
            },
          ],
        },
      },
    },
    {
      id: 'req-juno-signin', kind: 'signin', status: 'pending',
      title: 'Sign in to Linear for Juno',
      summary: 'Juno needs a browser session on its computer to link the memo to issue LIN-482.',
      agentId: 'agent-juno', conversationId: 'conv-juno', createdAt: ago(15),
      payload: { kind: 'signin', site: 'linear.app', url: 'https://linear.app/acme', reason: 'Link the memo to LIN-482', pausesModel: true },
    },
    {
      id: 'req-juno-secure', kind: 'secure_input', status: 'pending',
      title: 'Enter your card details', summary: 'Juno needs your card to pay for the domain.',
      agentId: 'agent-juno', conversationId: 'conv-juno', createdAt: ago(8),
      payload: {
        kind: 'secure_input', site: 'namecheap.com', reason: 'Pay for example.com renewal',
        // The sandbox public key of the shared test vector (backend secure-input-vector.json).
        encryption: { alg: 'X25519-HKDF-SHA256-AES256GCM', keyId: 'aaa8fff703b50b22', publicKey: 'B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=' },
        fields: [
          { id: 'f1', label: 'Card number', kind: 'card_number' },
          { id: 'f2', label: 'Expiry', kind: 'card_expiry' },
          { id: 'f3', label: 'CVC', kind: 'card_cvc' },
        ],
      },
    },
    {
      id: 'req-patch-computer', kind: 'computer', status: 'pending',
      title: 'Patch needs you on the screen', summary: 'A captcha is blocking the sign-in.',
      agentId: 'agent-patch', conversationId: 'conv-patch', createdAt: ago(6),
      payload: {
        kind: 'computer', reason: 'A captcha is blocking the sign-in page.', site: 'github.com', url: 'https://github.com/login',
        focus: { rect: { x: 420, y: 380, width: 320, height: 90 }, label: 'I am not a robot', role: 'checkbox' },
      },
    },
    {
      id: 'req-patch-install', kind: 'approval', status: 'pending',
      title: 'Install Playwright on the computer',
      summary: 'Patch wants to install Playwright and its browser binaries to run end-to-end tests.',
      agentId: 'agent-patch', conversationId: 'conv-patch', runId: 'run-pr-review',
      triggeringRuleId: 'rule-builtin-software', createdAt: ago(45),
      payload: {
        kind: 'approval', action: 'Install software', target: 'playwright@1.48.0', app: 'Computer', site: 'npmjs.com',
        why: 'PR #214 changes the sign-in flow; the current tests don’t cover it. Playwright adds ~280MB to the computer.',
      },
    },
    {
      id: 'req-ledger-stripe', kind: 'admin', status: 'pending',
      title: 'Grant Ledger read access to Stripe',
      summary: 'Ledger is asking for a read-only Stripe key to reconcile October invoices.',
      agentId: 'agent-ledger', conversationId: 'conv-ledger', triggeringRuleId: 'rule-builtin-access', createdAt: ago(60 * 20),
      payload: { kind: 'admin', app: 'Stripe', requester: 'Ledger (agent)', reason: 'Reconcile October invoices against the ledger', details: 'Read-only scope: charges, invoices, payouts. No write access requested.' },
    },
    {
      id: 'req-atlas-travel', kind: 'approval', status: 'pending',
      title: 'Book the Lisbon offsite travel',
      summary: 'Atlas wants to hold venue and flights for the week of Nov 10.',
      agentId: 'agent-atlas', conversationId: 'conv-atlas', runId: 'run-offsite',
      triggeringRuleId: 'rule-builtin-purchase', createdAt: ago(35),
      payload: {
        kind: 'approval', action: 'Book travel', target: 'Lisbon, week of Nov 10 (6 people)', app: 'Computer', site: 'travel.example.com',
        why: 'Venue holds expire Friday; flights are cheapest booked early. Total ~$9.4k against the $18k offsite budget.',
      },
    },

    // resolved history
    {
      id: 'req-resolved-invite', kind: 'approval', status: 'approved',
      title: 'Send a calendar invite', summary: 'Juno asked to invite Priya to the architecture review.',
      agentId: 'agent-juno', conversationId: 'conv-juno', triggeringRuleId: 'rule-builtin-recipient',
      createdAt: ago(60 * 30), resolvedAt: ago(60 * 29),
      decision: { by: robin, at: ago(60 * 29), mode: 'manual', scope: 'once' },
      payload: { kind: 'approval', action: 'Create calendar event', target: 'priya@example.com', app: 'Google Calendar', why: 'Thursday’s architecture review needs the whole team.' },
    },
    {
      id: 'req-resolved-forcepush', kind: 'approval', status: 'denied',
      title: 'Force-push to main', summary: 'Patch asked to force-push a rebased branch to main.',
      agentId: 'agent-patch', conversationId: 'conv-patch', triggeringRuleId: 'rule-builtin-delete',
      createdAt: ago(60 * 52), resolvedAt: ago(60 * 52 - 2),
      decision: { by: robin, at: ago(60 * 52 - 2), mode: 'manual', scope: 'once', note: 'Open a PR instead.' },
      payload: { kind: 'approval', action: 'Force-push', target: 'origin/main', app: 'GitHub', why: 'The rebase is cleaner than the merge.' },
    },
    {
      id: 'req-decided-stripe', kind: 'approval', status: 'approved', outcome: 'allowed_once',
      title: 'Pay the Figma invoice', summary: 'Ledger asked to pay the October Figma invoice.',
      agentId: 'agent-juno', conversationId: 'conv-juno', createdAt: ago(60 * 5), resolvedAt: ago(60 * 5 - 2),
      decision: { by: robin, at: ago(60 * 5 - 2), mode: 'manual', scope: 'once' },
      payload: {
        kind: 'approval', action: 'Pay invoice', why: 'The invoice is due tomorrow.', app: 'Stripe',
        brief: {
          sentence: 'Pay the October Figma invoice', sentenceSource: 'server', ifDenied: 'The invoice stays unpaid.',
          categories: ['spending'], primary: 'spending',
          platform: { kind: 'connector', name: 'Stripe', catalogId: 'stripe' },
          facts: { money: { amount: '30.00', currency: 'USD', merchant: 'Figma', source: 'verified' } },
          binding: { argsHash: 'a2', contentDigest: 'c2', factsHash: 'f2' },
        },
      },
    },
    {
      id: 'req-decided-rule-1', kind: 'approval', status: 'approved', outcome: 'allowed_rule',
      title: 'Reply to Mei', summary: 'Juno replied to Mei.',
      agentId: 'agent-juno', conversationId: 'conv-juno', triggeringRuleId: 'rule-delegation-speaking',
      createdAt: ago(60 * 3), resolvedAt: ago(60 * 3),
      decision: { by: 'auto', at: ago(60 * 3), mode: 'auto', scope: 'once' },
      payload: {
        kind: 'approval', action: 'Send email', why: 'Mei asked for the notes.', app: 'Gmail',
        brief: {
          sentence: 'Reply to Mei with the meeting notes', sentenceSource: 'agent',
          categories: ['speaking'], primary: 'speaking',
          platform: { kind: 'connector', name: 'Gmail', catalogId: 'gmail' },
          facts: { audience: { kind: 'people', count: 1, recipients: [{ name: 'Mei', address: 'mei@example.com' }], source: 'verified' } },
          binding: { argsHash: 'a3', contentDigest: 'c3', factsHash: 'f3' },
        },
      },
    },
    {
      id: 'req-decided-rule-2', kind: 'approval', status: 'approved', outcome: 'allowed_rule',
      title: 'Reply to Zed', summary: 'Juno replied to Zed.',
      agentId: 'agent-juno', conversationId: 'conv-juno', triggeringRuleId: 'rule-delegation-speaking',
      createdAt: ago(60 * 2), resolvedAt: ago(60 * 2),
      decision: { by: 'auto', at: ago(60 * 2), mode: 'auto', scope: 'once' },
      payload: {
        kind: 'approval', action: 'Send email', why: 'Zed asked a question.', app: 'Gmail',
        brief: {
          sentence: 'Reply to Zed about the release date', sentenceSource: 'agent',
          categories: ['speaking'], primary: 'speaking',
          platform: { kind: 'connector', name: 'Gmail', catalogId: 'gmail' },
          facts: { audience: { kind: 'people', count: 1, recipients: [{ name: 'Zed', address: 'zed@example.com' }], source: 'verified' } },
          binding: { argsHash: 'a4', contentDigest: 'c4', factsHash: 'f4' },
        },
      },
    },
    {
      id: 'req-decided-revised', kind: 'approval', status: 'denied', outcome: 'revised',
      title: 'Post on Instagram', summary: 'Juno asked to post the launch photo.',
      agentId: 'agent-juno', conversationId: 'conv-juno', createdAt: ago(60 * 8), resolvedAt: ago(60 * 8 - 3),
      decision: { by: robin, at: ago(60 * 8 - 3), mode: 'manual', scope: 'once', reason: 'revise', note: 'Use the team photo instead.' },
      payload: {
        kind: 'approval', action: 'Post photo', why: 'Launch day.', site: 'instagram.com',
        brief: {
          sentence: 'Post the launch photo to Instagram', sentenceSource: 'agent',
          categories: ['public', 'irreversible'], primary: 'irreversible',
          platform: { kind: 'site', name: 'Instagram', host: 'instagram.com' },
          facts: { audience: { kind: 'public', recipients: [], source: 'verified' }, reversible: { value: 'hard', source: 'verified' } },
          binding: { argsHash: 'a5', contentDigest: 'c5', factsHash: 'f5' },
        },
      },
    },
    {
      id: 'req-resolved-logdest', kind: 'question', status: 'answered',
      title: 'Where should run logs go?', summary: 'Juno asked where to store verbose run logs.',
      agentId: 'agent-juno', conversationId: 'conv-juno', createdAt: ago(60 * 40), resolvedAt: ago(60 * 39),
      decision: { by: robin, at: ago(60 * 39), mode: 'manual', scope: 'once' },
      payload: {
        kind: 'question',
        ui: {
          version: 1,
          title: 'Where should run logs go?',
          blocks: [{ type: 'choices', id: 'q-dest', options: [{ id: 'local', label: 'Local only' }, { id: 'notion', label: 'Notion' }, { id: 's3', label: 'S3 bucket' }] }],
        },
        answers: { 'q-dest': 'local' },
      },
    },
    {
      id: 'req-resolved-figma', kind: 'approval', status: 'approved',
      title: 'Buy 5 annual Figma seats', summary: 'Ledger asked to purchase team seats at the annual rate.',
      agentId: 'agent-ledger', conversationId: 'conv-ledger', triggeringRuleId: 'rule-builtin-purchase',
      createdAt: ago(60 * 7), resolvedAt: ago(60 * 6),
      decision: { by: robin, at: ago(60 * 6), mode: 'manual', scope: 'always_recipient' },
      payload: { kind: 'approval', action: 'Purchase', target: '5 × Figma annual seats', app: 'Figma', why: 'The monthly plan is 22% more expensive over the year.' },
    },
    {
      id: 'req-resolved-intro', kind: 'approval', status: 'approved',
      title: 'Send three candidate intros', summary: 'Scout asked to send warm intro emails to three design candidates.',
      agentId: 'agent-scout', conversationId: 'conv-scout', triggeringRuleId: 'rule-builtin-recipient',
      createdAt: ago(60 * 29), resolvedAt: ago(60 * 29 - 3),
      decision: { by: robin, at: ago(60 * 29 - 3), mode: 'manual', scope: 'once' },
      payload: { kind: 'approval', action: 'Send email', target: '3 candidates', app: 'Gmail', why: 'Two advisors offered to make the intro this week.' },
    },
    {
      id: 'req-resolved-purchase', kind: 'approval', status: 'approved',
      title: 'Buy a MacBook Air', summary: 'Ledger asked to order a MacBook Air for the design team.',
      agentId: 'agent-ledger', conversationId: 'conv-ledger', triggeringRuleId: 'rule-builtin-purchase',
      createdAt: ago(60 * 3), resolvedAt: ago(60 * 3 - 2),
      decision: { by: robin, at: ago(60 * 3 - 2), mode: 'manual', scope: 'once' },
      payload: {
        kind: 'approval', action: 'Purchase', target: 'apple.com', app: 'Computer', site: 'apple.com',
        why: 'The design team needs a laptop before the new hire starts.',
        purchase: { merchant: 'Apple Store', items: [{ name: 'MacBook Air 13", M4', quantity: 1, price: 'S$2,399.00' }], total: 'S$2,399.00', currency: 'SGD', paymentMethod: 'Visa •••• 4242' },
        preview: { libraryId: 'lib-preview-order', capturedAt: ago(60 * 3) },
      },
    },
    {
      id: 'req-resolved-secure', kind: 'secure_input', status: 'approved',
      title: 'Enter your Linear password', summary: 'Juno needs your password to sign in to linear.app.',
      agentId: 'agent-juno', conversationId: 'conv-juno', createdAt: ago(60 * 9), resolvedAt: ago(60 * 9 - 1),
      decision: { by: robin, at: ago(60 * 9 - 1), mode: 'manual', scope: 'once' },
      payload: { kind: 'secure_input', site: 'linear.app', reason: 'Sign in to link the memo to LIN-482', fields: [{ id: 'f1', label: 'Password', kind: 'password', status: 'filled' }] },
    },
    {
      id: 'req-expired-sentry', kind: 'approval', status: 'expired',
      title: 'Connect Sentry (expired)', summary: 'A Sentry connection request expired after 24 hours.',
      agentId: 'agent-patch', conversationId: 'conv-patch', createdAt: ago(60 * 24 * 4), resolvedAt: ago(60 * 24 * 3),
      decision: { by: 'auto', at: ago(60 * 24 * 3), mode: 'auto', scope: 'once' },
      payload: { kind: 'approval', action: 'Connect account', target: 'sentry.io', app: 'Sentry', why: 'To triage new errors automatically.' },
    },
  ];
  state.requests = requests;

  // --- rules ---------------------------------------------------------------
  const rules: Rule[] = [
    { id: 'rule-builtin-recipient', description: 'Sending or sharing needs a recipient-scoped approval', scope: 'recipient', behavior: 'ask', source: 'builtin', enabled: true, subject: 'email', createdAt: ago(60 * 24 * 140) },
    { id: 'rule-builtin-purchase', description: 'Purchases need approval', scope: 'action', behavior: 'ask', source: 'builtin', enabled: true, subject: 'purchase', createdAt: ago(60 * 24 * 140) },
    { id: 'rule-builtin-delete', description: 'Permanent deletes always confirm', scope: 'action', behavior: 'ask', source: 'builtin', enabled: true, subject: 'delete', createdAt: ago(60 * 24 * 140) },
    { id: 'rule-builtin-software', description: 'Installing unknown software always confirms', scope: 'action', behavior: 'ask', source: 'builtin', enabled: true, subject: 'install', createdAt: ago(60 * 24 * 140) },
    { id: 'rule-builtin-access', description: 'New sensitive access always confirms', scope: 'action', behavior: 'ask', source: 'builtin', enabled: true, subject: 'access', createdAt: ago(60 * 24 * 140) },
    { id: 'rule-builtin-password', description: 'Password changes are always handed to you', scope: 'action', behavior: 'handoff', source: 'builtin', enabled: true, subject: 'password', createdAt: ago(60 * 24 * 140) },
    { id: 'rule-builtin-transfer', description: 'Money transfers are always handed to you', scope: 'action', behavior: 'handoff', source: 'builtin', enabled: true, subject: 'transfer', createdAt: ago(60 * 24 * 140) },

    { id: 'rule-calendar-auto', description: 'Create and move calendar events automatically', scope: 'app', behavior: 'auto', source: 'user', enabled: true, subject: 'Google Calendar', createdBy: robin, createdAt: ago(60 * 24 * 60) },
    { id: 'rule-gmail-command', description: 'Send email only when I say “send it”', scope: 'app', behavior: 'on_command', source: 'user', enabled: true, subject: 'Gmail', createdBy: robin, createdAt: ago(60 * 24 * 55) },
    { id: 'rule-team-email-auto', description: 'Email team@example.com without asking', scope: 'recipient', behavior: 'auto', source: 'team', enabled: true, subject: 'team@example.com', createdBy: robin, createdAt: ago(60 * 24 * 50) },
    { id: 'rule-drive-read', description: 'Read documents on docs.google.com', scope: 'site', behavior: 'auto', source: 'user', enabled: true, subject: 'docs.google.com', createdBy: robin, createdAt: ago(60 * 24 * 45) },
    { id: 'rule-linear-ask', description: 'Ask before creating Linear issues', scope: 'site', behavior: 'ask', source: 'team', enabled: true, subject: 'linear.app', createdBy: robin, createdAt: ago(60 * 24 * 40) },
    { id: 'rule-deploy-handoff', description: 'Hand production deploys to me', scope: 'action', behavior: 'handoff', source: 'user', enabled: true, subject: 'deploy', createdBy: robin, createdAt: ago(60 * 24 * 35) },
    { id: 'rule-npm-ask', description: 'Ask before publishing any package', scope: 'action', behavior: 'ask', source: 'user', enabled: true, subject: 'npm publish', createdBy: robin, createdAt: ago(60 * 24 * 30) },
    { id: 'rule-slack-auto', description: 'Post status updates in #eng without asking', scope: 'app', behavior: 'auto', source: 'user', enabled: true, subject: 'Slack', createdBy: robin, createdAt: ago(60 * 24 * 20) },

    { id: 'rule-draft-priya', description: 'Allow emailing Priya without asking', scope: 'recipient', behavior: 'auto', source: 'agent_draft', enabled: false, subject: 'priya@example.com', draftedByRunId: 'run-inbox-triage', rationale: 'You approved 6 of 6 emails to Priya this month.', createdAt: ago(60 * 8) },
    { id: 'rule-draft-sentry', description: 'Only touch Sentry when I ask', scope: 'site', behavior: 'on_command', source: 'agent_draft', enabled: false, subject: 'sentry.io', draftedByRunId: 'run-pr-review', rationale: 'You denied the last Sentry connection request.', createdAt: ago(60 * 6) },
  ];
  rules.push({ id: 'rule-ledger-figma', description: 'Allow buying from figma.com', scope: 'site', behavior: 'auto', source: 'user', enabled: true, subject: 'figma.com', agentId: 'agent-ledger', createdBy: robin, createdAt: ago(60 * 6) });
  rules.push({
    id: 'rule-delegation-speaking', description: 'Email replies on Gmail, up to 10 a day', scope: 'delegation', behavior: 'auto', source: 'user', enabled: true,
    agentId: 'agent-juno', createdBy: robin, createdAt: ago(60 * 24 * 3), useCount: 2, lastUsedAt: ago(60 * 2),
    delegation: { category: 'speaking', platformKey: 'app:gmail', limits: { replyOnly: true, maxPerDay: 10 } },
  });
  state.rules = rules;

  // --- agent tasks -----------------------------------------------------------
  const chatTask = { agentId: 'agent-juno', conversationId: 'conv-juno', origin: { type: 'owner_message', conversationId: 'conv-juno' }, replyTo: { type: 'none' } } as const;
  state.tasks = [
    { ...chatTask, id: 'task-juno-sub', rootRunId: 'run-research', parentId: 'run-research', depth: 1, mode: 'awaited', runId: 'run-research', kind: 'subagent', title: 'Benchmark Firecracker cold starts', status: 'running', progress: 'Running the 50-boot sample on the arm64 host', childRunId: 'run-research', startedAt: ago(14), updatedAt: ago(1) },
    { ...chatTask, id: 'task-juno-wait', rootRunId: 'run-research', parentId: 'run-research', depth: 1, mode: 'background', runId: 'run-research', kind: 'task', title: 'Choose the baseline to optimise for', status: 'waiting', waitingFor: 'owner_input', progress: 'Which baseline matters more, cold or warm starts?', startedAt: ago(19), updatedAt: ago(19) },
    { ...chatTask, id: 'task-juno-cmd', rootRunId: 'run-build', depth: 0, mode: 'background', kind: 'command', title: 'npm run build', status: 'ended', outcome: 'done', resultLine: 'Exited with code 0', startedAt: ago(60 * 2), updatedAt: ago(60 * 2 - 3), finishedAt: ago(60 * 2 - 3) },
    { ...chatTask, id: 'task-juno-conn', rootRunId: 'run-mail', depth: 0, mode: 'background', kind: 'connector', title: 'Fetch unread mail from Gmail', status: 'ended', outcome: 'done', resultLine: 'Listed 16 unread threads', startedAt: ago(60 * 5), updatedAt: ago(60 * 5 - 1), finishedAt: ago(60 * 5 - 1) },
    { ...chatTask, id: 'task-juno-fail', rootRunId: 'run-link', depth: 0, mode: 'background', kind: 'task', title: 'Link the memo to LIN-482', status: 'ended', outcome: 'failed', outcomeDetail: 'verification_failed', resultLine: 'Linear sign-in was refused', startedAt: ago(60 * 30), updatedAt: ago(60 * 30 - 4), finishedAt: ago(60 * 30 - 4) },
    { ...chatTask, id: 'task-juno-old', rootRunId: 'run-ci', depth: 0, mode: 'background', kind: 'wait', title: 'Wait for the CI build', status: 'ended', outcome: 'cancelled', outcomeDetail: 'stopped_by_owner', resultLine: 'Stopped by you', startedAt: ago(60 * 52), updatedAt: ago(60 * 52 - 2), finishedAt: ago(60 * 52 - 2) },
    { agentId: 'agent-juno', id: 'task-juno-digest', rootRunId: 'run-digest', runId: 'run-digest', kind: 'routine', routineId: 'routine-weekly-digest', depth: 0, origin: { type: 'routine', routineId: 'routine-weekly-digest', occurrenceAt: ago(60 * 8) }, mode: 'scheduled', replyTo: { type: 'delivery', channel: 'chat' }, title: 'Weekly digest', status: 'ended', outcome: 'done', resultLine: 'Sent the digest', startedAt: ago(60 * 8), updatedAt: ago(60 * 8 - 6), finishedAt: ago(60 * 8 - 6) },
  ];

  // --- audit ---------------------------------------------------------------
  state.audit = [
    { id: 'audit-01', at: ago(25), actor: 'agent', agentId: 'agent-juno', action: 'Send email to team@example.com', target: 'Gmail', decision: 'asked', reason: 'Recipient-scoped approval (built-in rule)', ruleId: 'rule-builtin-recipient', requestId: 'req-juno-email', runId: 'run-research' },
    { id: 'audit-02', at: ago(29), actor: 'user', memberId: robin, action: 'Create calendar event for priya@example.com', target: 'Google Calendar', decision: 'approved', reason: 'Approved once by you', requestId: 'req-resolved-invite' },
    { id: 'audit-03', at: ago(30), actor: 'agent', agentId: 'agent-juno', action: 'Create calendar event for priya@example.com', target: 'Google Calendar', decision: 'asked', reason: 'Recipient-scoped approval (built-in rule)', ruleId: 'rule-builtin-recipient', requestId: 'req-resolved-invite' },
    { id: 'audit-04', at: ago(45), actor: 'agent', agentId: 'agent-patch', action: 'Install playwright@1.48.0', target: 'Computer', decision: 'asked', reason: 'Installing unknown software (built-in rule)', ruleId: 'rule-builtin-software', requestId: 'req-patch-install', runId: 'run-pr-review' },
    { id: 'audit-05', at: ago(60 * 6), actor: 'user', memberId: robin, action: 'Purchase 5 Figma annual seats', target: 'Figma', decision: 'approved', reason: 'Approved and remembered for this recipient', requestId: 'req-resolved-figma' },
    { id: 'audit-06', at: ago(60 * 6 + 5), actor: 'agent', agentId: 'agent-ledger', action: 'Purchase 5 Figma annual seats', target: 'Figma', decision: 'asked', reason: 'Purchases need approval (built-in rule)', ruleId: 'rule-builtin-purchase', requestId: 'req-resolved-figma' },
    { id: 'audit-07', at: ago(60 * 52), actor: 'agent', agentId: 'agent-patch', action: 'Force-push to origin/main', target: 'GitHub', decision: 'asked', reason: 'Permanent destructive action (built-in rule)', ruleId: 'rule-builtin-delete', requestId: 'req-resolved-forcepush' },
    { id: 'audit-08', at: ago(60 * 52 - 2), actor: 'user', memberId: robin, action: 'Force-push to origin/main', target: 'GitHub', decision: 'denied', reason: 'You denied it: “Open a PR instead.”', requestId: 'req-resolved-forcepush' },
    { id: 'audit-09', at: ago(60 * 7), actor: 'agent', agentId: 'agent-ledger', action: 'Read Stripe charges', target: 'Stripe', decision: 'auto_allowed', reason: 'Read-only access already granted', ruleId: 'rule-builtin-access' },
    { id: 'audit-10', at: ago(60 * 9), actor: 'agent', agentId: 'agent-juno', action: 'Draft replies for 3 threads', target: 'Gmail', decision: 'auto_allowed', reason: 'Drafting rule (no send)', ruleId: 'rule-gmail-command', runId: 'run-inbox-triage' },
    { id: 'audit-11', at: ago(60 * 40), actor: 'user', memberId: robin, action: 'Choose run-log destination', target: 'Juno', decision: 'approved', reason: 'Answered: Local only', requestId: 'req-resolved-logdest' },
    { id: 'audit-12', at: ago(60 * 24 * 3), actor: 'system', action: 'Expire Sentry connection request', target: 'Sentry', decision: 'handed_off', reason: 'Expired after 24h with no decision', requestId: 'req-expired-sentry' },
    { id: 'audit-13', at: ago(60 * 5), actor: 'agent', agentId: 'agent-echo', action: 'Create Notion page for “Launch prep”', target: 'Notion', decision: 'auto_allowed', reason: 'App-level rule: write notes automatically', ruleId: 'rule-calendar-auto', runId: 'run-meeting-notes' },
    { id: 'audit-14', at: ago(60 * 14), actor: 'agent', agentId: 'agent-patch', action: 'Deploy web to staging', target: 'Vercel', decision: 'handed_off', reason: 'Production deploy handed to you', ruleId: 'rule-deploy-handoff', runId: 'run-deploy' },
    { id: 'audit-15', at: ago(60 * 24), actor: 'agent', agentId: 'agent-juno', action: 'Post weekly digest to chat', target: 'Slack', decision: 'auto_allowed', reason: 'Recurring routine delivery', ruleId: 'rule-slack-auto' },
    { id: 'audit-16', at: ago(60 * 3), actor: 'agent', agentId: 'agent-patch', action: 'Read CI check status', target: 'GitHub', decision: 'auto_allowed', reason: 'Read-only repository access', runId: 'run-pr-review' },
    { id: 'audit-17', at: ago(60 * 33), actor: 'agent', agentId: 'agent-juno', action: 'Upload memo to Google Drive', target: 'Google Drive', decision: 'auto_allowed', reason: 'Read/write within the Research folder', runId: 'run-research' },
    { id: 'audit-18', at: ago(60 * 2), actor: 'agent', agentId: 'agent-juno', action: 'Classify 37 inbox threads', target: 'Gmail', decision: 'auto_allowed', reason: 'Triage rule — no external effect', runId: 'run-live' },
    { id: 'audit-19', at: ago(35), actor: 'agent', agentId: 'agent-atlas', action: 'Hold Lisbon venue and flights', target: 'Computer', decision: 'asked', reason: 'Purchases need approval (built-in rule)', ruleId: 'rule-builtin-purchase', requestId: 'req-atlas-travel', runId: 'run-offsite' },
    { id: 'audit-20', at: ago(60 * 29 - 3), actor: 'user', memberId: robin, action: 'Send three candidate intros', target: 'Gmail', decision: 'approved', reason: 'Approved once by you', requestId: 'req-resolved-intro' },
  ].map((row): AuditEntry => {
    // Who started the work: most of it is the owner typing; two routine runs, a stranger's Telegram message and a system action are not.
    const unattended: Record<string, AuditEntry['initiator']> = {
      'audit-12': { type: 'system', wakeKind: 'request_expired', label: 'a request expired' },
      'audit-15': { type: 'routine', routineId: 'routine-weekly-digest', occurrenceAt: ago(60 * 24) },
      'audit-16': { type: 'routine', routineId: 'routine-ci-watch', occurrenceAt: ago(60 * 3) },
      'audit-19': { type: 'channel', channel: 'telegram', conversationId: 'conv-atlas', speaker: 'stranger' },
    };
    const initiator = unattended[row.id] ?? { type: 'owner_message', conversationId: 'conv-juno' };
    return { ...row, initiator, unattended: unattended[row.id] !== undefined } as AuditEntry;
  });

  // --- memory: claims and the files they were written into ------------------
  const claimSeeds: ReadonlyArray<readonly [string, MemoryClaim['status'], number, string, string, string, string]> = [
    ['claim-01', 'active', 0.95, 'Prefers concise updates: three bullets, no preamble.', 'keep it to three bullets please', 'MEMORY.md', 'item-seed-1'],
    ['claim-02', 'active', 0.9, 'Wants to approve anything that leaves the workspace.', 'ask me before anything goes out', 'MEMORY.md', 'item-seed-2'],
    ['claim-03', 'active', 0.8, 'Reads research memos with a table column for cost.', 'add a cost column to the table', 'memory/bank/preferences.md', 'item-seed-3'],
    ['claim-04', 'active', 0.85, 'Accountant is Marta; invoices go to marta@ledgerbooks.dev.', 'send the invoices to Marta, marta@ledgerbooks.dev', 'people/marta.md', 'item-seed-4'],
    ['claim-05', 'superseded', 0.7, 'Weekly digest is due Fridays.', 'digest on Fridays', 'MEMORY.md', 'item-seed-5'],
    ['claim-06', 'retracted', 0.6, 'Likes emoji in replies.', 'emoji are fine', 'memory/bank/preferences.md', 'item-seed-6'],
  ];
  state.memoryClaims = claimSeeds.map(([id, status, confidence, text, quote, path, itemId], i) => ({
    id,
    text,
    status,
    confidence,
    evidence: [{ itemId, quote }],
    target: { path },
    createdAt: ago(60 * 24 * (10 - i)),
    updatedAt: ago(60 * 24 * (10 - i)),
  }));
  const memoryFiles: ReadonlyArray<readonly [string, string, 'user' | 'agent' | 'platform']> = [
    ['MEMORY.md', '# Memory\n\n- Prefers concise updates: three bullets, no preamble. [claim:claim-01]\n- Wants to approve anything that leaves the workspace. [claim:claim-02]\n', 'platform'],
    ['memory/bank/preferences.md', '# Preferences\n\n- Reads research memos with a table column for cost. [claim:claim-03]\n', 'platform'],
    ['memory/bank/circumstances.md', '# Circumstances\n', 'platform'],
    ['memory/bank/experiences.md', '# Experiences\n', 'platform'],
    ['people/marta.md', '# Marta\n\nThe accountant.\n\n- Invoices go to marta@ledgerbooks.dev. [claim:claim-04]\n\n## Ledger（agent-ledger）\n\nSends her the monthly invoices.\n', 'platform'],
    ['memory/2026-10-13/agent-juno.md', '- 09:10 Asked for the digest in three bullets.\n', 'agent'],
    ['memory/2026-10-12/agent-juno.md', '- 14:02 Reviewed the Firecracker decision.\n', 'agent'],
    ['ALIGNMENT_SYNTHESIS.md', '- Keep replies short.\n', 'platform'],
  ];
  state.home.push(
    ...memoryFiles.map(([path, content, writer]) => ({ path, content, hash: `seed-${path}`, writer, updatedAt: ago(60) })),
  );

  // --- routines ------------------------------------------------------------
  const routines: Routine[] = [
    {
      id: 'routine-weekly-digest', agentId: 'agent-juno',
      name: 'Weekly research digest',
      instructions: 'Collect the week’s research threads and new sources, then post a short digest to chat.',
      trigger: { kind: 'schedule', cron: '0 9 * * 1', human: 'Weekly on Monday 9:00 (Asia/Singapore)', tz: 'Asia/Singapore' },
      delivery: { channel: 'chat' }, notify: { mode: 'always', channel: 'desktop' },
      enabled: true, status: 'active', lastRunAt: ago(60 * 24 * 6), lastRunStatus: 'completed', nextRunAt: ahead(60 * 42),
      runs: [
        mkRoutineRun('rr-digest-3', 'routine-weekly-digest', 'completed', 'Posted 9 sources, 3 highlights', nowMs - 60 * 24 * 6 * MINUTE, 4 * MINUTE),
        mkRoutineRun('rr-digest-2', 'routine-weekly-digest', 'completed', 'Posted 7 sources, 2 highlights', nowMs - 60 * 24 * 13 * MINUTE, 5 * MINUTE),
        mkRoutineRun('rr-digest-1', 'routine-weekly-digest', 'completed', 'Posted 6 sources', nowMs - 60 * 24 * 20 * MINUTE, 3 * MINUTE),
      ],
      createdAt: ago(60 * 24 * 20),
    },
    {
      id: 'routine-inbox-triage', agentId: 'agent-juno',
      name: 'Daily inbox triage',
      instructions: 'Sort new mail into Action / Waiting / Read and draft replies for the Action pile.',
      trigger: { kind: 'schedule', cron: '0 8 * * 1-5', human: 'Weekdays 8:00 (Asia/Singapore)', tz: 'Asia/Singapore' },
      delivery: { channel: 'chat' }, notify: { mode: 'on_failure', channel: 'desktop' },
      enabled: true, status: 'active', lastRunAt: ago(60 * 9), lastRunStatus: 'completed', nextRunAt: ahead(60 * 15),
      runs: [
        mkRoutineRun('rr-triage-3', 'routine-inbox-triage', 'completed', '21 threads sorted, 3 drafts', nowMs - 60 * 9 * MINUTE, 8 * MINUTE, 'run-inbox-triage'),
        mkRoutineRun('rr-triage-2', 'routine-inbox-triage', 'completed', '18 threads sorted, 2 drafts', nowMs - 60 * 33 * MINUTE, 7 * MINUTE),
        mkRoutineRun('rr-triage-1', 'routine-inbox-triage', 'failed', 'Gmail token expired', nowMs - 60 * 57 * MINUTE, MINUTE),
      ],
      createdAt: ago(60 * 24 * 60),
    },
    {
      id: 'routine-pr-review', agentId: 'agent-patch',
      name: 'PR review sweep',
      instructions: 'When a new PR opens, run the tests and leave a structured review.',
      trigger: { kind: 'event', source: 'github', filter: 'New PR in acme/agent-desktop' },
      delivery: { channel: 'slack', target: '#eng' }, notify: { mode: 'on_failure', channel: 'slack' },
      enabled: true, status: 'active', lastRunAt: ago(12), lastRunStatus: 'completed',
      runs: [
        mkRoutineRun('rr-pr-2', 'routine-pr-review', 'running', 'Reviewing PR #214', nowMs - 12 * MINUTE, 0, 'run-pr-review'),
        mkRoutineRun('rr-pr-1', 'routine-pr-review', 'completed', 'Reviewed PR #209 — 1 blocking note', nowMs - 60 * 30 * MINUTE, 9 * MINUTE),
      ],
      createdAt: ago(60 * 24 * 45),
    },
    {
      id: 'routine-ci-watch', agentId: 'agent-patch',
      name: 'CI watch',
      instructions: 'When CI fails on main, triage the failure and either fix it or open an issue.',
      trigger: { kind: 'event', source: 'github', filter: 'CI failed on main' },
      delivery: { channel: 'slack', target: '#eng' }, notify: { mode: 'always', channel: 'slack' },
      enabled: true, status: 'active', lastRunAt: ago(1), lastRunStatus: 'completed',
      runs: [
        mkRoutineRun('rr-ci-2', 'routine-ci-watch', 'running', 'Triaging the failing main build', nowMs - MINUTE, 0, 'run-ci-triage'),
        mkRoutineRun('rr-ci-1', 'routine-ci-watch', 'completed', 'Re-ran the flaky pagination test', nowMs - 60 * 26 * MINUTE, 4 * MINUTE),
      ],
      createdAt: ago(60 * 24 * 40),
    },
    {
      id: 'routine-release-notes', agentId: 'agent-patch',
      name: 'Release notes from deploy webhook',
      instructions: 'When the release webhook fires, summarize merged commits into user-facing notes.',
      trigger: { kind: 'webhook', url: 'https://hooks.example.com/routines/rel-9f2c', secretMasked: 'whsec_••••8f21' },
      delivery: { channel: 'slack', target: '#releases' }, notify: { mode: 'always', channel: 'desktop' },
      enabled: true, status: 'active', lastRunAt: ago(60 * 24 * 2), lastRunStatus: 'completed',
      runs: [
        mkRoutineRun('rr-rel-1', 'routine-release-notes', 'completed', 'Drafted notes for v0.4.0 (12 changes)', nowMs - 60 * 24 * 2 * MINUTE, 5 * MINUTE),
      ],
      createdAt: ago(60 * 24 * 25),
    },
    {
      id: 'routine-invoice-chase', agentId: 'agent-ledger',
      name: 'Invoice chase',
      instructions: 'Reconcile the previous month and chase anything unpaid for more than 14 days.',
      trigger: { kind: 'schedule', cron: '0 10 1 * *', human: 'Monthly on the 1st at 10:00 (Asia/Singapore)', tz: 'Asia/Singapore', endDate: '2027-10-01' },
      delivery: { channel: 'email', target: 'finance@example.com' }, notify: { mode: 'always', channel: 'email' },
      enabled: true, status: 'error', lastRunAt: ago(60 * 24 * 24), lastRunStatus: 'failed', nextRunAt: ahead(60 * 24 * 3),
      runs: [
        mkRoutineRun('rr-invoice-2', 'routine-invoice-chase', 'failed', 'Stripe key missing read scope', nowMs - 60 * 24 * 24 * MINUTE, 2 * MINUTE),
        mkRoutineRun('rr-invoice-1', 'routine-invoice-chase', 'completed', 'Reconciled 41 invoices', nowMs - 60 * 24 * 55 * MINUTE, 11 * MINUTE),
      ],
      createdAt: ago(60 * 24 * 70),
    },
    {
      id: 'routine-standup', agentId: 'agent-echo',
      name: 'Daily standup draft',
      instructions: 'Collect yesterday’s activity into a three-line standup update and post it to #general.',
      trigger: { kind: 'schedule', cron: '45 8 * * 1-5', human: 'Weekdays 8:45 (Asia/Singapore)', tz: 'Asia/Singapore' },
      delivery: { channel: 'slack', target: '#general' }, notify: { mode: 'never' },
      enabled: true, status: 'active', lastRunAt: ago(60 * 8), lastRunStatus: 'completed', nextRunAt: ahead(60 * 24),
      runs: [
        mkRoutineRun('rr-standup-2', 'routine-standup', 'completed', 'Drafted standup for week 40', nowMs - 60 * 8 * MINUTE, 4 * MINUTE, 'run-standup'),
        mkRoutineRun('rr-standup-1', 'routine-standup', 'completed', 'Drafted standup for week 39', nowMs - 60 * 32 * MINUTE, 4 * MINUTE),
      ],
      createdAt: ago(60 * 24 * 30),
    },
    {
      id: 'routine-recruiting', agentId: 'agent-scout',
      name: 'Recruiting pipeline sweep',
      instructions: 'When a new application arrives, screen it, update the pipeline and draft a reply.',
      trigger: { kind: 'event', source: 'email', filter: 'New application to recruiting@example.com' },
      delivery: { channel: 'slack', target: '#hiring' }, notify: { mode: 'on_failure', channel: 'slack' },
      enabled: true, status: 'active', lastRunAt: ago(60 * 20), lastRunStatus: 'completed',
      runs: [
        mkRoutineRun('rr-rec-2', 'routine-recruiting', 'completed', 'Screened 5 applications, 2 to onsite', nowMs - 60 * 20 * MINUTE, 7 * MINUTE),
        mkRoutineRun('rr-rec-1', 'routine-recruiting', 'completed', 'Screened 3 applications', nowMs - 60 * 44 * MINUTE, 5 * MINUTE),
      ],
      createdAt: ago(60 * 24 * 35),
    },
    {
      id: 'routine-offsite', agentId: 'agent-atlas',
      name: 'Offsite planning',
      instructions: 'Track the offsite plan, chase confirmations and keep the shared calendar in sync.',
      trigger: { kind: 'schedule', cron: '0 11 * * 2', human: 'Weekly on Tuesday 11:00 (Asia/Singapore)', tz: 'Asia/Singapore' },
      delivery: { channel: 'chat' }, notify: { mode: 'always', channel: 'desktop' },
      enabled: true, status: 'active', lastRunAt: ago(60 * 30), lastRunStatus: 'completed', nextRunAt: ahead(60 * 24 * 6),
      runs: [
        mkRoutineRun('rr-offsite-1', 'routine-offsite', 'completed', 'Updated the Lisbon venue shortlist', nowMs - 60 * 30 * MINUTE, 6 * MINUTE, 'run-offsite'),
      ],
      createdAt: ago(60 * 24 * 9),
    },
  ];
  state.routines = routines;

  // --- secrets ------------------------------------------------------------
  state.secrets = [
    { id: 'secret-openai', name: 'Model provider key', scope: 'personal', source: 'manual', updatedAt: ago(60 * 24 * 30) },
    { id: 'secret-stripe', name: 'Stripe secret key', scope: 'team', source: 'manual', updatedAt: ago(60 * 24 * 38) },
    { id: 'secret-webhook', name: 'Release webhook secret', scope: 'team', source: 'manual', updatedAt: ago(60 * 24 * 25) },
    { id: 'secret-1password', name: '1Password service token', scope: 'personal', source: 'password_manager', updatedAt: ago(60 * 24 * 10) },
  ] as SecretMetadata[];

  // --- library -------------------------------------------------------------
  const librarySeeds: ReadonlyArray<readonly [string, string, LibraryItem['kind'], string, number, string | undefined, LibraryItem['shared'], LibraryItem['source'], boolean]> = [
    ['lib-sandbox-md', 'sandbox-comparison.md', 'document', 'text/markdown', 6120, 'agent-juno', 'team', 'agent', true],
    ['lib-sandbox-csv', 'sandbox-benchmarks.csv', 'file', 'text/csv', 24800, 'agent-juno', 'team', 'agent', false],
    ['lib-triage', 'inbox-2026-10-05.csv', 'file', 'text/csv', 4310, 'agent-juno', 'private', 'agent', false],
    ['lib-launch-notes', 'launch-prep.md', 'document', 'text/markdown', 8840, 'agent-echo', 'team', 'agent', false],
    ['lib-pr214', 'pr-214-review.md', 'document', 'text/markdown', 3320, 'agent-patch', 'team', 'agent', false],
    ['lib-roadmap', 'q4-roadmap.canvas', 'canvas', 'application/json', 18700, 'agent-juno', 'team', 'agent', false],
    ['lib-invoices', 'invoices-october.pdf', 'file', 'application/pdf', 402100, 'agent-ledger', 'private', 'agent', false],
    ['lib-recon', 'reconciliation-october.csv', 'file', 'text/csv', 15200, 'agent-ledger', 'private', 'agent', false],
    ['lib-brand', 'brand-banner.png', 'image', 'image/png', 862000, undefined, 'team', 'upload', false],
    ['lib-team-photo', 'offsite-2026.jpg', 'image', 'image/jpeg', 2410000, undefined, 'team', 'upload', false],
    ['lib-contract', 'vendor-contract.pdf', 'file', 'application/pdf', 980000, undefined, 'private', 'upload', false],
    ['lib-release', 'release-notes-v0.4.0.md', 'document', 'text/markdown', 5120, 'agent-patch', 'team', 'agent', false],
    ['lib-candidates', 'design-candidates.csv', 'file', 'text/csv', 9800, 'agent-scout', 'private', 'agent', false],
    ['lib-standup', 'standup-week-40.md', 'document', 'text/markdown', 1980, 'agent-echo', 'private', 'agent', false],
    ['lib-budget', 'budget-2027.xlsx', 'file', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 66200, 'agent-ledger', 'private', 'agent', true],
    ['lib-preview-order', 'screen-order.png', 'image', 'image/svg+xml', 3200, 'agent-ledger', 'private', 'agent', false],
  ];
  const convForAgent: Record<string, string> = {
    'agent-juno': 'conv-juno',
    'agent-patch': 'conv-patch',
    'agent-ledger': 'conv-ledger',
    'agent-echo': 'conv-echo',
    'agent-scout': 'conv-scout',
    'agent-atlas': 'conv-atlas',
    'agent-new': 'conv-new',
  };
  state.library = librarySeeds.map(([id, name, kind, mimeType, sizeBytes, agentId, shared, source, pinned], i) => ({
    id,
    name,
    kind,
    mimeType,
    sizeBytes,
    createdByAgentId: agentId,
    conversationId: agentId ? convForAgent[agentId] : undefined,
    runId: id === 'lib-sandbox-md' ? 'run-research' : undefined,
    shared,
    source,
    previewUrl: `https://files.example.com/library/${id}`,
    tags: [kind],
    pinned,
    folder: kind === 'image' ? 'Media' : 'Research',
    createdAt: ago(60 * 24 * (20 - i)),
    updatedAt: ago(60 * (i * 3 + 1)),
  })) as LibraryItem[];

  // Published artifacts (BACKEND §5.11): one of each render type, so the cards can be seen without a backend.
  const publishedVersion = (id: string, version: number, mimeType: string, extra: Partial<ArtifactVersion> = {}): ArtifactVersion => ({
    version,
    fileRef: `af-${id}-${version}`,
    sizeBytes: 2400 * version,
    mimeType,
    createdAt: ago(60 * (4 - version) + 10),
    ...extra,
  });
  const published: ReadonlyArray<readonly [string, string, LibraryItem['kind'], NonNullable<LibraryItem['render']>, string, ArtifactVersion[]]> = [
    ['lib-art-trip', 'KL trip planner', 'canvas', 'html', 'text/html', [publishedVersion('lib-art-trip', 1, 'text/html'), publishedVersion('lib-art-trip', 2, 'text/html')]],
    ['lib-art-report', 'quarterly-report.docx', 'document', 'file', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', [publishedVersion('lib-art-report', 1, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', { previewRef: 'af-lib-art-report-1-p', thumbnailRef: 'af-lib-art-report-1-t' })]],
    ['lib-art-readme', 'launch-checklist.md', 'document', 'file', 'text/markdown', [publishedVersion('lib-art-readme', 1, 'text/markdown')]],
    ['lib-art-poster', 'launch-poster.png', 'image', 'image', 'image/png', [publishedVersion('lib-art-poster', 1, 'image/png')]],
  ];
  published.forEach(([id, name, kind, render, mimeType, versions], i) => {
    const latest = versions[versions.length - 1] as ArtifactVersion;
    state.library.push({
      id, name, kind, mimeType, sizeBytes: latest.sizeBytes,
      createdByAgentId: 'agent-juno', conversationId: 'conv-new', shared: 'private', source: 'agent',
      render, version: latest.version, versions, tags: [], pinned: false,
      createdAt: ago(60 * 70), updatedAt: ago(60 * 60 + i),
    } as LibraryItem);
  });

  // Spaces (BACKEND §5.12): two apps, one running and one whose computer is paused, each with its chat card.
  const spaceSeeds = [
    ['sp-budget', 'lib-app-budget', 'Budget tracker', 'budget-tracker', 'running'],
    ['sp-recipes', 'lib-app-recipes', 'Recipe box', 'recipe-box', 'computer_paused'],
  ] as const;
  spaceSeeds.forEach(([spaceId, artifactId, title, slug, status], i) => {
    state.library.push({
      id: artifactId, name: title, kind: 'canvas', mimeType: 'application/x-juno-space', sizeBytes: 0,
      createdByAgentId: 'agent-juno', conversationId: 'conv-new', shared: 'private', source: 'agent',
      render: 'app', spaceId, tags: [], pinned: false, createdAt: ago(60 * 50), updatedAt: ago(60 * 40 + i),
    } as LibraryItem);
    state.spaces.push({ id: spaceId, title, slug, agentId: 'agent-juno', artifactId, status, createdAt: ago(60 * 50), updatedAt: ago(60 * 40 + i) });
  });

  // --- usage ---------------------------------------------------------------
  const weekStart = new Date(nowMs);
  const dayOfWeek = (weekStart.getUTCDay() + 6) % 7; // Monday = 0
  const weekStartMs = nowMs - (dayOfWeek * DAY + (weekStart.getUTCHours() * HOUR + weekStart.getUTCMinutes() * MINUTE));
  const usage: Usage = {
    week: {
      start: iso(weekStartMs),
      end: iso(weekStartMs + 7 * DAY),
      inputTokens: 1_284_500,
      outputTokens: 164_300,
      computeSeconds: 24_860,
      costUsd: 38.42,
      limitUsd: 60,
      percent: 0.64,
    },
    byAgent: [
      { agentId: 'agent-juno', runs: 41, inputTokens: 612_400, outputTokens: 82_100, computeSeconds: 11_240, costUsd: 18.9 },
      { agentId: 'agent-patch', runs: 33, inputTokens: 402_100, outputTokens: 51_800, computeSeconds: 8_620, costUsd: 12.4 },
      { agentId: 'agent-ledger', runs: 12, inputTokens: 148_200, outputTokens: 18_400, computeSeconds: 2_940, costUsd: 4.6 },
      { agentId: 'agent-echo', runs: 9, inputTokens: 121_800, outputTokens: 12_000, computeSeconds: 2_060, costUsd: 2.52 },
      { agentId: 'agent-scout', runs: 7, inputTokens: 68_400, outputTokens: 7_900, computeSeconds: 1_180, costUsd: 1.42 },
      { agentId: 'agent-atlas', runs: 5, inputTokens: 44_200, outputTokens: 5_100, computeSeconds: 860, costUsd: 0.98 },
      { agentId: 'agent-new', runs: 0, inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0 },
    ],
    byApp: [
      { app: 'Gmail', runs: 48, costUsd: 9.8 },
      { app: 'GitHub', runs: 31, costUsd: 7.4 },
      { app: 'Slack', runs: 22, costUsd: 5.1 },
      { app: 'Google Calendar', runs: 14, costUsd: 2.2 },
      { app: 'Notion', runs: 11, costUsd: 3.4 },
      { app: 'Linear', runs: 9, costUsd: 2.8 },
      { app: 'Stripe', runs: 6, costUsd: 1.6 },
      { app: 'Google Drive', runs: 5, costUsd: 1.2 },
    ],
  };
  state.usage = usage;

  // --- settings ------------------------------------------------------------
  const settings: AppSettings = {
    general: { launchAtLogin: true, defaultAgentId: 'agent-juno', language: 'en' },
    appearance: { theme: 'system', density: 'comfortable', accent: 'violet' },
    notifications: [
      { type: 'approval', enabled: true, channels: ['desktop', 'slack'] },
      { type: 'question', enabled: true, channels: ['desktop'] },
      { type: 'routine', enabled: true, channels: ['desktop'] },
      { type: 'task_failed', enabled: true, channels: ['desktop', 'email'] },
      { type: 'computer', enabled: false, channels: [] },
    ],
    yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: 'not_requested' },
    connections: {
      serverUrl: 'https://api.example.com',
      modelProviders: [
        { id: 'prov-anthropic', name: 'Anthropic', kind: 'builtin', providerId: 'anthropic', hasKey: true },
        { id: 'prov-local', name: 'Local (vLLM)', kind: 'custom', baseUrl: 'http://localhost:8000/v1', wire: 'openai-completions', hasKey: false },
      ],
    },
    privacy: { dataRetentionDays: 30, trainingOptIn: false },
    advanced: { releaseTrack: 'stable', logsEnabled: false, networkDebugger: false },
    models: { defaultModel: null },
  };
  state.settings = settings;

  // --- items (assembled last, they reference everything above) -------------
  const itemsFor = (conversationId: string, rows: Item[]): void => {
    state.items.set(conversationId, rows);
  };

  // The blank agent the user just created: only a greeting.
  itemsFor('conv-new', [
    {
      id: 'item-new-01', conversationId: 'conv-new', at: iso(nowMs), type: 'agent_message', agentId: 'agent-new',
      markdown: 'Hi — I’m your new agent. What should I take care of? Tell me what you need and I’ll set myself up (name, look, apps, and a first routine).',
      citations: [],
    },
  ] as Item[]);

  // Juno's main conversation carries every Item variant (ARCHITECTURE §2).
  itemsFor('conv-juno', [
    {
      id: 'item-juno-01', conversationId: 'conv-juno', at: ago(180), type: 'user_message', authorId: robin,
      text: 'We need to pick a sandbox for the agent computers. Can you compare Firecracker and gVisor for our workload and write it up?',
      attachments: [], mentions: [{ kind: 'agent', id: 'agent-juno', label: '@Juno' }],
    },
    {
      id: 'item-juno-02', conversationId: 'conv-juno', at: ago(178), type: 'agent_message', agentId: 'agent-juno',
      markdown: 'On it. I’ll read the Firecracker and gVisor docs, pull one published benchmark set, then write **sandbox-comparison.md** with a decision table.',
      citations: [],
    },
    { id: 'item-juno-03', conversationId: 'conv-juno', at: ago(177), type: 'run', runId: 'run-research' },
    { id: 'item-juno-04', conversationId: 'conv-juno', at: ago(176), type: 'plan', runId: 'run-research', todos: [
      { id: 'todo-r1', text: 'Read the Firecracker architecture docs', status: 'done' },
      { id: 'todo-r2', text: 'Read the gVisor overview and security model', status: 'done' },
      { id: 'todo-r3', text: 'Collect benchmark numbers for both runtimes', status: 'done' },
      { id: 'todo-r4', text: 'Write sandbox-comparison.md with a decision table', status: 'done' },
      { id: 'todo-r5', text: 'Get your sign-off on the recommended runtime', status: 'in_progress' },
    ] },
    {
      id: 'item-juno-05', conversationId: 'conv-juno', at: ago(30), type: 'agent_message', agentId: 'agent-juno',
      markdown: [
        'Done — here’s the short version.',
        '',
        '| | Firecracker | gVisor |',
        '| --- | --- | --- |',
        '| Isolation | hardware (KVM) | user-space kernel |',
        '| Cold start (p50) | **128 ms** | 171 ms |',
        '| Memory overhead | ~5 MB | ~40 MB |',
        '| Syscall cost | native | +20–40% |',
        '',
        'Recommendation: **Firecracker for our own agents**, gVisor for untrusted third-party code.',
      ].join('\n'),
      citations: [
        { id: 'cit-1', title: 'Firecracker design and architecture', url: 'https://firecracker-microvm.github.io/', source: 'firecracker-microvm.github.io' },
        { id: 'cit-2', title: 'What is gVisor?', url: 'https://gvisor.dev/docs/', source: 'gvisor.dev' },
        { id: 'cit-3', title: 'Sandbox decision (memory)', memoryId: 'mem-12' },
      ],
    },
    { id: 'item-juno-06', conversationId: 'conv-juno', at: ago(28), type: 'artifact', artifactId: 'lib-sandbox-md' },
    { id: 'item-juno-art-1', conversationId: 'conv-juno', at: ago(26), type: 'artifact', artifactId: 'lib-art-trip', version: 2 },
    { id: 'item-juno-art-2', conversationId: 'conv-juno', at: ago(25), type: 'artifact', artifactId: 'lib-art-report', version: 1 },
    { id: 'item-juno-art-3', conversationId: 'conv-juno', at: ago(24), type: 'artifact', artifactId: 'lib-art-readme', version: 1 },
    { id: 'item-juno-art-4', conversationId: 'conv-juno', at: ago(23), type: 'artifact', artifactId: 'lib-art-poster', version: 1 },
    { id: 'item-juno-art-5', conversationId: 'conv-juno', at: ago(22), type: 'artifact', artifactId: 'lib-app-budget' },
    { id: 'item-juno-art-6', conversationId: 'conv-juno', at: ago(21), type: 'artifact', artifactId: 'lib-app-recipes' },
    { id: 'item-juno-07', conversationId: 'conv-juno', at: ago(25), type: 'request', requestId: 'req-juno-email' },
    {
      id: 'item-juno-08', conversationId: 'conv-juno', at: ago(20), type: 'agent_message', agentId: 'agent-juno',
      markdown: 'One thing I can’t decide for you: should I optimise for cold-start latency or isolation strength? That changes how I phrase the recommendation for third-party workloads.',
      citations: [],
    },
    { id: 'item-juno-09', conversationId: 'conv-juno', at: ago(19), type: 'request', requestId: 'req-juno-question' },
    { id: 'item-juno-10', conversationId: 'conv-juno', at: ago(15), type: 'request', requestId: 'req-juno-signin' },
    { id: 'item-juno-11', conversationId: 'conv-juno', at: ago(12), type: 'routine', routineId: 'routine-weekly-digest', change: 'created' },
    { id: 'item-juno-12', conversationId: 'conv-juno', at: ago(8), type: 'handoff', direction: 'to_user', durationMs: 132_000 },
    {
      id: 'item-juno-13', conversationId: 'conv-juno', at: ago(6), type: 'agent_message', agentId: 'agent-juno',
      markdown: 'Welcome back — I picked up where we left off and started triaging today’s inbox while you were away.',
      citations: [],
    },
    {
      id: 'item-juno-14', conversationId: 'conv-juno', at: ago(5), type: 'system', level: 'info',
      text: 'Computer resumed after being paused while you were away.',
      action: { label: 'View computer', command: 'computer.open' },
    },
    { id: 'item-juno-15', conversationId: 'conv-juno', at: ago(4), type: 'run', runId: 'run-live' },
  ] as Item[]);

  itemsFor('conv-patch', [
    {
      id: 'item-patch-01', conversationId: 'conv-patch', at: ago(120), type: 'user_message', authorId: robin,
      text: 'PR #214 touches the sign-in flow — can you review it and get the end-to-end tests running?',
      attachments: [], mentions: [{ kind: 'agent', id: 'agent-patch', label: '@Patch' }],
    },
    { id: 'item-patch-02', conversationId: 'conv-patch', at: ago(118), type: 'run', runId: 'run-pr-review' },
    { id: 'item-patch-03', conversationId: 'conv-patch', at: ago(50), type: 'run', runId: 'run-deploy' },
    {
      id: 'item-patch-04', conversationId: 'conv-patch', at: ago(49), type: 'system', level: 'error',
      text: 'Deploy to staging failed: 2 of 14 smoke checks failed (sign-in flow).',
      action: { label: 'Retry', command: 'run.retry' },
    },
    { id: 'item-patch-05', conversationId: 'conv-patch', at: ago(45), type: 'request', requestId: 'req-patch-install' },
    {
      id: 'item-patch-06', conversationId: 'conv-patch', at: ago(2), type: 'agent_message', agentId: 'agent-patch',
      markdown: 'Review of #214 is nearly done. The failure is in the sign-in smoke test, which is why I want Playwright installed. Once you approve, I’ll add coverage and re-run CI.',
      citations: [{ id: 'cit-patch-1', title: 'PR #214', url: 'https://github.com/acme/agent-desktop/pull/214' }],
    },
  ] as Item[]);

  itemsFor('conv-ledger', [
    {
      id: 'item-ledger-01', conversationId: 'conv-ledger', at: ago(60 * 21), type: 'user_message', authorId: robin,
      text: 'October closed this week — can you reconcile Stripe against the ledger and flag anything missing?',
      attachments: [], mentions: [],
    },
    {
      id: 'item-ledger-02', conversationId: 'conv-ledger', at: ago(60 * 20 - 1), type: 'agent_message', agentId: 'agent-ledger',
      markdown: 'I can, but I only have the old key — it can’t read invoices. I’ve asked for a read-only Stripe scope below.',
      citations: [],
    },
    { id: 'item-ledger-03', conversationId: 'conv-ledger', at: ago(60 * 20), type: 'request', requestId: 'req-ledger-stripe' },
    {
      id: 'item-ledger-04', conversationId: 'conv-ledger', at: ago(60 * 6 + 4), type: 'agent_message', agentId: 'agent-ledger',
      markdown: 'Also: the monthly Figma plan renews in three days. The annual plan saves 22% ($79). Should I switch it?',
      citations: [{ id: 'cit-ledger-1', title: 'Figma pricing', url: 'https://figma.com/pricing' }],
    },
    { id: 'item-ledger-05', conversationId: 'conv-ledger', at: ago(60 * 6), type: 'run', runId: 'run-purchase' },
    {
      id: 'item-ledger-06', conversationId: 'conv-ledger', at: ago(60 * 5), type: 'agent_message', agentId: 'agent-ledger',
      markdown: 'Held off on the Figma renewal until you confirm. The September expense report is filed and ready for the accountant.',
      citations: [],
    },
  ] as Item[]);

  itemsFor('conv-echo', [
    {
      id: 'item-echo-01', conversationId: 'conv-echo', at: ago(60 * 27), type: 'user_message', authorId: robin,
      text: 'Here’s the recording of “Launch prep”. Decisions and follow-ups in Notion, please.',
      attachments: [{ id: 'att-rec', name: 'launch-prep-2026-10-04.m4a', kind: 'file', mimeType: 'audio/mp4', sizeBytes: 18_400_000 }],
      mentions: [],
    },
    { id: 'item-echo-02', conversationId: 'conv-echo', at: ago(60 * 26), type: 'run', runId: 'run-meeting-notes' },
    {
      id: 'item-echo-03', conversationId: 'conv-echo', at: ago(60 * 25), type: 'agent_message', agentId: 'agent-echo',
      markdown: 'Filed. 6 decisions, 9 follow-ups, owners named. The launch checklist is owned by Priya; the sandbox memo is a dependency (Juno).',
      citations: [{ id: 'cit-echo-1', title: 'Meetings / Launch prep', url: 'https://notion.so/acme/launch-prep' }],
    },
    { id: 'item-echo-04', conversationId: 'conv-echo', at: ago(60 * 5 + 2), type: 'artifact', artifactId: 'lib-launch-notes' },
    {
      id: 'item-echo-05', conversationId: 'conv-echo', at: ago(60 * 5), type: 'agent_message', agentId: 'agent-echo',
      markdown: 'Notes are in Notion and I posted the standup draft to #general. Ping me if you want a recap before the review.',
      citations: [],
    },
  ] as Item[]);

  itemsFor('conv-scout', [
    {
      id: 'item-scout-01', conversationId: 'conv-scout', at: ago(60 * 4), type: 'user_message', authorId: robin,
      text: 'We’re hiring a product designer. Can you source candidates and draft warm intros?',
      attachments: [], mentions: [{ kind: 'agent', id: 'agent-scout', label: '@Scout' }],
    },
    {
      id: 'item-scout-02', conversationId: 'conv-scout', at: ago(60 * 3), type: 'agent_message', agentId: 'agent-scout',
      markdown: 'On it — pulling from the network and the design community, and looking for a mutual contact for each intro.',
      citations: [],
    },
    { id: 'item-scout-03', conversationId: 'conv-scout', at: ago(21), type: 'run', runId: 'run-sourcing' },
    {
      id: 'item-scout-04', conversationId: 'conv-scout', at: ago(20), type: 'agent_message', agentId: 'agent-scout',
      markdown: '8 candidates sourced, 3 worth an intro this week. I sent the three intro drafts for your approval.',
      citations: [],
    },
  ] as Item[]);

  itemsFor('conv-atlas', [
    {
      id: 'item-atlas-01', conversationId: 'conv-atlas', at: ago(60 * 2), type: 'user_message', authorId: robin,
      text: 'Plan the Lisbon offsite for the week of Nov 10 — venue, flights and a budget.',
      attachments: [], mentions: [{ kind: 'agent', id: 'agent-atlas', label: '@Atlas' }],
    },
    {
      id: 'item-atlas-02', conversationId: 'conv-atlas', at: ago(60 * 1), type: 'agent_message', agentId: 'agent-atlas',
      markdown: 'Drafting a plan; Ledger will confirm the budget cap before I hold anything.',
      citations: [],
    },
    { id: 'item-atlas-03', conversationId: 'conv-atlas', at: ago(45), type: 'run', runId: 'run-offsite' },
    {
      id: 'item-atlas-04', conversationId: 'conv-atlas', at: ago(40), type: 'agent_message', agentId: 'agent-atlas',
      markdown: 'Shortlisted three venues in Lisbon and priced two travel options per person. Budget lands at ~$9.4k.',
      citations: [],
    },
    { id: 'item-atlas-05', conversationId: 'conv-atlas', at: ago(35), type: 'request', requestId: 'req-atlas-travel' },
    {
      id: 'item-atlas-06', conversationId: 'conv-atlas', at: ago(35), type: 'agent_message', agentId: 'agent-atlas',
      markdown: 'Venue holds expire Friday — approve the booking and I’ll confirm the whole week.',
      citations: [],
    },
  ] as Item[]);

  // Rooms: agents hand work to each other.
  itemsFor('conv-launch', [
    {
      id: 'item-launch-01', conversationId: 'conv-launch', at: ago(200), type: 'user_message', authorId: robin,
      text: 'Beta target is 2026-11-03. Let’s keep this room for blockers only.',
      attachments: [], mentions: [],
    },
    {
      id: 'item-launch-02', conversationId: 'conv-launch', at: ago(196), type: 'agent_message', agentId: 'agent-juno',
      markdown: 'Noted. Blocker I’m tracking: the sandbox decision (Firecracker vs gVisor) gates the computer images.',
      citations: [],
    },
    {
      id: 'item-launch-03', conversationId: 'conv-launch', at: ago(150), type: 'agent_message', agentId: 'agent-patch',
      markdown: 'Blocker on my side: sign-in smoke tests. Requested the Playwright install to cover the new flow.',
      citations: [],
    },
    {
      id: 'item-launch-04', conversationId: 'conv-launch', at: ago(120), type: 'user_message', authorId: priya,
      text: 'I’ll take the launch checklist. @Juno can you send the sandbox memo here when it’s ready?',
      attachments: [], mentions: [{ kind: 'agent', id: 'agent-juno', label: '@Juno' }],
    },
    {
      id: 'item-launch-05', conversationId: 'conv-launch', at: ago(60), type: 'agent_message', agentId: 'agent-echo',
      markdown: 'Notes from “Launch prep” are filed — 6 decisions, 9 follow-ups, owners named.',
      citations: [],
    },
    {
      id: 'item-launch-06', conversationId: 'conv-launch', at: ago(55), type: 'agent_message', agentId: 'agent-juno',
      markdown: 'Asking Patch to check the CI run before we freeze the branch.',
      citations: [],
    },
    {
      id: 'item-launch-07', conversationId: 'conv-launch', at: ago(50), type: 'agent_message', agentId: 'agent-patch',
      markdown: 'CI is green on main; the sign-in test is the only gap. Echo, can you note that as the last open follow-up?',
      citations: [],
    },
  ] as Item[]);

  itemsFor('conv-offsite', [
    {
      id: 'item-offsite-01', conversationId: 'conv-offsite', at: ago(60 * 9), type: 'user_message', authorId: robin,
      text: 'Let’s do the offsite the week of Nov 10. Atlas, take point.',
      attachments: [], mentions: [{ kind: 'agent', id: 'agent-atlas', label: '@Atlas' }],
    },
    {
      id: 'item-offsite-02', conversationId: 'conv-offsite', at: ago(60 * 8), type: 'agent_message', agentId: 'agent-atlas',
      markdown: 'On it — three venues shortlisted in Lisbon. Ledger, can you confirm the budget cap?',
      citations: [],
    },
    {
      id: 'item-offsite-03', conversationId: 'conv-offsite', at: ago(60 * 7), type: 'agent_message', agentId: 'agent-ledger',
      markdown: 'Budget approved up to $18k; flag anything above that and I’ll re-check against this quarter’s spend.',
      citations: [],
    },
    {
      id: 'item-offsite-04', conversationId: 'conv-offsite', at: ago(60 * 6), type: 'agent_message', agentId: 'agent-scout',
      markdown: 'I’ll gather headcount and dietary notes from the team and put them in the shared doc.',
      citations: [],
    },
    {
      id: 'item-offsite-05', conversationId: 'conv-offsite', at: ago(60 * 5), type: 'agent_message', agentId: 'agent-atlas',
      markdown: 'Flights hold until Friday; Ledger, ok to book once the user approves?',
      citations: [],
    },
  ] as Item[]);

  for (const conv of state.conversations) refreshConversation(state, conv.id);

  return state;
}

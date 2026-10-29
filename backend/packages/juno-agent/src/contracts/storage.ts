import type { BrowserGoalGate } from './browser-goals.js';
import type {
  ActionsPolicy,
  AppCategory,
  ConnectorCategory,
  Agent,
  AgentHomeFile,
  AppSettings,
  AuditEntry,
  Computer,
  Connection,
  Conversation,
  DocumentDraft,
  FeedPost,
  Goal,
  Idea,
  AgentCalendarItem,
  Item,
  LibraryItem,
  Meal,
  Plugin,
  Routine,
  Rule,
  Run,
  RunOrigin,
  Step,
  ProfileBody,
  SecureVaultEntry,
} from '@agent-desktop/public-contracts';
import type { StoredRequest } from './requests.js';
import type { AgentEvent } from '@agent-desktop/public-contracts';
import type { ControlState, ScreenDoc } from './computer.js';
import type { OwnerPresenceRow, PhoneCallRow, VoiceCallRow } from './cross-process.js';
import type { BackgroundTask, EventReceipt, Subscription, TranscriptEntry } from './execution.js';
import type { Compaction, MemoryClaimDoc, MemoryEntry } from './memory.js';
import type { OutputArtifact } from './artifacts.js';
import type { ModelProviderLogin, ModelProviderRecord } from './model-providers.js';

/** Why a run ended `blocked`, written where the run is blocked (BACKEND 6.5); the task list reads it instead of the error text. */
export type RunBlockCause = 'needs_input' | 'limit' | 'no_progress' | 'verification' | 'unreadable';

/**
 * A run row: the public Run plus what only the backend keeps. `rootRunId`/`depth` are written once when a child
 * is spawned (a run without them is its own root, depth 0); `blockCause` where the run is blocked; `effectReview`
 * is `open` while an uncertain outside action of this run awaits the owner's report and `resolved` once every one is.
 * `quietReason` is set when the run ended through `finish_quietly` (BACKEND §3.3a): the one line why there was nothing to tell; internal,
 * it becomes the task's `resultLine` ("Nothing to report: ...").
 */
export type StoredRun = Run & {
  quietReason?: string;
  /** Written once when the run starts: its starting wake is one where nobody waits (`isQuietStartWake`, BACKEND §3.3b), or it continues a run that was. Gates `finish_quietly`. */
  quietEligible?: boolean;
  harnessVersion?: string;
  rootRunId?: string;
  depth?: number;
  blockCause?: RunBlockCause;
  effectReview?: 'open' | 'resolved';
  /** Who asked for the stop, written where the stop is requested (BACKEND 6.5); the task list reads it for a `stopped` run. */
  stoppedBy?: StopActor;
};

/** Who stopped something: the owner (the app), the agent itself (`child_cancel`, `task_stop`), or the platform (a parent run ending, a run cleaned up). */
export type StopActor = 'owner' | 'agent' | 'system';

/**
 * What `task_update` stores (BACKEND 6.5). The public `AgentTask` is projected from it with its run's root and
 * origin (modules/tasks/work-view.ts); `stoppedBy` says the owner stopped it from the task list.
 */
export interface DeclaredTask {
  id: string;
  agentId: string;
  conversationId?: string;
  runId?: string;
  title: string;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'stopped';
  progress?: string;
  outcome?: string;
  stoppedBy?: StopActor;
  /** Only for a task no run owns (a meeting's): what started it. Every other declared task takes its run's root origin. */
  origin?: RunOrigin;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

// Internal library row: the public LibraryItem plus where its bytes are. A file row (upload, send_file, approval
// preview) names its bytes in the blob store (contracts/blobs.ts); a published artifact has none of its own (its
// versions' bytes are `artifactFiles` rows). blobKey is stripped from every public response by libraryItemSchema
// and the bytes are only served through the owner-scoped download.
export interface LibraryDocument extends LibraryItem {
  blobKey?: string;
  sha256?: string;
  /** artifact_publish: the computer path the newest version was published from, so the agent can edit and republish it. */
  sourcePath?: string;
  /** HTML versions the thumbnail backfill has tried (BACKEND 5.11), success or not: one marker per version, so a pass never repeats one. Internal, never in a public response. */
  thumbnailTried?: number[];
}

/**
 * Private file of one published artifact version (BACKEND 5.11): the file itself, its PDF preview or its
 * first-page PNG. `ArtifactVersion.fileRef/previewRef/thumbnailRef` are ids of these rows; they never leave
 * the API except through the owner-scoped version download or, for HTML, the signed artifact origin.
 */
export interface ArtifactFile {
  id: string;
  artifactId: string;
  version: number;
  part: 'file' | 'preview' | 'thumbnail';
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  /** The bytes, in the blob store (contracts/blobs.ts). */
  blobKey: string;
  createdAt: string;
}

/**
 * One proposed change to a document (BACKEND 5.11a): the public draft plus where the Markdown body is (the blob store; the row never holds it)
 * and the key a retried agent call is recognised by. The extra fields are stripped by `documentDraftSchema`.
 */
export interface DocumentDraftRow extends DocumentDraft {
  blobKey: string;
  /** The agent that proposed it. Stays when the owner edits the draft (its `author` becomes `person`), so that agent is told how it ended. */
  agentId?: string;
  /** Agent drafts: `runId:stepId:sha256`. A person's draft has none. */
  idempotencyKey?: string;
}

/**
 * One app an agent built (BACKEND 5.12). `allocated` = the port is reserved for it and the agent may start the app;
 * `published` = the platform saw the app listening as the agent's user, wired the gateway route and posted the card.
 * Never trust the agent's `.juno-port` file over this row.
 */
export interface SpaceRecord {
  id: string;
  ownerId?: string;
  agentId: string;
  /** Directory name under /workspace/spaces. */
  slug: string;
  title: string;
  port: number;
  status: 'allocated' | 'published';
  /** The computer the route was registered on (set when published). */
  computerId?: string;
  /** The command that starts the app as its agent (the spaces skill's `start`); the platform relaunches it after a cold start (BACKEND §7.11). */
  start?: string;
  /** The chat card (a `render: 'app'` library row) once published. */
  artifactId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A Space's share link on long-lived hosting (BACKEND 5.12, option B), metadata only: the files and rows live on the hosting
 * service. One per Space (`id` = the Space's id); a revoked link keeps its row with `revokedAt` set, and a new publish after a
 * revoke writes a new link over it.
 */
export interface SpaceHostedRecord {
  /** The Space's id. */
  id: string;
  ownerId?: string;
  agentId: string;
  /** The publication on the hosting service: the link id, the unguessable part of the URL. */
  linkId: string;
  url: string;
  visibility: 'private' | 'link' | 'public';
  /** Whether visitors (without the owner's session) may change the data; they may always read it. */
  visitorWrites: boolean;
  /** The publish the hosted copy is at; each publish (first or republish) increments it. */
  version: number;
  publishedAt: string;
  updatedAt: string;
  revokedAt?: string;
}

// ---------------------------------------------------------------------------
// Store — a document store over Postgres. Each collection holds the contract model as jsonb plus
// indexed columns for filtering. `doc` is always the full, zod-valid contract object.
// ---------------------------------------------------------------------------

/** One device the owner registered for push (APNs on iOS, FCM on Android). `id` is derived from owner + token (see agentd devices route). */
export interface DeviceRegistration {
  id: string;
  platform: 'ios' | 'android';
  token: string;
  environment: 'sandbox' | 'production';
  bundleId: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One file of a user's home on their computer, as Postgres mirrors it (BACKEND §5.2): an index and backup, not the truth.
 * `id` is `<ownerId>:<path>`; `agentId` is set for files under `agents/<agentId>/`. `pendingWrite` rows still have to
 * reach the computer (written while it was unavailable, migrated, or initial agent text).
 */
export interface AgentHomeRow extends AgentHomeFile {
  id: string;
  ownerId: string;
  agentId?: string;
  pendingWrite?: boolean;
}

/** The names (never values) of the vault fields an owner keeps on the phone (BACKEND 8.7); id = `secureVaultIdFor(ownerId)`. */
export interface SecureVaultRow {
  id: string;
  entries: SecureVaultEntry[];
  updatedAt: string;
}

/** The account profile (BACKEND 8.7); id = `profileIdFor(ownerId)`. */
export type ProfileRow = ProfileBody & { id: string; updatedAt: string };

/** What one owner did with one inspiration (BACKEND 10.10b); id = `<ownerId>:<inspirationId>`. */
export interface InspirationRow {
  id: string;
  inspirationId: string;
  /** First time it was returned by GET /v1/today; the 3-day expiry counts from here. */
  firstShownAt: string;
  dismissedAt?: string;
  updatedAt: string;
}

/**
 * One messaging-platform identity an agent holds as itself (CH1 channels). `id` is
 * `<kind>:<channelId>` (for example `telegram:bot-1`); the platform secret itself is never
 * stored, only its sha256 in `secretHashHex`. `ownerExternalId` is the owner's platform user id
 * bound at setup, so ingress can tell the owner's own message from a stranger's.
 */
export interface ChannelRow {
  id: string;
  ownerId: string;
  agentId: string;
  kind: string;
  channelId: string;
  secretHashHex: string;
  ownerExternalId?: string;
  /** Bot token for outbound platform sends, sealed (`enc:v1:`); open it just before sending. */
  botToken?: string;
  /** Platform user ids the owner answered "Not me" for: their private messages are strangers' and raise no new prompt. */
  declinedExternalIds?: string[];
  /** Telegram long-poll cursor: the next `getUpdates` offset (update_id + 1). */
  pollOffset?: number;
  /** Feishu / Lark cloud (`feishu` kind only); absent means feishu.cn. */
  domain?: 'feishu' | 'lark';
  /** `active`, `invalid_token` once the platform refused the credential, or `pending_install` (Slack app created, not yet installed). */
  status?: string;
  /** Slack workspace id and bot user id; the channel id is our own opaque one, so these live on the row (mention stripping and the self-filter read `botUserId`). */
  teamId?: string;
  botUserId?: string;
  /** An identity being created automatically (`kind: 'pending'` rows only); see agentd channels/pending.ts. */
  pending?: ChannelPending;
  /**
   * Shared Juno app (Slack / Discord, `mode: 'oauth'`): the `channelInstallations` row (`slack:<teamId>`, `discord:<guildId>`) whose
   * bot token this agent speaks with. Such a row has no `botToken` of its own.
   */
  installationId?: string;
  /** Slack: the user group people @-mention to reach this agent; Discord: the mentionable role id. */
  usergroupId?: string;
  roleId?: string;
  /** The @-mention name (Slack user group handle / Discord role name); absent while the platform cannot give one. */
  handle?: string;
  handleStatus?: 'ok' | 'needs_paid_plan' | 'failed';
  /** What people see this agent called on the platform. */
  displayName?: string;
  /** An agent's own bot (no `installationId`): the human name of what it belongs to, for the Apps page (Slack workspace name, Feishu app name, Discord bot name). Telegram needs none: its channel id is the @username. */
  accountName?: string;
  /** Optional platform permissions the app was granted (Feishu: `im:message.group_msg`, `im:message.reactions:write_only`); they widen the chat's capability row. */
  grantedScopes?: string[];
  createdAt: string;
  updatedAt: string;
}

/** A channel the platform is still creating (Telegram managed bot, Feishu registerApp, Slack manifest). Short-lived. */
export interface ChannelPending {
  platform: 'telegram' | 'feishu' | 'slack' | 'discord';
  /** Slack / Discord: the install goes through the shared Juno app (no per-agent app). */
  shared?: boolean;
  state: 'pending' | 'connected' | 'failed' | 'expired';
  expiresAt: string;
  /** Telegram: the username suggested in the creation link; the managed_bot update is matched by it. */
  suggestedUsername?: string;
  createUrl?: string;
  verificationUrl?: string;
  installUrl?: string;
  domain?: 'feishu' | 'lark';
  /** Slack: the new app's OAuth client, secret sealed. */
  clientId?: string;
  clientSecret?: string;
  /** The `channels` row id this request produced. */
  resultRowId?: string;
  error?: string;
}

/**
 * One install of the shared Juno app into a Slack workspace / Discord server (`slack:<teamId>`, `discord:<guildId>`). Several agents of
 * the same owner share it; each has a `channels` row pointing here. Tokens are sealed (`enc:v1:`).
 */
export interface ChannelInstallation {
  id: string;
  ownerId: string;
  kind: string;
  /** Slack team id / Discord guild id. */
  teamId: string;
  botToken: string;
  botUserId: string;
  /** The platform user who installed (Slack authed_user) or invited (Discord audit log) the app: the owner's platform id. */
  installedBy?: string;
  /** Discord: per-text-channel webhook the bot created to speak with an agent's name and avatar, token sealed. */
  webhooks?: Record<string, { id: string; token: string }>;
  /** Slack: last time missing user groups were retried (free workspaces get at most one try a day). */
  handlesCheckedAt?: string;
  /** Slack: the scopes the OAuth answer at install granted the app (`scope`, comma separated in the answer, a list here). */
  grantedScopes?: string[];
  /** What the owner calls this workspace / server (Slack team name, Discord guild name); absent on installs from before the Apps page, then the id shows. */
  label?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * What one agent may do with one work or custom app (Apps page, BACKEND 10.18). `id` is `<agentId>:<appId>`; `appId` is the connector
 * catalog id, or the connection id of a custom server. No row means the default: enabled, actions ask first. A chat app has no row
 * here: an agent is enabled in a workspace by having a `channels` row on that installation.
 */
export interface AgentAppRow {
  id: string;
  ownerId: string;
  agentId: string;
  appId: string;
  enabled: boolean;
  actionsPolicy: ActionsPolicy;
  updatedAt: string;
}

/**
 * One app of the catalog (the `app_catalog` table, BACKEND 10.18): what the Apps page lists and what agents may use. It is data, so adding or
 * changing an app needs no code change or deploy; the first boot seeds it from the built-in connectors and the chat platform plugins, and
 * after that the table is the source of truth (the admin API edits it). Deployment-wide: owned by the `system` owner, not by an account.
 */
export interface AppCatalogRow {
  /** `<appId>@<version>`: every edit writes a new row, so an installation can say which version of the package it was added at. */
  id: string;
  ownerId: string;
  /** A slug: the app id everywhere (`gmail`, `slack`), the package's `name`. */
  appId: string;
  /** 1, 2, ...: the current version of an app is the highest one. */
  version: number;
  category: AppCategory;
  /** The connector catalog's own grouping, for work apps. */
  group?: ConnectorCategory;
  /** What the Apps page shows (mirrors OpenAI plugin manifests' `interface`). */
  interface: AppInterface;
  /** plugin.json's `license`, `keywords` and `version` when the package came with them. */
  license?: string;
  keywords?: string[];
  packageVersion?: string;
  /** mcp.json's `mcpServers`: work apps, one entry per server, keyed by a short name. Nothing here is a credential. */
  mcpServers: Record<string, AppMcpServer>;
  /** The package's skills (`skills/<name>/SKILL.md`); `onboardingSkill` names the one the agent reads first after the app is added. */
  skills: AppSkillDecl[];
  onboardingSkill?: string;
  /** Values the owner supplies when adding the app (Claude plugins' `userConfig`), keyed; the values live sealed on the owner's connection. */
  userConfig: Record<string, AppUserConfigField>;
  /** Our own word on read versus change, over the server's annotation (tool-access.ts): the whole server, or single tools. */
  readOnly?: true;
  tools?: Record<string, 'read' | 'change'>;
  /** What the app lets an agent do, as capability tags (modules/apps/provides.ts): how "send email" finds the apps that could do it. Work apps only. */
  provides?: string[];
  /**
   * Work apps: `composio` marks a long-tail app whose login Composio holds (BACKEND 10.18.3). It has no `mcpServers`; `toolkit` is its Composio
   * toolkit slug, and the owner's connected account lives at Composio, keyed by our user id. Absent: an official app (the vendor's own MCP server).
   */
  source?: 'composio';
  toolkit?: string;
  /**
   * Chat apps: the platform plugin (`ChannelRegistration.kind`) that carries the transport, which stays code. Web apps: the Agent Reach channel
   * the app reads through the agent's computer (`reach`). `login: 'none'` when that needs no sign-in; `login: 'sandbox'` when the person signs in
   * on the agent's own computer (request_takeover) and the session stays in its browser. Adding either only turns the app on. Without `login` the
   * app is a sign-in slot that cannot be added yet. Mirrors Claude plugins' `channels` binding.
   */
  binding?: { plugin?: string; reach?: string; login?: 'none' | 'sandbox' };
  /** `listed`: on the page and offered to add; `hidden`: not offered or searched, but what is already added keeps working and shows; `retired`: gone from the page and from every agent's tools (rows stay). */
  status: 'listed' | 'hidden' | 'retired';
  /** When this version was written. */
  createdAt: string;
  updatedAt: string;
}

/** The display block of an app package (OpenAI's `extensions.com.openai.interface`). */
export interface AppInterface {
  displayName: string;
  /** One line for the tile. */
  shortDescription: string;
  longDescription: string;
  developerName?: string;
  /** Short icon id the client resolves. */
  icon: string;
  brandColor?: string;
  /** Example prompts shown once the app is added. */
  defaultPrompts: string[];
  websiteUrl?: string;
  privacyPolicyUrl?: string;
  termsOfServiceUrl?: string;
}

/**
 * One MCP server of an app package (an entry of `mcp.json`). `auth` is how the owner is let in: `none`, `oauth`, `api_key` (a user_config value
 * in a header or the URL) or `mixed` (some tools public, the rest behind OAuth; not addable yet). `url` and header values may name
 * `${user_config.KEY}`.
 */
export interface AppMcpServer {
  type: 'streamable-http';
  /** https URL, or a path on this gateway for a server it hosts (`/mcp/google/gmail`). */
  url: string;
  auth: 'none' | 'oauth' | 'mixed' | 'api_key';
  oauth?: {
    /** Which kind of client to sign in with: `provided` (ours, registered with the provider, its credentials named below), `cimd` (a client metadata document we host), `dcr` (dynamic registration). Absent: the best the server offers, in that order. */
    client?: 'provided' | 'cimd' | 'dcr';
    /** `provided`: the authorization server's issuer the client is registered with. */
    issuer?: string;
    scopes?: string[];
    /** `provided`: the NAMES of the deployment secrets holding the client id and secret (never the values). */
    clientIdName?: string;
    clientSecretName?: string;
    revocationEndpoint?: string;
  };
  headers?: Record<string, string>;
  /** Called with the deployment's API key, not a user sign-in; connected by default. */
  platformKey?: true;
  /** Its tools may be offered in a group or a stranger's chat. */
  sharedRooms?: true;
  /**
   * A read-only call that proves what the owner typed works (BACKEND 10.18.1): an `api_key` app is connected only after this tool, called with
   * these arguments, succeeds. Required for `api_key`, not allowed for `oauth` (the sign-in itself is the proof).
   */
  probe?: AppProbe;
}

/** The call an app is probed with when it is added: the server's own tool name and its arguments. */
export interface AppProbe {
  tool: string;
  args?: Record<string, unknown>;
}

/** A skill of an app package: `name` (kebab-case, at most 64), `description` (what it does and when to use it, at most 1024) and the SKILL.md body. */
export interface AppSkillDecl {
  name: string;
  description: string;
  instructions: string;
}

/** One value an app asks the owner for. */
export interface AppUserConfigField {
  type: 'string' | 'number' | 'boolean';
  title: string;
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  options?: string[];
  /** Stored sealed and never shown again; the only kind that may be a header value. */
  sensitive?: boolean;
}

/** Row id for one platform identity (CH1): `<kind>:<channelId>` (for example `telegram:bot-1`). */
export function channelRowId(kind: string, channelId: string): string {
  return kind + ':' + channelId;
}

/** One line of a live meeting: what was said (speech) or typed in the meeting chat. */
export interface MeetingLine {
  at: string;
  who: string;
  text: string;
  chat?: true;
}

/**
 * One live-meeting attendance of an agent's channel app (CH8, Lark). `invited` is a pending invitation waiting for the owner's
 * yes (no meeting yet); `active` is polled for events; `ended` keeps the transcript for notes and follow-up questions.
 * id: `meet-<agentId>-<meetingId>`, or `meet-invite-<agentId>-<meetingNumber>` while invited.
 */
export interface MeetingSession {
  id: string;
  ownerId: string;
  agentId: string;
  /** The channel row (`feishu:<appId>`) whose app is in the meeting. */
  channelRowId: string;
  /** The chat where it was asked for; mentions are answered and notes posted here. */
  conversationId: string;
  status: 'invited' | 'active' | 'ended';
  meetingNumber: string;
  meetingId?: string;
  topic?: string;
  callId?: string;
  password?: string;
  /** Events cursor; resumes after a restart. */
  pageToken?: string;
  /** Why it ended: `ended` (meeting over), `removed` (kicked or left), `left` (asked to leave), `lost` (events unreadable). */
  endReason?: string;
  lines: MeetingLine[];
  startedAt: string;
  endedAt?: string;
  updatedAt: string;
  /** Meeting session layer (2026-10-21). Absent on older rows, which read as `feishu`. */
  platform?: 'feishu' | 'meet';
  /** The meeting's own conversation (title "Meet · <code>"): chat lines are its items and every in-meeting wake runs in it; `conversationId` stays the chat that asked. */
  meetingConversationId?: string;
  /** Google Meet link. */
  url?: string;
  /** The name shown in the meeting; chat messages are matched against it. */
  agentName?: string;
  /** The record file in the agent's home (`agents/<agentId>/meetings/...`). */
  recordPath?: string;
  /** Meet: id of the last chat message already handled (the `since` of the next read). */
  lastChatId?: string;
  /** Meet: seq of the last audio segment already transcribed, within `audioEpoch`. */
  lastAudioSeq?: number;
  /** Meet: id of the page-side audio recorder those seqs belong to (a page reload makes a new one). */
  audioEpoch?: string;
  /** Meet: the admitted wake was sent. */
  admitted?: boolean;
  /** Meet: consecutive polls that saw no usable state. */
  misses?: number;
  /** What the owner wants from this meeting and after it (from their request); shown to the meeting subagent. Meet only. */
  brief?: string;
  /** Lines ever recorded (`lines` is capped) and how many of them the meeting subagent has been shown. */
  lineTotal?: number;
  notedTotal?: number;
  /** After the end: the meeting subagent is writing the notes (`pending`), or its report reached the chat that asked (`sent`). */
  report?: 'pending' | 'sent';
}

/**
 * One row of the proactive log (the `proactive_log` table, BACKEND §5.10): an unsolicited message the agent actually posted
 * (`daily-check`, `goal-checkin`), a "want fewer of these?" question it raised (`silence-question`), or something the owner did
 * with a proactive item (`snooze` of a topic until `until`, `useful`). The daily cap and the silence rule count these rows.
 */
export interface ProactiveLogRow {
  id: string;
  ownerId: string;
  kind: 'daily-check' | 'goal-checkin' | 'silence-question' | 'snooze' | 'useful';
  agentId?: string;
  conversationId?: string;
  runId?: string;
  /** The chat item posted (messages), or the item the owner pressed a button on. */
  itemId?: string;
  /** What it was about: the goal's title, or the type a silence question asked about. */
  topic?: string;
  /** The owner's local date it happened on (the daily cap counts per date). */
  date: string;
  /** `snooze` only: when the snooze ends. */
  until?: string;
  at: string;
}

/** What a monitor remembers between checks (the `monitor_state` table, one row per monitor, id = the routine's id). */
export interface MonitorState {
  id: string;
  agentId: string;
  /** Ids of items already reported or present at creation; bounded, oldest dropped first. */
  seen: string[];
  /** Checks that failed in a row. */
  failures: number;
  /** When the owner was told the monitor is failing (once per run of failures). */
  notifiedAt?: string;
  /** First failure of a run of "sign in again" failures. */
  brokenSince?: string;
  updatedAt: string;
}

/**
 * An account whose deletion has started (BACKEND §5.2c). `id` is the owner id. The row is the "deleting" state: it is written
 * before anything is removed, lists the steps already finished, and is the last thing deleted, so a crash at any point is
 * finished at the next boot. Every step is safe to run again.
 */
export interface AccountDeletion {
  id: string;
  ownerId?: string;
  startedAt: string;
  updatedAt: string;
  /** The owner's agent ids when the deletion began: durable session keys start with them and the agent rows are gone by the end. */
  agentIds: string[];
  /** Names of the steps finished so far. */
  done: string[];
  /** Failed rounds so far and the last error, for whoever reads the log. */
  attempts: number;
  lastError?: string;
}

/** The shape of a pre-0049 `skills` row; read only by the migration and account deletion. */
export interface LegacySkillRow {
  id: string;
  ownerId?: string;
  name: string;
  description: string;
  source: 'manual' | 'recorded';
  owner: 'personal' | 'team';
  usedCount: number;
  instructions: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CollectionMap {
  /** Accounts being deleted; not part of the owner's data wipe (it goes last). */
  accountDeletions: AccountDeletion;
  agents: Agent;
  computers: Computer;
  /** Per-agent displays inside the shared computer (backend-only; SB1). */
  screens: ScreenDoc;
  /** Who may act on a surface right now (a screen, or the owner's Mac): the one source of control state (backend-only; BACKEND 7.8b). */
  controls: ControlState;
  conversations: Conversation;
  items: Item;
  /** `harnessVersion` is the harness version id the run's first context was built from (BACKEND §11.2), for result statistics (backend-only). */
  runs: StoredRun;
  steps: Step & { runId: string };
  /** Public request plus the runtime-only fields (awakeableId, ...); never serialize it as-is, use toPublicRequest. */
  requests: StoredRequest;
  /** `webhookSecretHash` is the sha256 of the webhook secret (api-owned; the secret itself is never stored). */
  routines: Routine & { webhookSecretHash?: string };
  rules: Rule;
  audit: AuditEntry;
  /** Seen-set and failure counters of the agent-created monitors (routines with a `check` trigger). */
  monitorState: MonitorState;
  /** Unsolicited messages actually posted and the owner's answers to them (daily cap, silence rule, snoozes). */
  proactiveLog: ProactiveLogRow;
  /** Legacy memory rows (2026-10-10): no longer read or written, only migrated into MEMORY.md once. */
  /**
   * Retired (batch 5a): search reads the memory items now and nothing reads or writes this index. The collection stays so that
   * account deletion still erases its rows (memory_entries table, see db owner-erase.ts).
   */
  memoryEntries: MemoryEntry;
  /** What the hourly job distilled, with evidence (memory_claims table). */
  memoryClaims: MemoryClaimDoc;
  /** Mirror of the files in the user's computer home (agent_home table). */
  agentHome: AgentHomeRow;
  goals: Goal;
  ideas: Idea;
  /** The food diary an agent keeps for the owner (the `meals` table). */
  meals: Meal;
  /** The agent's own one-off calendar (follow-ups, meetings, tasks; the `agent_calendar` table). */
  agentCalendar: AgentCalendarItem;
  feedPosts: FeedPost;
  /** Push-notification registrations (APNs). Owner-scoped; the token itself is the device credential. */
  devices: DeviceRegistration;
  /**
   * Legacy skill rows (before migration 0049, which copied each into skill_defs and skill_versions). Nothing reads or writes them now; the
   * collection stays so that account deletion still erases them.
   */
  skills: LegacySkillRow;
  plugins: Plugin;
  connections: Connection;
  /** Per agent and app: on or off, and the policy for the app's changing tools (the `agent_apps` table). */
  agentApps: AgentAppRow;
  /** The apps the deployment offers (the `app_catalog` table), owned by the `system` owner. */
  appCatalog: AppCatalogRow;
  /** Owner-provided model providers; `apiKey` is sealed (enc:v1:) and never leaves the backend. */
  modelProviders: ModelProviderRecord;
  /** Pending ChatGPT sign-ins (one-time, expiring); owner-scoped like every collection. */
  modelProviderLogins: ModelProviderLogin;
  library: LibraryDocument;
  /** Bytes of each published artifact version (artifact_publish); private. */
  artifactFiles: ArtifactFile;
  /** Proposed changes to documents (BACKEND 5.11a): metadata only, the body is in the blob store; `parent_id` is the document. */
  documentDrafts: DocumentDraftRow;
  /** Apps agents built (space_publish); owner-scoped. */
  spaces: SpaceRecord;
  /** Share links of Spaces on long-lived hosting (BACKEND 5.12, option B); owner-scoped, metadata only. */
  spaceHosted: SpaceHostedRecord;
  settings: AppSettings & { id: string };
  /** Vault key names per owner (secure input; values stay on the phone). */
  secureVault: SecureVaultRow;
  /** Names, emails, phones and addresses the agent fills into pages itself (not secrets). */
  profiles: ProfileRow;
  /** Impressions and dismissals of Today inspirations (starters and ideas). */
  inspirations: InspirationRow;
  /** Platform identities the owner's agents hold (CH1; the `channels` table). */
  channels: ChannelRow;
  /** Installs of the shared Slack / Discord app, one per workspace / server (the `channel_installations` table). */
  channelInstallations: ChannelInstallation;
  /** Live meetings an agent's channel app attends (CH8; the `meeting_sessions` table). */
  meetingSessions: MeetingSession;
  // --- internal (not in the frontend contract) ---
  subscriptions: Subscription;
  /** Durable event-consumption receipts for webhook redelivery dedupe (internal). */
  eventReceipts: EventReceipt;
  compactions: Compaction;
  transcripts: TranscriptEntry;
  browserGoalGates: BrowserGoalGate;
  /** Tasks the agent declared with task_update (public `AgentTask` rows of kind `task`; BACKEND 6.5). */
  agentTasks: DeclaredTask;
  /** Background jobs the agent started (tasks_list / task_stop); internal. */
  backgroundTasks: BackgroundTask;
  /** Private, owner/agent-scoped tool-output artifacts (PH9). */
  artifacts: OutputArtifact;
  /** Where each owner is now (open apps, watched screens, the iPhone's declaration); the coordinator writes, workers read (BACKEND 2.2c). */
  ownerPresence: OwnerPresenceRow;
  /** iPhone calls in flight: the worker that asked polls, the coordinator writes the app's answer. */
  phoneCalls: PhoneCallRow;
  /** Discord voice tool calls made on a worker, served by the coordinator that holds the gateway. */
  voiceCalls: VoiceCallRow;
}
export type Collection = keyof CollectionMap;
export type Doc<C extends Collection> = CollectionMap[C];

/** Indexed filter columns available on every collection (null when not applicable). */
export interface IndexedFields {
  agentId?: string | null;
  conversationId?: string | null;
  runId?: string | null;
  status?: string | null;
  kind?: string | null;
  parentId?: string | null;
}

export interface ListQuery {
  /** `initiator` (root origin type) and `unattended` filter the audit collection only, from its own columns (migration 0056). */
  where?: IndexedFields & {
    ids?: string[];
    initiator?: string;
    unattended?: boolean;
    /** Any of these statuses (the task list reads live or ended sources whole). */
    statuses?: string[];
    /** Runs only: a child run (has a parent) / a run a routine started (`routineId` names which one, `hasRoutine` any). */
    hasParent?: boolean;
    hasRoutine?: boolean;
    routineId?: string;
  };
  /**
   * Start strictly after this (`at`, `id`) in the query's order, with ids compared as plain bytes. For a reader
   * that merges several sources into one keyset-paged list: its cursor is a position, not a store cursor.
   */
  keyset?: { at: string; id: string };
  /** Indexed sort key; `at` = the doc's main timestamp (createdAt / at / startedAt). */
  orderBy?: 'at' | 'id';
  order?: 'asc' | 'desc';
  limit?: number;
  /** Opaque keyset cursor returned by a previous list. */
  cursor?: string;
}

export interface ListPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface Store {
  /** Request-scoped owner boundary. Account HTTP requires this; internal runner uses the raw store. */
  forOwner?(ownerId: string): Store;
  /** Run `fn` in one transaction; events emitted inside commit atomically with the writes. */
  tx<T>(fn: (store: Store) => Promise<T>): Promise<T>;
  get<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null>;
  list<C extends Collection>(collection: C, query?: ListQuery): Promise<ListPage<Doc<C>>>;
  /** Insert or replace. `index` overrides the derived indexed fields if needed. */
  put<C extends Collection>(collection: C, doc: Doc<C>, index?: IndexedFields): Promise<Doc<C>>;
  /** Shallow-merge `patch` into the stored doc and return the result. Throws NotFound. */
  patch<C extends Collection>(collection: C, id: string, patch: Partial<Doc<C>>): Promise<Doc<C>>;
  /**
   * Read one row with a write lock held until the surrounding transaction commits. Must be
   * called inside `tx`: Postgres takes `SELECT ... FOR UPDATE` (a second waiter blocks until
   * the first transaction commits), memory backends hold a row mutex released when `tx` returns.
   * Optional so unrelated fakes keep compiling; event paths refuse to run unlocked when it is
   * absent instead of silently racing, so callers must fail loudly on `undefined`.
   */
  getForUpdate?<C extends Collection>(collection: C, id: string): Promise<Doc<C> | null>;
  delete(collection: Collection, id: string): Promise<void>;
  /** Append to the durable event log (same tx as the writes); fan-out to SSE happens after commit. */
  emit(event: AgentEvent): Promise<void>;
}

export class NotFoundError extends Error {
  constructor(public readonly collection: string, public readonly id: string) {
    super(`${collection} ${id} not found`);
  }
}

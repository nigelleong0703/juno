import type {
  RunOriginType,
  AgentHomeFile,
  AgentTask,
  TaskTree,
  WorkKind,
  Agent,
  Attachment,
  AgentStatus,
  Artifact,
  CreateDocumentInput,
  DecideDocumentDraftInput,
  DocumentContent,
  DocumentConversationInput,
  DocumentDraftContent,
  DocumentView,
  SaveDocumentDraftInput,
  Space,
  SpaceHosted,
  SpaceHostedUpdate,
  SpaceOpenUrl,
  SpacePublishHosted,
  ArtifactVersion,
  ArtifactKind,
  AuditDecision,
  AuditEntry,
  Computer,
  ComputerState,
  App,
  AppDetail,
  AgentApp,
  InstallAppChatInput,
  InstallAppResponse,
  CustomAppConfirm,
  ProbeCustomAppResponse,
  ReviewAppToolsInput,
  ReviewAppToolsResponse,
  SetAgentAppInput,
  SetWorkspaceAgentInput,
  AppWorkspaceAgent,
  Conversation,
  ConversationKind,
  ComposerPayload,
  CreateAgentInput,
  CreateRoutineInput,
  CreateSkillInput,
  UpdateSkillInput,
  SkillVersion,
  CreateDelegationInput,
  CreateRuleInput,
  DecisionCategory,
  CreateMcpServerInput,
  Id,
 Item,
 ItemType,
 LibraryItem,
  FileDownload,
  CreateGoalInput,
  FeedPost,
  FeedbackSignal,
  Today,
  Goal,
  GoalStatus,
  AgentCalendarItem,
  UpdateAgentCalendarItem,
  Idea,
  IdeaStatus,
  ProactiveFeedbackInput,
  ProactiveFeedbackResult,
  ProactiveRule,
  Meal,
 ListParams,
  ListResult,
  ForgetMemoryInput,
  ForgetMemoryResult,
  MemoryClaim,
  MemoryClaimStatus,
  MemorySearchHit,
  Plugin,
  PluginCategory,
  PlanItem,
  Request,
  RequestKind,
  RequestStatus,
  Profile,
  PutProfileInput,
  ResolveRequestInput,
  Routine,
  RoutineRun,
  RoutineStatus,
  Rule,
  RuleScope,
  RuleSource,
  Run,
  RunKind,
  RunStatus,
  SecretMetadata,
  SecureInputResult,
  SecureVaultKeys,
  SubmitSecureInput,
  ScreenElements,
  ScreenClipboard,
  ScreenClipboardPaste,
  ScreenClipboardPasteResult,
  ComputerRuntime,
  MacPairing,
  MacStatus,
  ScreenResponse,
  ScreenScreenshot,
  ScreenStreamTicket,
  Skill,
  Step,
  ToolPermission,
  UpdateAgentInput,
  UpdateConversationInput,
  UpdateGoalInput,
  UpdateRoutineInput,
  UpdateDelegationInput,
  UpdateRuleInput,
  RequestOutcome,
  UpdateSettingsInput,
  UploadInput,
  WriteHomeFileInput,
  AppSettings,
  ModelCatalog,
  Usage,
  UsageLedger,
} from './models/index.js';

// ---------------------------------------------------------------------------
// Per-resource list queries (all cursor-paginated)
// ---------------------------------------------------------------------------

export type AgentsListParams = ListParams & {
  status?: AgentStatus;
  section?: string;
  pinned?: boolean;
};
/** `GET /v1/tasks`: `status=live` returns every live task, `ended` pages with `cursor`; no status = live ones plus the first ended page. */
export type TasksListParams = { agentId?: Id; conversationId?: Id; kind?: WorkKind; routineId?: Id; rootRunId?: Id; status?: 'live' | 'ended'; cursor?: string; limit?: number };
export type ComputersListParams = ListParams & { agentId?: Id; state?: ComputerState };
export type ConversationsListParams = ListParams & {
  kind?: ConversationKind;
  agentId?: Id;
  memberId?: Id;
};
export type ItemsListParams = ListParams & { conversationId?: Id; type?: ItemType };
export type RunsListParams = ListParams & {
  status?: RunStatus;
  agentId?: Id;
  conversationId?: Id;
  routineId?: Id;
  kind?: RunKind;
};
export type RequestsListParams = ListParams & {
  /** `resolved` (0.3): every decided request, newest first: the decision history of a permissions page. */
  status?: RequestStatus | 'resolved';
  kind?: RequestKind;
  agentId?: Id;
  /** 0.22.0: only requests whose brief has this category (history filter). */
  category?: DecisionCategory;
  /** 0.22.0: only decided approvals that ended this way (history filter). */
  outcome?: RequestOutcome;
};
export type RoutinesListParams = ListParams & {
  agentId?: Id;
  status?: RoutineStatus;
  enabled?: boolean;
};
export type RulesListParams = ListParams & {
  /** 0.3: only this agent's own rules (standing grants from "Always allow"); owner-wide rules have none. */
  agentId?: Id;
  scope?: RuleScope;
  source?: RuleSource;
  enabled?: boolean;
};
export type AuditListParams = ListParams & {
  agentId?: Id;
  decision?: AuditDecision;
  actor?: AuditEntry['actor'];
  /** 0.68.0: only entries whose initiator (root origin) has this type. */
  initiator?: RunOriginType;
  /** 0.68.0: true = only unattended work, false = only work the owner started. */
  unattended?: boolean;
};
export type GoalsListParams = ListParams & { agentId?: Id; status?: GoalStatus };
export type FeedListParams = ListParams & { agentId?: Id };
export type IdeasListParams = ListParams & { agentId?: Id; status?: IdeaStatus };
/** `from` is inclusive and `to` exclusive, both instants (ISO datetimes); the app turns its own days into instants. */
/** The agent's own calendar between two instants (`from` inclusive, `to` exclusive); `agentId` narrows to one agent. */
export type AgentCalendarListParams = { agentId?: Id; from?: string; to?: string };
export type MealsListParams = ListParams & { from?: string; to?: string };
export type SkillsListParams = ListParams & {
  scope?: Skill['scope'];
  agentId?: Id;
};
export type PluginsListParams = ListParams & { category?: PluginCategory; installed?: boolean };
export type LibraryListParams = ListParams & {
  kind?: ArtifactKind;
  agentId?: Id;
  /** Current private or group chat: files from another chat must not be mixed in. */
  conversationId?: Id;
  shared?: Artifact['shared'];
  source?: LibraryItem['source'];
};

// ---------------------------------------------------------------------------
// Result shapes for mutations
// ---------------------------------------------------------------------------

/**
 * Result of sending a message: the stored user item and the run it is in. `runId` is the run this message started,
 * or the busy run it steered into. It is `null` when no single run is named at send time: a room message that woke
 * several agents (each has its own run), a message that woke nobody, or a wake whose decision was not confirmed in time.
 * A private message sent to an idle agent names its run at once, even though the run starts after the short reply window.
 * Follow the run with `GET /v1/runs/:id`.
 */
export interface SendMessageResult {
  item: Item;
  runId: string | null;
}

/**
 * Input accepted by `conversations.create()` (v0.3 chat list).
 * `direct` returns the agent's existing 1:1 thread (creating one if none exists);
 * `room` starts a new group thread with the given agents.
 */
export interface CreateConversationInput {
  kind: 'direct' | 'room';
  memberAgentIds: Id[];
  title?: string;
  firstMessage?: ComposerPayload;
  /** Client-supplied idempotency key so a retried create reuses the same conversation and wake. */
  requestId?: string;
}

/** Structured permission change for a plugin tool. */
export interface SetToolPermissionInput {
  pluginId: Id;
  toolId: Id;
  permission: ToolPermission;
}

// ---------------------------------------------------------------------------
// Resource APIs
// ---------------------------------------------------------------------------

export interface AgentsApi {
  list(params?: AgentsListParams): Promise<ListResult<Agent>>;
  get(id: Id): Promise<Agent>;
  create(input: CreateAgentInput): Promise<Agent>;
  update(id: Id, patch: UpdateAgentInput): Promise<Agent>;
  delete(id: Id): Promise<void>;
  /** Pause: no routine, webhook, timer or peer-agent wake starts a run until resumed; the user's messages still run. */
  pause(id: Id): Promise<Agent>;
  resume(id: Id): Promise<Agent>;
  /** Stop every active run of the agent, child runs included; resolves with how many stops were issued. */
  stop(id: Id): Promise<{ stopped: number }>;
  /** Accept the suggested role: its title becomes the agent title. Rejects (404) when no suggestion is pending. */
  acceptRoleSuggestion(id: Id): Promise<Agent>;
  /** Dismiss the suggested role; no further suggestion while the title stays unset. */
  dismissRoleSuggestion(id: Id): Promise<Agent>;
  /**
   * The agent's tasks (0.3): what it declared with task_update plus the background work it could not
   * finish right away (subagents, commands, connector calls, waits). Running and waiting first, then
   * the most recent finished ones; at most 50. Live updates arrive as `task.updated`.
   */
  tasks(id: Id): Promise<ListResult<AgentTask>>;
  /**
   * Authoritative latest todo plan per conversation for this agent, including done entries (was
   * `tasks` before 0.3). Frontends that show outstanding work flatten only the non-done todos.
   */
  plans(id: Id): Promise<ListResult<PlanItem>>;
}

export interface TasksApi {
  /** Tasks across the owner's agents: live ones whole, ended ones newest first by start (`nextCursor`). */
  list(params?: TasksListParams): Promise<ListResult<AgentTask>>;
  /** Every task under the root run of this task (or run), parents first, with what the tree spent. A foreign id answers 404. */
  tree(id: Id): Promise<TaskTree>;
  /** Stop a running task: its subagent, process, call or wait (a declared task stops the run doing it). */
  stop(id: Id): Promise<AgentTask>;
}

export interface ComputersApi {
  list(params?: ComputersListParams): Promise<ListResult<Computer>>;
  get(id: Id): Promise<Computer>;
  takeOver(id: Id): Promise<Computer>;
  returnControl(id: Id): Promise<Computer>;
  pause(id: Id): Promise<Computer>;
  resume(id: Id): Promise<Computer>;
  reboot(id: Id): Promise<Computer>;
  reset(id: Id): Promise<Computer>;
  setIdlePause(id: Id, minutes: number): Promise<Computer>;
  /** Create the shared VM binding if it does not exist yet; idempotent (SB1 contract §3). */
  ensure(input?: EnsureComputerInput): Promise<Computer>;
  /** Every agent display allocated inside the computer. */
  screens(computerId: Id): Promise<ListResult<ScreenResponse>>;
  /** This agent's screen, or `null` when it has none yet (404 `no_screen`). */
  screen(computerId: Id, agentId: Id): Promise<ScreenResponse | null>;
  /** Allocate (or return) this agent's display. */
  allocateScreen(computerId: Id, agentId: Id): Promise<ScreenResponse>;
  /** Short-lived signed ticket for one screen's websocket; `control` picks the operator password. */
  streamScreen(screenId: Id, options?: StreamScreenOptions): Promise<ScreenStreamTicket>;
  /** One captured frame of a screen. */
  screenshot(screenId: Id): Promise<ScreenScreenshot>;

  /** Take over a single screen (controller=user) without disturbing the others. */
  takeOverScreen(screenId: Id): Promise<ScreenResponse>;
  returnControlScreen(screenId: Id): Promise<ScreenResponse>;
  /**
   * The visible interactive controls with their rects (tap targets). Only while the user controls the
   * screen or a `computer` request of its agent is pending; otherwise 409 `NOT_IN_CONTROL`.
   */
  screenElements(screenId: Id): Promise<ScreenElements>;
  /**
   * Put what the device copied on the computer: an image goes on its clipboard (the caller then sends Ctrl+V), files are
   * saved to its Downloads. Only while the user controls the screen (else 409 `NOT_IN_CONTROL`); over the upload limit 413.
   */
  pasteScreenClipboard(screenId: Id, input: ScreenClipboardPaste): Promise<ScreenClipboardPasteResult>;
  /**
   * What the computer's clipboard holds after the user's Ctrl+C: text, a PNG image or a file. Only while the user controls
   * the screen (else 409 `NOT_IN_CONTROL`); over the upload limit 413.
   */
  copyScreenClipboard(screenId: Id): Promise<ScreenClipboard>;
  /** Where the sandbox runs on this install and whether its image is ready. */
  runtime(): Promise<ComputerRuntime>;
  /** The owner's Mac as a computer (My Mac): paired or not, online or not. */
  myMac(): Promise<MacStatus>;
  /** Pair this Mac (the desktop app calls it): returns the link address and token once; pairing again replaces the old token. */
  pairMyMac(input?: { name?: string }): Promise<MacPairing>;
  /** Revoke the Mac's token; agents set to My Mac then report it offline. */
  unpairMyMac(): Promise<MacStatus>;
  /** 0.71.0 (unreleased): Stop all agent access to the Mac from any client (the Mac cancels what is running). It can be resumed only on the Mac itself. */
  stopMyMac(): Promise<MacStatus>;
}

/** Body of `computers.ensure()`. `agentId` scopes the lookup to one agent's computer binding. */
export interface EnsureComputerInput {
  agentId?: Id;
}

/** Body of `computers.streamScreen()`. */
export interface StreamScreenOptions {
  /** Ask for the operator (interactive) password instead of the read-only one. */
  control?: boolean;
}

export interface ConversationsApi {
  list(params?: ConversationsListParams): Promise<ListResult<Conversation>>;
  get(id: Id): Promise<Conversation>;
  create(input: CreateConversationInput): Promise<Conversation>;
  items(id: Id, params?: ItemsListParams): Promise<ListResult<Item>>;
  send(id: Id, payload: ComposerPayload): Promise<SendMessageResult>;
  markRead(id: Id): Promise<Conversation>;
  /** Pin or mute one chat (per conversation, not per agent). Emits `conversation.updated`. */
  update(id: Id, patch: UpdateConversationInput): Promise<Conversation>;
  /** Delete this conversation with its messages, runs and requests (never the agent). */
  delete(id: Id): Promise<void>;
  /** Typing activity: boolean only, never draft text. Best-effort 204. */
  typing(id: Id, active: boolean): Promise<void>;
}

export interface ItemsApi {
  list(params?: ItemsListParams): Promise<ListResult<Item>>;
  get(id: Id): Promise<Item>;
}

export interface RunsApi {
  list(params?: RunsListParams): Promise<ListResult<Run>>;
  get(id: Id): Promise<Run>;
  stop(id: Id): Promise<Run>;
  /** The owner has seen this finished run; Today stops listing it. */
  markSeen(id: Id): Promise<Run>;
  steps(id: Id, params?: ListParams): Promise<ListResult<Step>>;
}

export interface RequestsApi {
  list(params?: RequestsListParams): Promise<ListResult<Request>>;
  get(id: Id): Promise<Request>;
  /** Approve / deny / answer. Approving emits `request.resolved` and updates pending lists. */
  resolve(id: Id, decision: ResolveRequestInput): Promise<Request>;
  /**
   * Type the user's values into the page fields of a pending `secure_input` request. Each value is encrypted to the
   * request's `payload.encryption` key; the backend only passes the ciphertext on (BACKEND 8.7).
   */
  submitSecureInput(id: Id, input: SubmitSecureInput): Promise<SecureInputResult>;
  /** The names (never values) of the vault fields the owner keeps on the phone; the agent maps form fields to them. */
  secureVaultKeys(): Promise<SecureVaultKeys>;
  setSecureVaultKeys(input: SecureVaultKeys): Promise<SecureVaultKeys>;
}

export interface ProfileApi {
  /** The account profile: one flat list of key/value entries; empty when nothing is saved. */
  get(): Promise<Profile>;
  /** Replaces the whole list (the user's edits). */
  put(input: PutProfileInput): Promise<Profile>;
}

export interface RoutinesApi {
  list(params?: RoutinesListParams): Promise<ListResult<Routine>>;
  get(id: Id): Promise<Routine>;
  create(input: CreateRoutineInput): Promise<Routine>;
  update(id: Id, patch: UpdateRoutineInput): Promise<Routine>;
  /** Toggle enabled; omitting `enabled` flips the current value. */
  toggle(id: Id, enabled?: boolean): Promise<Routine>;
  delete(id: Id): Promise<void>;
  runs(id: Id, params?: ListParams): Promise<ListResult<RoutineRun>>;
}

/** 0.22.0: what an agent may decide alone (BACKEND 8.0). Delegations are `Rule`s with `scope: 'delegation'`. */
export interface DelegationsApi {
  /** One agent's delegations, or all of them. */
  list(params?: ListParams & { agentId?: Id }): Promise<ListResult<Rule>>;
  /** Creates one; the same agent + category + platform + routine updates the limits of the existing one. 400 for a category that cannot be delegated. */
  create(input: CreateDelegationInput): Promise<Rule>;
  update(id: Id, patch: UpdateDelegationInput): Promise<Rule>;
  /** Revoke: the next call asks again. */
  revoke(id: Id): Promise<void>;
}

export interface RulesApi {
  list(params?: RulesListParams): Promise<ListResult<Rule>>;
  create(input: CreateRuleInput): Promise<Rule>;
  update(id: Id, patch: UpdateRuleInput): Promise<Rule>;
  delete(id: Id): Promise<void>;
  /** Accept a `source: 'agent_draft'` rule, promoting it to a user rule. */
  acceptDraft(id: Id): Promise<Rule>;
  /** Reject (discard) a drafted rule. */
  rejectDraft(id: Id): Promise<void>;
}

export interface AuditApi {
  list(params?: AuditListParams): Promise<ListResult<AuditEntry>>;
  /** 0.68.0: `GET /v1/audit/export.csv` with the same filters; the CSV text, newest first, capped (BACKEND "Audit export"). */
  exportCsv(params?: Pick<AuditListParams, 'agentId' | 'initiator' | 'unattended'>): Promise<string>;
}

/**
 * What the agents learned about the user (BACKEND §5.2, §5.5). The facts themselves are lines in MEMORY.md, memory/bank/** and
 * people/** (read and edited through `HomeApi`); this is the layer under them: the claims with their evidence, search, and forgetting.
 */
export interface MemoryApi {
  /** Claims newest first; all statuses when `status` is omitted. */
  claims(params?: { status?: MemoryClaimStatus }): Promise<{ claims: MemoryClaim[] }>;
  /** Retract claims and remove the lines that carry their `[claim:<id>]` tag, in every file. */
  forget(input: ForgetMemoryInput): Promise<ForgetMemoryResult>;
  search(query: string): Promise<{ hits: MemorySearchHit[] }>;
}

export interface GoalsApi {
  list(params?: GoalsListParams): Promise<ListResult<Goal>>;
  /** Full goal with its activity timeline. */
  get(id: Id): Promise<Goal>;
  create(input: CreateGoalInput): Promise<Goal>;
  update(id: Id, patch: UpdateGoalInput): Promise<Goal>;
  /** "Check now": wakes the goal's agent for a check-in outside its schedule (active goals only). */
  check(id: Id): Promise<{ queued: boolean }>;
  delete(id: Id): Promise<void>;
}

export interface FeedApi {
  list(params?: FeedListParams): Promise<ListResult<FeedPost>>;
  like(id: Id, liked: boolean): Promise<FeedPost>;
  /** "More like this" / "less like this"; the agent's next routine run is told. */
  feedback(id: Id, signal: FeedbackSignal): Promise<FeedPost>;
  /** The Chat tab header summary. */
  today(): Promise<Today>;
}

export interface IdeasApi {
  list(params?: IdeasListParams): Promise<ListResult<Idea>>;
  /** Starts the idea's run in a new conversation, marks the idea accepted and returns it with `conversationId`. */
  accept(id: Id): Promise<Idea>;
  dismiss(id: Id): Promise<Idea>;
}

/** What the owner tells the agent about its unprompted messages (BACKEND §5.10): buttons on proactive items, and the rules they made. */
export interface ProactiveApi {
  /** `POST /v1/proactive/feedback`: `useful`, `not_now` (snooze 14 days, no rule), `less` / `never` (write a rule, returned). */
  feedback(input: ProactiveFeedbackInput): Promise<ProactiveFeedbackResult>;
  /** `GET /v1/proactive/rules`: every rule, soft rules past their review date flagged `dueForReview`. */
  listRules(): Promise<{ items: ProactiveRule[] }>;
  /** `DELETE /v1/proactive/rules/:id` */
  deleteRule(id: Id): Promise<Record<string, never>>;
  /** `PATCH /v1/proactive/rules/:id` with `{keep: true}`: move a rule's review date 90 days on. */
  keepRule(id: Id): Promise<ProactiveRule>;
}

export interface AgentCalendarApi {
  /** Items in the range, soonest first; every agent of the owner unless `agentId` is given. */
  list(params?: AgentCalendarListParams): Promise<{ items: AgentCalendarItem[] }>;
  update(id: Id, input: UpdateAgentCalendarItem): Promise<AgentCalendarItem>;
  /** Cancels the item (it stays in the list as cancelled). */
  cancel(id: Id): Promise<AgentCalendarItem>;
}

export interface MealsApi {
  /** The food diary, newest meal first. */
  list(params?: MealsListParams): Promise<ListResult<Meal>>;
}

export interface InspirationApi {
  /** A dismissed inspiration (idea or starter) never returns. */
  dismiss(id: Id): Promise<void>;
}

export interface SkillsApi {
  list(params?: SkillsListParams): Promise<ListResult<Skill>>;
  get(id: Id): Promise<Skill>;
  create(input: CreateSkillInput): Promise<Skill>;
  /** A content change: the new text becomes the active version; the previous one stays for rollback. */
  update(id: Id, input: UpdateSkillInput): Promise<Skill>;
  versions(id: Id): Promise<SkillVersion[]>;
  activate(id: Id, version: number): Promise<Skill>;
  rollback(id: Id): Promise<Skill>;
}

export interface PluginsApi {
  list(params?: PluginsListParams): Promise<ListResult<Plugin>>;
  get(id: Id): Promise<Plugin>;
  install(id: Id): Promise<Plugin>;
  uninstall(id: Id): Promise<Plugin>;
  setToolPermission(input: SetToolPermissionInput): Promise<Plugin>;
  /** Write-only secrets metadata (never the values). */
  secrets(): Promise<SecretMetadata[]>;
}

/**
 * The Apps page and the per-agent app settings (0.65.0). Replaces the connectors, connections and per-agent channels APIs:
 * an app is added once (`install`), then turned on per agent.
 */
export interface AppsApi {
  /** GET /v1/apps: the catalog of apps with what the owner added, and which agents may use each. */
  list(): Promise<App[]>;
  /** GET /v1/apps/:id: adds the capability list (Read / Changes) and the installs the platform is still finishing. */
  get(id: string): Promise<AppDetail>;
  /**
   * POST /v1/apps/:id/install. Work app: `{returnUrl?, userConfig?}` (the values the app declares); chat app: a connect body (`{mode:'oauth'}` installs the Juno bot into
   * a workspace) plus `agentId` for an agent's own bot; `custom`: an MCP server to add, or `{connectionId}` to sign in again.
   * Open `openUrl` when it is returned; a platform that finishes later shows under `pending` of `get`.
   */
  install(id: string, input?: { returnUrl?: string; userConfig?: Record<string, string | number | boolean>; connectionId?: Id } | InstallAppChatInput | (CreateMcpServerInput & { confirm?: CustomAppConfirm }) | { connectionId: Id; returnUrl?: string }): Promise<InstallAppResponse>;
  /** POST /v1/apps/custom/probe: what an MCP server at a URL asks for (login kind, tools with a suggested read / change mark). A server added by URL is installed with the owner's `confirm` of this. */
  probeCustom(url: string): Promise<ProbeCustomAppResponse>;
  /** DELETE /v1/apps/:id/installations/:installationId: remove an account or workspace (also cancels a pending install). */
  removeInstallation(id: string, installationId: string): Promise<void>;
  /** POST /v1/apps/:id/tools/review: mark the capabilities flagged `needsReview` (new or changed since the owner last looked) as reviewed. */
  reviewTools(id: string, input?: ReviewAppToolsInput): Promise<ReviewAppToolsResponse>;
  /** PUT /v1/agents/:agentId/apps/:appId: a work or custom app for one agent. */
  setAgentApp(agentId: Id, appId: string, input: SetAgentAppInput): Promise<AgentApp>;
  /** PUT /v1/apps/:id/installations/:installationId/agents/:agentId: a chat app, one agent in one workspace. */
  setWorkspaceAgent(id: string, installationId: string, agentId: Id, input: SetWorkspaceAgentInput): Promise<AppWorkspaceAgent[]>;
}

export interface LibraryApi {
  list(params?: LibraryListParams): Promise<ListResult<LibraryItem>>;
  get(id: Id): Promise<LibraryItem>;
  setPinned(id: Id, pinned: boolean): Promise<LibraryItem>;
  delete(id: Id): Promise<void>;
  download(id: Id): Promise<FileDownload>;
  /** Store a picked file in the user's library and get the Attachment to send with a message (POST /v1/uploads). */
  upload(input: UploadInput): Promise<Attachment>;
}

/** Where a version's bytes are read from: the file itself, the PDF preview of an Office file, or the first-page PNG. */
export type ArtifactPart = 'file' | 'preview' | 'thumbnail';

/** A short-lived address of an HTML artifact on the separate artifact origin. Embed it in `<iframe sandbox="allow-scripts">` (never allow-same-origin). */
export interface ArtifactRenderUrl {
  url: string;
  expiresAt: string;
}

export interface ArtifactsApi {
  /** The artifact with all its versions (metadata only). */
  get(id: Id): Promise<Artifact>;
  version(id: Id, version: number): Promise<ArtifactVersion>;
  /** One version's bytes (`GET /v1/artifacts/:id/versions/:v/download?part=`), owner-scoped like library download. */
  download(id: Id, version: number, part?: ArtifactPart): Promise<FileDownload>;
  /** HTML artifacts only (`POST /v1/artifacts/:id/versions/:v/render-url`). */
  renderUrl(id: Id, version: number): Promise<ArtifactRenderUrl>;
}

/**
 * 0.70 Documents (BACKEND 5.11a). A document is a Library row (`render: 'doc'`, Markdown); an agent's change arrives as a draft the owner
 * approves or declines, and the owner's own save is an approval. At most one draft is open per document.
 */
export interface DocumentsApi {
  /** `POST /v1/documents`: the owner starts a document; the first save (`approve`) makes version 1. */
  create(input: CreateDocumentInput): Promise<DocumentView>;
  /** `GET /v1/documents/:id`: the document and its open draft. */
  get(id: Id): Promise<DocumentView>;
  /** `GET /v1/documents/:id/versions/:v/content`: one saved version. */
  version(id: Id, version: number): Promise<DocumentContent>;
  /** `GET /v1/documents/:id/draft`: the open draft with its Markdown; 404 when none is open. */
  draft(id: Id): Promise<DocumentDraftContent>;
  /** `PUT /v1/documents/:id/draft`: the owner edits the open draft (or opens a person draft on the saved head). 409 when `expectedRevision` is stale or an agent's draft was replaced. */
  saveDraft(id: Id, input: SaveDocumentDraftInput): Promise<DocumentDraftContent>;
  /** `POST /v1/documents/:id/draft/approve`: save the draft as the next version. Repeating it returns the same version. 409 when the draft changed. */
  approve(id: Id, input: DecideDocumentDraftInput): Promise<DocumentView>;
  /** `POST /v1/documents/:id/draft/decline`: drop the draft; the agent is told. */
  decline(id: Id, input: DecideDocumentDraftInput): Promise<DocumentView>;
  /** `POST /v1/documents/:id/conversations`: the chat about this document with one agent (the same chat every time for the same pair). */
  conversation(id: Id, input: DocumentConversationInput): Promise<Conversation>;
}

export interface SpacesApi {
  /** `GET /v1/spaces`: published apps, newest first, each with its live status. */
  list(): Promise<{ items: Space[] }>;
  get(id: Id): Promise<Space>;
  /** `POST /v1/spaces/:id/open-url`: owner only; open the URL in a new tab (iOS: SFSafariViewController), never in an iframe. */
  openUrl(id: Id): Promise<SpaceOpenUrl>;
  /** `POST /v1/spaces/:id/publish-hosted`: owner only; publish the app to long-lived hosting, or publish a new version at the same link. 503 when hosting is not configured on the server; 409 `SPACE_HAS_SERVER_CODE` when the Space runs its own server code (it can only be shared from the computer). */
  publishHosted(id: Id, body?: SpacePublishHosted): Promise<SpaceHosted>;
  /** `PATCH /v1/spaces/:id/hosted`: owner only; change who may open the hosted copy (`visibility`) and whether visitors may change its data (`visitorWrites`). */
  updateHosted(id: Id, body: SpaceHostedUpdate): Promise<SpaceHosted>;
  /** `DELETE /v1/spaces/:id/hosted`: owner only; revoke the share link. It answers 404 from then on, and its data is deleted. */
  revokeHosted(id: Id): Promise<void>;
  /** `POST /v1/spaces/:id/hosted/open-url`: owner only; a sign-in link for the hosted copy (the way in to a `private` one). */
  hostedOpenUrl(id: Id): Promise<SpaceOpenUrl>;
}

export type UsageLedgerParams = ListParams & { agentId?: Id };

export interface UsageApi {
  get(): Promise<Usage>;
  /** Per-run spend, newest first, with per-model totals. */
  ledger(params?: UsageLedgerParams): Promise<UsageLedger>;
}

/**
 * The files in the user's `/juno` home as the mirror holds them (BACKEND §5.5). Writable: USER.md, MEMORY.md,
 * memory/bank/**, people/** and the IDENTITY / SOUL / AGENTS / TOOLS.md of agents the caller created; the rest is read-only.
 */
export interface HomeApi {
  /** Files whose path starts with `prefix` (all when omitted). */
  list(prefix?: string): Promise<{ files: AgentHomeFile[] }>;
  /** 409 `HOME_CONFLICT` when `expectedHash` no longer matches; reload and retry. */
  write(path: string, input: WriteHomeFileInput): Promise<AgentHomeFile>;
  delete(path: string): Promise<void>;
}

export interface SettingsApi {
  get(): Promise<AppSettings>;
  update(patch: UpdateSettingsInput): Promise<AppSettings>;
  models(): Promise<ModelCatalog>;
}

/**
 * Typed client every screen talks to (ARCHITECTURE §7). The prototype uses the in-memory mock;
 * a real backend swaps in behind this same interface without touching screens.
 */
export interface ApiClient {
  /**
   * Which backend this client talks to. `mock` is the in-memory demo world (draws the mock
   * desktop); `live` is a real backend whose screens are only ever shown from a real noVNC target.
   * Optional so older adapters keep type-checking; absent means live.
   */
  readonly mode?: 'live' | 'mock';
  agents: AgentsApi;
  tasks: TasksApi;
  computers: ComputersApi;
  conversations: ConversationsApi;
  items: ItemsApi;
  runs: RunsApi;
  requests: RequestsApi;
  routines: RoutinesApi;
  rules: RulesApi;
  delegations: DelegationsApi;
  audit: AuditApi;
  memory: MemoryApi;
  home: HomeApi;
  profile: ProfileApi;
  goals: GoalsApi;
  ideas: IdeasApi;
  proactive: ProactiveApi;
  meals: MealsApi;
  calendar: AgentCalendarApi;
  inspiration: InspirationApi;
  feed: FeedApi;
  skills: SkillsApi;
  plugins: PluginsApi;
  apps: AppsApi;
  library: LibraryApi;
  artifacts: ArtifactsApi;
  documents: DocumentsApi;
  spaces: SpacesApi;
  usage: UsageApi;
  settings: SettingsApi;
}

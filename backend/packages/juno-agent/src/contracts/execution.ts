import { z } from 'zod';
import type { ApprovalPayload } from '@agent-desktop/public-contracts';
import type { StopActor, Store } from './storage.js';
import type { BlobStore } from './blobs.js';
import type { SystemOne } from '../ports/system-one/index.js';

// ---------------------------------------------------------------------------
// Harness: wake events and the inbox (BACKEND.md §3)
// ---------------------------------------------------------------------------

export const wakeKindSchema = z.enum([
  'user_message',
  'room_mention',
  'routine',
  /** PH12: a parent run spawned a scoped child task; never a peer or hidden chat. */
  'child_task',
  'webhook',
  'connector_event',
  'agent_message',
  'timer',
  'request_resolved',
  'hand_back',
  /** A background task this session started finished (child, shell, mcp, event); never an instruction. */
  'task_done',
  /** A goal's agent is due to plan, check in or remind about a deadline (BACKEND §5.10); like a routine, nobody waits on it. */
  'goal_checkin',
  /** An item in the agent's own calendar is due (or was missed); a trusted system wake the agent wrote for itself. */
  'calendar_due',
  /** A routine's missing capability appeared (an app was connected) or was lost (BACKEND §3.6.1); the agent tells the user in its chat. */
  /** A new account's first direct chat was opened: the agent speaks first (BACKEND §8.7 onboarding); a normal chat run, its reply is posted. */
  'onboarding',
  'capability_ready',
  'capability_lost',
  /** The agent handed a private question from a group to the owner's direct chat (send_message toOwner): a trusted system wake there, answered by the final reply. */
  'private_handoff',
  /** A monitor the agent created found something new (untrusted items) or needs the agent to speak (a trusted notice: failing, expired). */
  'monitor',
  // Best-effort client typing ping: extends a pending private reply window, never wakes an agent.
  'typing',
]);
export type WakeKind = z.infer<typeof wakeKindSchema>;

export const busyModeSchema = z.enum(['steer', 'collect', 'followup', 'interrupt', 'reject']);
export type BusyMode = z.infer<typeof busyModeSchema>;

export const wakeEventSchema = z.object({
  /** Idempotency key: the same id is processed once. */
  id: z.string().min(1),
  ownerId: z.string(),
  agentId: z.string(),
  /** `${agentId}:${conversationId}` — the Session object key. */
  sessionKey: z.string(),
  conversationId: z.string(),
  kind: wakeKindSchema,
  origin: z.object({
    type: z.enum(['user', 'agent', 'automation', 'system']),
    id: z.string().optional(),
    label: z.string().optional(),
  }),
  /** Only the user and user-authored routine prompts are trusted instructions. */
  trusted: z.boolean(),
  priority: z.enum(['user', 'peer', 'background']),
  payload: z.record(z.string(), z.unknown()),
  hop: z.object({ chainId: z.string(), depth: z.number().int().min(0) }).optional(),
  /** Override the session's busy mode for this event. */
  mode: busyModeSchema.optional(),
  at: z.string(),
  status: z.enum(['accepted', 'consumed', 'dropped']).default('accepted'),
  reason: z.string().optional(),
});
export type WakeEvent = z.infer<typeof wakeEventSchema>;

/** Read evidence covering one routine delivery conversation, from an authorized mark-read route. */
export const routineReadReceiptSchema = z.object({
  routineId: z.string().min(1),
  conversationId: z.string().min(1),
  /** Read time from the route; the streak cutoff. */
  readCutoff: z.string().min(1),
  /** Routine-visible output ids at/before the cutoff (bounded by the collector). */
  resultIds: z.array(z.string().min(1)),
});
export type RoutineReadReceipt = z.infer<typeof routineReadReceiptSchema>;

export const sessionKey = (agentId: string, conversationId: string) => `${agentId}:${conversationId}`;

/** Payload of a `task_done` wake: which background task finished and a bounded summary of how. */
export const taskDonePayloadSchema = z.object({
  taskId: z.string().min(1),
  taskKind: z.enum(['child', 'shell', 'mcp', 'event']),
  status: z.enum(['completed', 'failed', 'stopped', 'blocked', 'timeout']),
  summary: z.string(),
  resultRef: z.string().optional(),
  /** Background generation within the originating chain; a woken run may not spawn past the cap. */
  generation: z.number().int().min(1).optional(),
  /** The run that started the task: if the user stopped that run, its late completion is dropped. */
  originRunId: z.string().min(1).optional(),
});
export type TaskDonePayload = z.infer<typeof taskDonePayloadSchema>;

/**
 * A wake a routine started: its schedule, or its webhook (agentd hooks; a webhook from the manual
 * /wake route is user-origin). It is not a person's message: feed_post adds no card to the chat for it
 * and react has nothing to react to.
 */
export function isRoutineWake(event: Pick<WakeEvent, 'kind' | 'origin'>): boolean {
  return event.kind === 'routine' || event.kind === 'monitor' || event.kind === 'goal_checkin' || (event.kind === 'webhook' && event.origin.type === 'automation');
}

/** A screen-control notice (takeover / hand-back): context for the model, not a participant joining the run. */
export function isScreenControlNote(event: Pick<WakeEvent, 'kind' | 'payload'>): boolean {
  return event.kind === 'hand_back' && event.payload['source'] === 'screen_control';
}

/** Wake kinds that report finished or reported background work: system-origin, untrusted, background priority. */
export const COMPLETION_WAKE_KINDS: readonly WakeKind[] = ['task_done', 'hand_back', 'timer'];

/** agentd → the durable runner (packages/durable), in the same process. */
export interface Enqueuer {
  /**
   * Hand a wake event to `Session[sessionKey].receive` (deduped by the event id).
   * - Default (one-way send): `accepted: true` only means the runtime took the message. Session's own
   *   refusals (self_wake, busy_reject, hop_limit, peer_cost_cap, origin_stopped, already_delivered, ...)
   *   happen later and are NOT reported; `accepted: false` means the hand-off itself failed.
   * - `awaitDecision: true` (request-response, bounded wait): `accepted`/`reason` are Session.receive's own
   *   verdict, so a refusal comes back as `{ accepted: false, reason }`. A timeout is `accepted: true`
   *   with a reason saying the verdict is unconfirmed: the call still runs, so it must not be resent. Callers that must tell the model the truth use this.
   *   With a decision, `runId` is the run the wake is in when Session names it (see ReceiveDecision); absent otherwise.
   * - `delayMs` schedules the delivery (a delayed send, e.g. a wait_for notify expiry, H-85); a
   *   delayed send is always one-way and ignores `awaitDecision`.
   * Test doubles may ignore both options.
   */
  enqueue(event: WakeEvent, opts?: { delayMs?: number; awaitDecision?: boolean }): Promise<{ accepted: boolean; reason?: string; runId?: string }>;
  /** Cancel a running run. */
  stopRun(runId: string): Promise<void>;
  /** Resolve an awakeable a run is suspended on (approvals, questions, hand-back). */
  resolveAwakeable(awakeableId: string, value: unknown): Promise<void>;
  /** Re-arm a routine's timer after create/update/toggle. */
  scheduleRoutine(routineId: string): Promise<void>;
  /** Run a monitor's check now (the owner asked) and wait for its outcome; the schedule continues from now. */
  checkRoutine?(routineId: string): Promise<{ outcome: string }>;
  /** Arm (or, for a cancelled/moved item, re-arm or disarm) the timer of one agent calendar item; best-effort. */
  scheduleCalendarItem?(itemId: string): Promise<void>;
  /** Start the owner's hidden hourly/nightly memory schedule (BACKEND §5.4); idempotent, best-effort. */
  scheduleMemoryJobs?(ownerId: string): Promise<void>;
  /** Deliver one authorized read receipt to RoutineTimer[routineId].recordRead (best-effort). */
  routineResultsRead?(receipt: RoutineReadReceipt): Promise<void>;
  /**
   * PH12: start the Run workflow of an ALREADY RESERVED child run, keyed by that exact run id. The
   * workflow id is the idempotency key, so a retry starts the same run once — never a phantom run and
   * never a queued row with no workflow behind it.
   */
  startChildRun?(input: ChildRunStart): Promise<void>;
  /**
   * H-72: start a durable watcher for a background process; when it ends, the session gets one
   * task_done. Keyed by taskId, so a retried start never creates a second watcher.
   */
  watchTask?(input: TaskWatchStart): Promise<void>;
  /**
   * H-73: run one already-authorized tool call (MCP) in the background; its result reaches the session
   * as one task_done. Keyed by taskId, so a retried start never runs the call twice.
   */
  startBackgroundCall?(input: BackgroundCallStart): Promise<void>;
  /**
   * H-79: the run workflow's state in the runtime: 'running' (waiting or executing, it will take a cancel signal),
   * 'none' (an orphaned row nothing will finalize), undefined = unknown.
   */
  runState?(runId: string): Promise<'running' | 'none' | undefined>;
  /** H-79: tell a session its (orphaned) run is over, so queued messages start; ignored if not its active run. */
  releaseSession?(sessionKey: string, runId: string): Promise<void>;
}

/** An authorized tool call to run outside the run, and where its result goes. */
export interface BackgroundCallStart {
  taskId: string;
  ownerId: string;
  agentId: string;
  conversationId: string;
  /** The run that issued the call (tool context provenance). */
  runId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  /** The wake that started the issuing run (provenance and trust for the tool context). */
  wake: WakeEvent;
  /** H-75 background generation, carried into the task_done. */
  generation?: number;
}

/**
 * One background job the agent started (shell process, MCP background call, wait_for notify), kept so
 * the model can list and stop it after its context is compacted. Child runs are NOT copied here: their
 * run rows are the record. Only `notify` jobs wake the session and count toward the chain's background
 * total; a plain shell process is listed but does not count.
 */
export interface BackgroundTask {
  /** The task id (`shell-<agent>-<handle>`, `mcp-<stepId>`, or the wait subscription id). */
  id: string;
  ownerId: string;
  agentId: string;
  conversationId: string;
  /** The run that started the job. */
  runId: string;
  kind: 'shell' | 'mcp' | 'wait';
  /** A bounded description: the command, the tool name or the wait filter. */
  label: string;
  /** The agent's short imperative title for its task list (`title` on shell.start / an MCP background call). */
  title?: string;
  /** One line once it ended, e.g. "Exited with code 1" or the start of the call's result. */
  outcome?: string;
  /** The process handle (shell only). */
  handle?: string;
  /** The computer a shell process runs on; absent is the sandbox. */
  computer?: 'sandbox' | 'mac';
  notify: boolean;
  chainId: string;
  generation: number;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'stopped';
  /** The root run of the tree the starting run belongs to, copied from that run when the job is recorded (BACKEND 6.5). */
  rootRunId?: string;
  /** A stopped background MCP call: `aborted` = the in-flight call was cancelled; `marked` = only the row was marked and the call may still finish on the server. */
  stopDelivery?: 'aborted' | 'marked';
  /** Who stopped it, for a `stopped` job (BACKEND 6.5). */
  stoppedBy?: StopActor;
  startedAt: string;
  endedAt?: string;
}

/** A background process to watch until it ends, and the session to report to. */
export interface TaskWatchStart {
  taskId: string;
  ownerId: string;
  agentId: string;
  conversationId: string;
  /** The process handle on the agent's computer (shell.start). */
  handle: string;
  startedAt: number;
  hop?: { chainId: string; depth: number };
  /** H-75 background generation, carried into the task_done so a woken run cannot loop forever. */
  generation?: number;
  /** The run that started the process; a Stop on it drops the completion. */
  originRunId?: string;
  /** The computer the process runs on; absent is the sandbox. */
  computer?: 'sandbox' | 'mac';
}

/** The reserved child run a dispatcher starts; the core's Run workflow owns the actual execution. */
export interface ChildRunStart {
  runId: string;
  ownerId: string;
  agentId: string;
  conversationId: string;
  /** The canonical child session key; the workflow must not accept any other session. */
  sessionKey: string;
  planId: string;
  parentRunId: string;
  prompt: string;
  depth: number;
}

/** Durable service names (the runner registers these; agentd calls them). */
export const RESTATE = {
  session: 'Session', // Virtual Object keyed by sessionKey: receive, drainInbox, runFinished, getState
  run: 'Run', // Workflow keyed by runId: run, stop signal via cancellation
  routineTimer: 'RoutineTimer', // Virtual Object keyed by routineId: arm, fire, recordCompletion, recordRead
  calendarTimer: 'CalendarTimer', // Virtual Object keyed by calendar item id: arm, fire (the agent's own calendar)
  ideasTimer: 'IdeasTimer', // Virtual Object keyed by ownerId: arm, fire, runNow (daily ideas job, BACKEND §5.10)
  chatDigest: 'ChatDigest', // Virtual Object keyed by conversation id: touch, fire, runNow (background chat digest: memory, goals, group note; BACKEND §5.4)
  memoryTimer: 'MemoryTimer', // Virtual Object keyed by ownerId: arm, fire, runNow (hourly/nightly memory jobs, BACKEND §5.4)
  taskWatcher: 'TaskWatcher', // Virtual Object keyed by taskId: watch (H-72 background process completion)
  backgroundCall: 'BackgroundCall', // Virtual Object keyed by taskId: call (H-73 background MCP tool call)
} as const;

export interface Subscription {
  id: string;
  agentId: string;
  conversationId: string;
  /** The suspended Run; absent only on legacy wake-only subscriptions. */
  runId?: string;
  ownerId?: string;
  /** Durable first matching event, consumed by the original Run. */
  event?: Record<string, unknown>;
  /** Matches incoming connector/webhook events, e.g. { source: 'github', type: 'pr.merged', repo }. */
  filter: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
  /** H-69: notify mode — the first matching event wakes the session once with a task_done, then the subscription ends. */
  notify?: boolean;
  /** H-75 background generation of a notify subscription, carried into its task_done. */
  generation?: number;
  /** The run that created the notify subscription; a Stop on it drops the completion. */
  originRunId?: string;
}

/**
 * Durable proof that one external event was consumed by a waiting Run. Written in the same
 * transaction that deletes the subscription and appends the event to the transcript, so a
 * webhook retry arriving after the subscription is gone is acknowledged as a duplicate
 * instead of falling back to a brand-new Run. The id is deterministic over
 * owner/agent/conversation/source/type/event id: the same event redelivered replays to the same
 * row (upsert), while a new event id or a different owner/chat is a different receipt.
 */
export interface EventReceipt {
  id: string;
  agentId: string;
  conversationId: string;
  /** The Run that consumed the event. */
  runId: string;
  source: string;
  type: string;
  eventId: string;
  consumedAt: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Brain and tools (stream C)
// ---------------------------------------------------------------------------

/** How a model reaches the tools that are not in its short list (see execution/brain/tool-search-mode.ts). */
export type ToolSearchMode = 'responses-tool-search' | 'proxy';

export interface ToolContext {
  ownerId: string;
  agentId: string;
  conversationId: string;
  runId: string;
  /** The durable step this tool call belongs to; a deterministic child id is derived from it. */
  stepId?: string;
  store: Store;
  /** Where file bytes live (send_file, artifact_publish, attachments, approval previews). */
  blobs: BlobStore;
  enqueuer: Enqueuer;
  /** The wake event that started this run (provenance, trust). */
  wake: WakeEvent;
  /** Durable side-effect wrapper (Restate ctx.run in production, direct call in tests). */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  signal: AbortSignal;
  /** Whether the model running this step accepts images in tool results; a tool that returns a picture checks it (absent = not known). */
  supportsImages?: boolean;
  /** How the model running this run reaches hidden tools; tool_search words its answer for it (absent = proxy). */
  toolSearch?: ToolSearchMode;
  /** The conversation's frozen tool scope (batch 5b): discovery, tool search and the tool note offer only what it allows (absent = owner). */
  toolScope?: 'owner' | 'group' | 'other';
  /** The brain's auxiliary one-shot model call (null on any failure); absent when the brain has none. The purchase reviewer uses it. */
  quickText?(prompt: string, agentId?: string): Promise<string | null>;
  /** The brain's System One (typed decisions; the purchase and dialog reviewers use it); absent when the brain has none. */
  systemOne?: SystemOne;
  /** Set only inside a computer.batch step: a browser action then skips its after-action snapshot, because the batch observes once at the end. */
  quietObservation?: boolean;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }>;
  /** Structured details for the UI step row / audit. */
  details?: Record<string, unknown>;
  isError?: boolean;
  /**
   * The run should suspend after this tool (e.g. approval requested, wake_at).
   * PH12: 'child' is an explicit, durable child-wait branch — the core polls/sleeps (awaitChildTasks)
   * and NEVER asks the user, unlike 'user' which creates a request and awaits a human.
   */
  suspend?: { reason: 'user' | 'time' | 'event' | 'child'; awakeableId?: string; until?: string };
  /**
   * PH11: the trusted ACTIVE duration of the authorized effect, measured locally inside the effect —
   * never a model-claimed time and never the durable approval wait before it. It rides on the
   * fence-cached result, so a replay reports the same value and charges no extra elapsed time.
   */
  runtimeActiveMs?: number;
}

/** A connector's read-only evidence about an action whose durable result was lost. */
export type ToolReconciliation =
  | { status: 'succeeded'; result: ToolResult; evidence: string }
  | { status: 'not_executed'; evidence: string }
  | { status: 'unknown'; reason: string }
  | { status: 'failed'; reason: string };

/** Where an MCP tool comes from, for the approval brief: the connection, its catalog entry, and the server's own tool name. */
export interface ToolOrigin {
  connectionId: string;
  connectionName: string;
  /** Set when the connection was created from the connector catalog; delegations need it. */
  catalogId?: string;
  /** The connected account (e.g. the mailbox), when the connection records one. */
  account?: string;
  /** The tool's name on the server (not the model-facing name). */
  toolName: string;
  /** The server's human title for the tool (`title`, else `annotations.title`), when it gives one. */
  title?: string;
  /** The classifier's verdict (modules/mcp/tool-access.ts): a read runs without asking, an action follows `actions`. */
  access: 'read' | 'action';
  /** The agent's Actions policy for this app when the tool is offered at all (`off` hides the action tools): `ask` (the default) or `allow`. */
  actions?: 'ask' | 'allow';
  /** New, or its annotations changed, since the owner last reviewed the app's tools: it asks first whatever the policy says (modules/mcp/tool-ledger.ts). */
  needsReview?: true;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON schema (TypeBox or zod-to-json) for the model. */
  parameters: Record<string, unknown>;
  /**
   * Top-level optional string fields where an explicit null means "clear this value" (an update-style tool). For every other
   * optional string field "", blank and null mean "not provided" and are left out before execute (modules/tools/toolArguments.ts).
   */
  clearable?: readonly string[];
  /** `never`: a crash mid-call must not be replayed (clicks, sends, shell writes). */
  replay: 'never' | 'safe';
  /** Side effects are reviewed by the policy engine before execute(). */
  sideEffect: boolean;
  /** True for a tool served by an MCP connection (including the by-name dispatch handle); its name carries no marker. */
  mcp?: true;
  /** MCP tools: where the tool comes from. */
  origin?: ToolOrigin;
  // Compact disclosure marker: deferred behind tool_search in default view. In the list a run hands to `Brain.step`, true
  // marks a hidden tool: the model gets it only through tool_search (native deferred loading) or the tool_call proxy.
  deferLoading?: boolean;
  /** Offered only in a run where the owner is alone with the agent (profileAudience's owner-only); elsewhere the model is not shown it. */
  ownerOnly?: true;
  /** Offered only in a run nobody is waiting on (`offersQuietExit`: the root origin is unattended and not a platform chat); elsewhere the model is not shown it and the tool refuses. */
  unattendedOnly?: true;
  /** A tool a host plugin adds: outside the owner's own chat it is hidden (batch 5b, modules/tools/scope.ts). */
  plugin?: true;
  /** A connected-app tool whose catalog entry is marked `sharedRooms`: it stays offered in a group or a stranger's chat (set by the registry). */
  sharedRooms?: true;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
  /** Read-only lookup bound to this exact owner/account/action. Never repeat the original effect here. */
  reconcile?(args: unknown, ctx: ToolContext): Promise<ToolReconciliation>;
  /**
   * Internal multi-step execution for the few tools whose actions belong to another tool.
   * The harness invokes this only for the strict built-in browser allowlist, after this tool's
   * own policy/approval has passed and outside any outer effect fence. Every nested action is
   * still dispatched as its own canonical tool call.
   */
  orchestrate?(args: unknown, ctx: ToolContext, runtime: ToolOrchestrationRuntime): Promise<ToolOrchestrationOutcome>;
  /**
   * Optional extras for the approval card when the policy asks about this call (a purchase's order
   * fields and a screenshot of the screen). Runs inside the journaled approval step, so it must not
   * call `ctx.step`; a failure only leaves the extras out.
   */
  approvalDetails?(args: unknown, ctx: ApprovalDetailsContext): Promise<Pick<ApprovalPayload, 'purchase' | 'preview' | 'ui'>>;
}

/** The only nested browser actions an orchestrator may dispatch. Names are harness-owned. */
export const TOOL_ORCHESTRATION_ACTIONS = ['snapshot', 'click', 'type', 'fill', 'get_text', 'navigate', 'scroll'] as const;
export type ToolOrchestrationAction = (typeof TOOL_ORCHESTRATION_ACTIONS)[number];

export type ToolOrchestrationOutcome =
  | { kind: 'completed'; result: ToolResult }
  | { kind: 'cancelled' };

/** What one computer.batch step came to: it ran (its result and its own step id), it would need the owner's approval (nothing ran), or the run was stopped. */
export type ToolBatchStepOutcome =
  | { kind: 'ran'; result: ToolResult; stepId: string }
  | { kind: 'needs_approval'; reason: string }
  | { kind: 'cancelled' };

export interface ToolOrchestrationRuntime {
  signal: AbortSignal;
  /** Journal one native decision (or another pure choice) for replay determinism. */
  journal<T>(key: string, action: () => Promise<T>): Promise<T>;
  /** Run one canonical child tool call. The harness maps only TOOL_ORCHESTRATION_ACTIONS. */
  run(action: ToolOrchestrationAction, args: Record<string, unknown>): Promise<ToolOrchestrationOutcome>;
  /**
   * computer.batch only: run one action tool as its own canonical step (same preparation, policy, fence and journal as a single
   * call). A step whose policy would ask the owner is neither started nor asked: it comes back as `needs_approval`.
   */
  runTool?(name: string, args: Record<string, unknown>): Promise<ToolBatchStepOutcome>;
}

/** What `Tool.approvalDetails` may use: the run's identity, the store and the run's signal. */
export type ApprovalDetailsContext = Pick<ToolContext, 'ownerId' | 'agentId' | 'conversationId' | 'runId' | 'store' | 'blobs' | 'signal'>;

export interface ToolRegistry {
  /** Dispose owned MCP sessions and their sandbox processes when the execution runtime shuts down. */
  close?(): Promise<void>;
  nativeBrowserAvailable?(agentId: string): Promise<boolean>;
  /**
   * Tools exposed to an agent. `options.signal` aborts discovery (e.g. an MCP initialize handshake). `options.turn` is the
   * run turn asking (`runId:stepId`): an MCP connection re-lists at most once per turn.
   */
  forAgent(agentId: string, options?: { signal?: AbortSignal; turn?: string }): Promise<Tool[]>;
  get(name: string): Tool | undefined;
  /** `described`: keys of the tool definitions the model already holds (sent since the last compaction); the note lists those by name. */
  prepareForModel?(query: string, context: ToolContext, described?: ReadonlySet<string>): Promise<ToolResult>;
}

/** One search the model provider ran itself during a turn (its own web search tool): the query and the pages it read. */
export interface NativeWebSearch {
  query: string;
  sources: Array<{ title: string; url: string }>;
}

/** One assistant turn as journaled by the harness (provider-neutral; pi-ai message shape). */
export interface AssistantTurn {
  text: string;
  /** Searches the provider ran inside this call; the harness records each as a "Looked up" step with its links. */
  webSearches?: NativeWebSearch[];
  /**
   * The calls the model made, by the tool they reach. A hidden tool the model ran through the `tool_call` proxy
   * is listed as the real tool with the real arguments; `wireName` keeps what the model actually called, for replay.
   */
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown>; wireName?: string }>;
  /**
   * Measured provider usage. `costUsd` stays a number for legacy consumers; `costKnown` is false
   * when no real price was reported, so a 0 is unknown rather than free.
   */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    costUsd: number;
    costKnown?: boolean;
    /** False when the provider reported no usage object at all; then the counters are not measured. */
    measured?: boolean;
  };
  stopReason: 'stop' | 'tool_calls' | 'length' | 'error' | 'aborted';
}

/**
 * Where one model call's time went, for the per-call log line (never journaled, never content).
 * All times are milliseconds from the start of the call.
 */
export interface ModelCallStats {
  /** Model-visible schema/system-content fingerprints; no prompt text. */
  toolSchemaHash?: string;
  systemPromptHash?: string;
  toolCount?: number;
  /** Reading the transcript back from the store before the request (brain.step only). */
  hydrateMs?: number;
  /** Credential, limits and message preparation before the HTTP request starts. */
  prepMs: number;
  /** First stream event (the response has started). */
  firstEventMs?: number;
  /** First text, reasoning or tool-call delta. */
  firstTokenMs?: number;
  totalMs: number;
  /** Reasoning tokens, when the provider reports them (a subset of output tokens). */
  reasoningTokens?: number;
  /** Image blocks in the request and their base64 size: every call re-sends them in full. */
  images: number;
  imageKB: number;
  /** Responses over WebSocket or plain HTTP; absent for wires without the socket. */
  transport?: 'ws' | 'http';
  /** True when only new items were sent with previous_response_id (WebSocket transport). */
  delta?: boolean;
  deltaItems?: number;
  /** Why a WebSocket attempt ended on HTTP. */
  wsFallback?: string;
}

/** Provider-neutral transcript entry (pi-ai Message JSON), stored per session. */
export interface TranscriptEntry {
  /** Internal tool checkpoints; never included in the model message. */
  toolState?: Record<string, unknown>;
  id: string;
  sessionKey: string;
  seq: number;
  /** pi-ai message object: user / assistant / toolResult. */
  message: Record<string, unknown>;
  compactionEpoch: number;
  at: string;
}

export interface Brain {
  /** Build the model context for this session (system prompt, memory snapshot, transcript, wake). */
  buildContext(input: {
    agentId: string;
    conversationId: string;
    sessionKey: string;
    wake: WakeEvent[];
    /**
     * The journaled context from the previous loop iteration. When present the build
     * retains its frozen account model snapshot and original limits instead of
     * re-resolving the current account setting, so steering/tool refresh never swaps
     * the model mid-run or pairs a new model with stale limits.
     */
    previousContext?: BrainContext;
    /** Makes the appended context-note row id deterministic per run and step (a re-executed build rewrites it). */
    noteKey?: string;
    /** Tool names discovered now; their persisted order is merged and carried on the context. */
    toolNames?: string[];
  }): Promise<BrainContext>;
  /**
   * Run `fn` with the harness version this session is pinned to (the one its frozen system row names; the active one before there is a row),
   * so a wake text written into the transcript reads the same version as the session's context. Optional so test brains stay valid: absent
   * reads the active version.
   */
  withSessionHarness?<T>(entries: TranscriptEntry[], fn: () => T): Promise<T>;
  /** The journaled form of a context: no message list, which a model call re-derives from the transcript. Optional for test brains. */
  slim?(ctx: BrainContext): BrainContext;
  /** One model call. Streams deltas via onDelta; returns the final turn (journaled by the harness). */
  step(ctx: BrainContext, tools: Tool[], opts: { signal: AbortSignal; onDelta?: (text: string) => void; onStats?: (stats: ModelCallStats) => void }): Promise<AssistantTurn>;
  /**
   * How the model this agent would run on reaches hidden tools (resolved like a run's frozen model). Optional so test brains
   * stay valid; absent means the `tool_call` proxy.
   */
  toolSearchMode?(agentId: string): Promise<ToolSearchMode>;
  /** Whether the context should be compacted before the next step. */
  shouldCompact(ctx: BrainContext): boolean;
  /** `tools` (the run's own) lets the summary request reuse the run's cached prefix. */
  compact(ctx: BrainContext, tools?: Tool[]): Promise<BrainContext>;
  /** Compact a quiet chat in the background (owner scope required): the model a new run would use, no run prefix, no context note. Does nothing below a size floor. Optional so test brains stay valid. */
  compactIdle?(input: { agentId: string; conversationId: string; sessionKey: string }): Promise<void>;
  /**
   * One tool-less, single-message model call for short auxiliary text (run titles, role
   * suggestions). Resolves null on any failure or unusable reply; callers never block on it.
   * Optional so test brains that do not need it stay valid.
   */
  quickText?(prompt: string, agentId?: string): Promise<string | null>;
  /**
   * Typed decisions (BACKEND §10.14) for the current owner: their System One model, else the platform's, else the fast model
   * emulating one. Resolves null when none is available or the call failed; callers fail closed.
   */
  systemOne?: SystemOne;
  /**
   * One tool-less call for background work done on the user's behalf (the memory jobs, BACKEND §5.4), on the model that
   * agent would run on (the owner's own provider when they chose one). Must run inside the owner's scope. Resolves null when
   * there is no usable model or the answer is unusable; the measured usage comes back so the caller can record the spend.
   */
  completeText?(input: { agentId: string; sessionKey: string; system: string; prompt: string }): Promise<{ text: string; usage: AssistantTurn['usage']; model?: string } | null>;
}

/** Opaque to the harness; owned by the Brain (execution/brain). Must be JSON-serializable. */
export interface BrainContext {
  sessionKey: string;
  agentId: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Limits, one group per module. Each limit is enforced in exactly one place.
// ---------------------------------------------------------------------------

export const LIMITS = {
  /** One run (run-budget.ts): a single run stops when it reaches any of these. */
  run: { maxSteps: 150, maxActiveSeconds: 3600, maxCostUsd: 2 },
  /**
   * One chain: everything set off automatically by one user message or external event, tracked on
   * hop.chainId. These stop loops between agents and between a run and its background work.
   */
  chain: {
    /** Agent-to-agent hops and child spawn depth (Session checkHop, message/room/child tools). */
    maxHopDepth: 3,
    /** Total spend of the chain's agent-to-agent runs (Session checkPeerCost). */
    maxCostUsd: 0.5,
    /** Background task generations: a woken run may start one more, at most this deep (child-background.ts). */
    maxBackgroundGenerations: 3,
    /** Background runs one chain may start in total (child-background.ts). */
    maxBackgroundRuns: 10,
  },
  /** One session inbox (Session object): batching and throttling of non-user wakes. */
  session: { collectMaxEvents: 20, maxAutoStartsPerMinute: 5 },
  /** Routines (routines/interval.ts). */
  routine: { minIntervalMinutes: 5 },
} as const;

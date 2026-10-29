import {
  EventSchema,
  InterruptSchema,
  ResumeEntrySchema,
  RunAgentInputSchema,
} from '@ag-ui/core/schemas';
import { EventType } from '@ag-ui/core';
import { z } from 'zod';
import {
  agentSchema,
  artifactSchema,
  agentTaskSchema,
  agentStatusSchema,
  computerControllerSchema,
  computerStateSchema,
  conversationSchema,
  documentDraftSchema,
  feedPostSchema,
  goalSchema,
  idSchema,
  isoDateTimeSchema,
  ideaSchema,
  itemSchema,
  phoneCallActionSchema,
  requestSchema,
  routineSchema,
  runSchema,
  stepSchema,
  type Item,
  type Run,
  type Step,
} from './models/index.js';

// The official AG-UI protocol schemas, re-exported so every client takes them from the pinned
// @ag-ui/core release through this package. They are never copied or redefined here.
export {
  EventSchema as aguiEventSchema,
  InterruptSchema,
  ResumeEntrySchema,
  RunAgentInputSchema,
};
export type { Interrupt, ResumeEntry, RunAgentInput } from '@ag-ui/core';
export type { AGUIEvent, Message, UserMessage, AssistantMessage, ToolMessage } from '@ag-ui/core';

// The discriminator enum VALUE, so producers and consumers compare event types through the
// official enum instead of duplicating string literals.
export { EventType };

/** PROTOCOL_VERSION of the pinned @ag-ui/core release ("1.0"). */
export { PROTOCOL_VERSION as AGUI_PROTOCOL_VERSION } from '@ag-ui/core';

/**
 * Juno attribution and preview bookkeeping inside the official open `metadata` object, always
 * under the `juno` key (docs/architecture/AGUI-MIGRATION.md). Everything else in `metadata`
 * stays open for the protocol and other integrations.
 */
export interface JunoEventMetadata {
  /** Owning agent (in rooms: the agent that acts). */
  agentId?: string;
  /** Internal durable conversation; equals the wire `threadId` when present. */
  conversationId?: string;
  /** Internal durable run id, when it differs from the wire runId. */
  runId?: string;
  /** The run that spawned this subagent run (SUBAGENT_* attribution). */
  parentRunId?: string;
  /** Public durable row carried with lifecycle attribution; internal reservation fields are stripped. */
  run?: Run;
  /** Public step projection accompanying STEP_* frames. */
  step?: Step;
  /**
   * A MESSAGES_SNAPSHOT message carries the complete public item it projects, so a client rebuilds
   * roles, cards, artifacts and every other item field from the same object as the REST page.
   */
  item?: Item;
  /** Snapshot message: the human author of a user message. */
  authorId?: string;
  /** Snapshot message: the item's own timestamp (ordering marker alongside `item.at`). */
  at?: string;
  /** Preview: monotonic within a run; a frame from a superseded generation must be ignored. */
  generationId?: number;
  /** Preview: monotonic per-attempt frame ordinal, so a replayed frame is ignored. */
  seq?: number;
  /** Preview: ephemeral per-execution attempt identity (`messageId` is `preview_<attemptId>`). */
  attemptId?: string;
  /** Preview: the cap was reached, the rest is withheld until the item commits. */
  truncated?: boolean;
  /** Durable request id behind an interrupt or a request CUSTOM event. */
  requestId?: string;
  /** Durable step id of the run step a STEP_* event carries. */
  stepId?: string;
  /** TOOL_CALL_ARGS: the arguments were structurally limited; `delta` is still valid JSON with a truncation marker. */
  argumentsTruncated?: boolean;
  /** Durable run status at emit time; the durable row stays the authority for run state. */
  runStatus?: string;
}

/** The wire type for the `metadata` field of a standard event that carries Juno attribution. */
export type JunoMetadataCarrier = { metadata?: { juno?: JunoEventMetadata } };

/**
 * Juno product events: everything that is not the agent chat protocol. AG-UI replaces only the
* chat wire; product CRUD/events (settings, agents, feed, goals, library, computer, device,
 * requests, conversations, items) keep their names and payloads unchanged.
 */
export const junoProductEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent.status'),
    agentId: idSchema,
    status: agentStatusSchema,
    /** Present only while `status` is `working`. */
    doing: z.string().optional(),
  }),
  // v0.3: agents are user-created, so the list can change at runtime.
  z.object({ type: z.literal('agent.created'), agent: agentSchema }),
  z.object({ type: z.literal('agent.updated'), agent: agentSchema }),
  // UI108: deleting an agent emits a tombstone so SSE replay from cursor 0
  // cannot resurrect the removed row.
  z.object({ type: z.literal('agent.deleted'), agentId: idSchema }),
  // BACKEND §5.2: a home file changed (user edit or a sync that found a change); refetch it. `agentId` is absent for the
  // user's own files (USER.md, shared memory); `ownerId` then names whose event it is, since no agent row does.
  z.object({ type: z.literal('agent.home.changed'), agentId: idSchema.optional(), ownerId: idSchema.optional(), path: z.string().min(1) }),
  z.object({
    type: z.literal('computer.state'),
    computerId: idSchema,
    state: computerStateSchema,
    controller: computerControllerSchema,
  }),
  // 0.71.0 (unreleased): who may act on a surface changed (the person took a screen or handed it back; the Mac was Stopped or resumed). The row is
  // the truth; this tells open clients to refetch it. No page titles or command text travel here.
  z.object({
    type: z.literal('control.changed'),
    ownerId: idSchema,
    surface: z.discriminatedUnion('kind', [z.object({ kind: z.literal('screen'), screenId: idSchema }), z.object({ kind: z.literal('mac'), macId: idSchema })]),
    agentId: idSchema.optional(),
    holder: z.enum(['agent', 'user', 'stopped']),
    epoch: z.number().int().min(0),
    since: isoDateTimeSchema,
    phase: z.enum(['taken', 'returned', 'stopped', 'resumed']),
  }),
  // 0.6: an artifact got a new version (artifact_publish with artifactId): replace the cached row; the chat card shows the newest.
  z.object({ type: z.literal('artifact.updated'), artifact: artifactSchema }),
  // 0.70: a document's draft was created, saved, approved, declined or replaced (BACKEND 5.11a): replace the cached draft by id; `status` says whether it is still open.
  z.object({ type: z.literal('document.draft.updated'), draft: documentDraftSchema }),
  // v0.3: new direct/room threads can be created at runtime.
  z.object({ type: z.literal('conversation.created'), conversation: conversationSchema }),
  // A full conversation snapshot: a flag changed (pinned/muted), the chat was marked read, or a message-like
  // item arrived (fresh derived unreadCount / lastItemAt). Replace the cached row; repeats are harmless.
  z.object({ type: z.literal('conversation.updated'), conversation: conversationSchema }),
  // UI108: deleting a conversation emits a tombstone so SSE replay from cursor 0
  // cannot resurrect the removed row.
  z.object({ type: z.literal('conversation.deleted'), conversationId: idSchema }),
  // Durable approval/question cards: card CRUD and multi-device sync. The standard wire surface
  // of the same decision is the RUN_FINISHED interrupt outcome plus RunAgentInput.resume.
  z.object({ type: z.literal('request.created'), request: requestSchema }),
  z.object({ type: z.literal('request.resolved'), request: requestSchema }),
  z.object({ type: z.literal('routine.updated'), routine: routineSchema }),
  z.object({ type: z.literal('goal.updated'), goal: goalSchema }),
  z.object({ type: z.literal('goal.deleted'), goalId: idSchema }),
  z.object({ type: z.literal('idea.updated'), idea: ideaSchema }),
  // 0.3: an agent task started, progressed or finished (also the first sighting of a new one): upsert by id.
  z.object({ type: z.literal('task.updated'), task: agentTaskSchema }),
  // Feed posts an agent published (feed_post) or the user liked; owner-filtered like every other event.
  z.object({ type: z.literal('feed.created'), post: feedPostSchema }),
  z.object({ type: z.literal('feed.updated'), post: feedPostSchema }),
  // A routine run finished with new feed posts (the push trigger when the routine's notify is not 'never'); clients refetch the Feed.
  z.object({ type: z.literal('feed.brief'), routineId: idSchema, title: z.string(), postIds: z.array(idSchema).min(1), firstPostTitle: z.string(), notify: z.boolean() }),
  // The server asks the iPhone app (which declared it can answer) to run one EventKit call (BACKEND 7.13). Only the app whose
  // `deviceId` matches acts, and only before `expiresAt`; it answers with POST /v1/phone/calls/:callId/result. Other clients ignore it.
  z.object({
    type: z.literal('device.call'),
    agentId: idSchema,
    deviceId: z.string(),
    callId: z.string().min(1),
    action: phoneCallActionSchema,
    args: z.record(z.string(), z.unknown()),
    expiresAt: z.string(),
  }),
  // The authoritative persisted transcript item (user turn, agent reply, artifact, request card,
  // ...). Provisional streaming text never replaces it.
  z.object({ type: z.literal('item.added'), conversationId: idSchema, item: itemSchema }),
]);
export type JunoProductEvent = z.infer<typeof junoProductEventSchema>;

/**
 * The live event stream (docs/architecture/AGUI-MIGRATION.md): the official AG-UI chat protocol
 * plus Juno product events. The chat lifecycle (runs, steps, streamed text, tool calls,
 * activities, subagents, interrupts) uses only standard AG-UI event types.
 */
export const agentEventSchema = z.union([EventSchema, junoProductEventSchema]);
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventType = AgentEvent['type'];

export type Unsubscribe = () => void;
export type EventHandler = (event: AgentEvent) => void;

/** Interface the app subscribes to; the mock implements it, the real backend will use SSE/WS. */
export interface EventSource {
  subscribe(handler: EventHandler): Unsubscribe;
  /** Whether the live stream is up (false while it reconnects). Absent on sources without a stream. */
  isConnected?(): boolean;
  /** Notified when `isConnected` changes. */
  subscribeConnection?(listener: (connected: boolean) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Stored-history read migration (docs/architecture/AGUI-MIGRATION.md). The old
// wire shapes below exist ONLY here, to normalize rows written before the
// migration; no producer may emit them again.
// ---------------------------------------------------------------------------

const legacyPreviewSchema = z.object({ type: z.literal('message.preview') }).loose();
const legacyRunStartedSchema = z.object({ type: z.literal('run.started'), run: runSchema });
const legacyRunUpdatedSchema = z.object({ type: z.literal('run.updated'), run: runSchema });
const legacyRunFinishedSchema = z.object({ type: z.literal('run.finished'), run: runSchema });
const legacyStepAddedSchema = z.object({ type: z.literal('step.added'), step: stepSchema });
const legacyStepUpdatedSchema = z.object({ type: z.literal('step.updated'), step: stepSchema });

const junoMetadataOf = (agentId: string, conversationId?: string): { juno: JunoEventMetadata } => ({
  juno: {
    agentId,
    ...(conversationId === undefined ? {} : { conversationId }),
  },
});

const threadIdOf = (conversationId: string | undefined, runId: string): string => conversationId ?? runId;

const runSegmentMetadata = (run: { id: string; agentId: string; conversationId?: string; status: string }): { juno: JunoEventMetadata } => ({
  juno: {
    agentId: run.agentId,
    ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
    runId: run.id,
    // The durable row stays the authority for the run status; the AG-UI outcome only describes
    // the wire segment (docs/architecture/AGUI-MIGRATION.md).
    runStatus: run.status,
  },
});

const stepMetadataOf = (step: { id: string; runId: string }): { juno: JunoEventMetadata } => ({
  juno: { runId: step.runId, stepId: step.id },
});

const stepNameOf = (step: { title?: string; verb: string; target: string }): string =>
  step.title ?? `${step.verb} ${step.target}`;

/**
 * Normalizes one stored event row to the current wire: standard events pass through, legacy chat
 * events map to their standard equivalents, provisional preview frames are dropped (history truth
 * is the items), and anything unrecognized fails closed as `null` so one bad row cannot break a
 * replay. Never mutates storage.
 */
export function normalizeStoredAgentEvent(raw: unknown): AgentEvent | null {
  const standard = EventSchema.safeParse(raw);
  if (standard.success) return standard.data;
  const preview = legacyPreviewSchema.safeParse(raw);
  if (preview.success) return null;
  const runStarted = legacyRunStartedSchema.safeParse(raw);
  if (runStarted.success) {
    const run = runStarted.data.run;
    return {
      type: EventType.RUN_STARTED,
      threadId: threadIdOf(run.conversationId, run.id),
      runId: run.id,
      metadata: junoMetadataOf(run.agentId, run.conversationId),
    };
  }
  const runUpdated = legacyRunUpdatedSchema.safeParse(raw);
  if (runUpdated.success) {
    const run = runUpdated.data.run;
    return { type: EventType.CUSTOM, name: 'juno.run.updated', value: run, metadata: runSegmentMetadata(run) };
  }
  const runFinished = legacyRunFinishedSchema.safeParse(raw);
  if (runFinished.success) {
    const run = runFinished.data.run;
    if (run.status === 'failed') {
      return { type: EventType.RUN_ERROR, message: run.error ?? 'run failed', metadata: runSegmentMetadata(run) };
    }
    return {
      type: EventType.RUN_FINISHED,
      threadId: threadIdOf(run.conversationId, run.id),
      runId: run.id,
      outcome: { type: run.status === 'stopped' ? 'cancelled' : 'success' },
      metadata: runSegmentMetadata(run),
    };
  }
  const stepAdded = legacyStepAddedSchema.safeParse(raw);
  if (stepAdded.success) {
    const step = stepAdded.data.step;
    return { type: EventType.STEP_STARTED, stepName: stepNameOf(step), metadata: stepMetadataOf(step) };
  }
  const stepUpdated = legacyStepUpdatedSchema.safeParse(raw);
  if (stepUpdated.success) {
    const step = stepUpdated.data.step;
    return { type: EventType.STEP_FINISHED, stepName: stepNameOf(step), metadata: stepMetadataOf(step) };
  }
  const product = junoProductEventSchema.safeParse(raw);
  if (product.success) return product.data;
  return null;
}

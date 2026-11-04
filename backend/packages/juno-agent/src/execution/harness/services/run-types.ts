import type { BlobStore, Brain, Enqueuer, Store, ToolRegistry, ToolSearchMode, WakeEvent } from '../../../contracts/index.js';
import type { DurablePromise } from '@agent-desktop/durable';
import type { TypingState } from './session-state.js';
import type { AttachmentPlacement } from '../../../modules/attachments/placement.js';
import type { HomeComputer } from '../../../ports/computer/index.js';
import type { EngineRegistry } from '../engines/registry.js';
import type { LiveRunSink } from '../../live-runs.js';
import type { ComputerHolds } from './computer-holds.js';

export interface RunInput {
  agentId: string;
  conversationId: string;
  sessionKey: string;
  wakeEvents: WakeEvent[];
  /** User wakes incorporated from the inbox during this run, reconstructed during durable replay. */
  steeredUserItemIds?: string[];
  /**
   * Set during the run (never sent by Session) from the frozen model snapshot of the step in progress: whether the model
   * accepts images in tool results. Tools read it through `ToolContext.supportsImages`.
   */
  supportsImages?: boolean;
  /** Set during the run the same way: how the model reaches hidden tools. Tools read it through `ToolContext.toolSearch`. */
  toolSearch?: ToolSearchMode;
  /** Set during the run the same way: the conversation's frozen tool scope (batch 5b). Tools read it through `ToolContext.toolScope`. */
  toolScope?: 'owner' | 'group' | 'other';
  /** Set during the run the same way: the model of the step in progress, for the tool-argument log. */
  modelId?: string;
  /** Set once when the loop starts (journaled): nobody is waiting on this run (`speaksOnlyBySend`), so its final text is a record line and the wake note says so. */
  sendOnly?: boolean;
}

export interface RunServices {
  store: Store;
  /** File bytes: attachments, and the images of transcript rows (BACKEND §5.2a). */
  blobs: BlobStore;
  enqueuer: Enqueuer;
  brain: Brain;
  toolRegistry: ToolRegistry;
  /** Injected engine registry; absent means the default pi-only catalog. */
  engines?: EngineRegistry;
  /** The user's computer home: uploaded files are copied there when a wake is written to the transcript (BACKEND §10.8). */
  home?: HomeComputer;
  /** Keeps the owner's computer from pausing while a run is in progress (BACKEND §7.3b); absent when the deployment has no computer. */
  computerHolds?: ComputerHolds;
  /** Where a live model attempt's streamed text goes (execution/live-runs.ts); absent publishes none. Not storage: nothing here is durable. */
  live?: LiveRunSink;
  /** Structured log sink (timing lines); absent in tests. Never given prompt content or keys. */
  log?: (fields: Record<string, unknown>, message: string) => void;
}

/** Where this run's uploaded files go: its user's computer, reached through the run's agent; none when the deployment has no computer. */
export const attachmentPlacement = (services: RunServices, input: RunInput): AttachmentPlacement | undefined =>
  services.home === undefined ? undefined : { agentId: input.agentId, home: services.home };

/**
 * The slice of the workflow context the run loop needs, so the loop is testable with a plain
 * mock instead of the full runner context. A real `WorkflowContext` is structurally assignable (see
 * run.ts, which adapts `objectClient(...).drainInbox()` into `drainInbox()`).
 */
export interface RunContext {
  rand: { uuidv4(): string };
  /** Durable time source when the runtime provides one; absent means the local clock (tests). */
  date?: { now(): DurablePromise<number> };
  /**
   * Plain local clock for use INSIDE a `ctx.run` action, where calling a durable SDK op would be
   * illegal. Its reading is serialized with the step's result, so a replay never re-reads a clock.
   */
  localDate?: { now(): number };
  /** Durable sleep at the top level (a child-task wait), SDK-branded; a test double may omit it. */
  sleep?: (ms: number) => DurablePromise<void>;
  run<T>(name: string, action: () => Promise<T>): DurablePromise<T>;
  awakeable<T>(): { id: string; promise: DurablePromise<T> };
  drainInbox(): DurablePromise<WakeEvent[]>;
  /** Read-only look at the session's typing presence and queued steer (holds a ready reply while the user types); absent in tests. */
  typingState?(): DurablePromise<TypingState>;
  /** Journaled one-way send of a wake to a session, optionally delayed (completion wakes, wake_at). */
  sendWake?: (wake: WakeEvent, delayMs?: number) => void;
}

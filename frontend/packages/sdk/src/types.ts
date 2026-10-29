import type {
  AgentTask,
  Conversation,
  Item,
  Request,
  ResolveRequestInput,
  Run,
  StepStatus,
} from '@agent-desktop/client';
import type { Chat } from './chat.js';

export type { AgentTask, Conversation, Item, Request, ResolveRequestInput, Run, StepStatus };

/** What the caller answers an approval or question with: the server's `requests.resolve` body. */
export type ApprovalDecision = ResolveRequestInput;

/**
 * One event of a chat turn, in the order it happened.
 *
 * - `text-delta`: visible reply text as the model streams it. Provisional: an attempt can be discarded,
 *   so the `message` event carrying the committed reply is the authoritative text.
 * - `message`: an item the conversation gained during the turn (agent reply, plan, artifact, ...). The
 *   caller's own message is not repeated.
 * - `tool`: a step of the run (a tool call) changed status.
 * - `request`: the run is waiting on the caller (approval, question, sign-in, ...). Emitted only when no
 *   `onApproval` handled it; answer it with `chat.resolve(request.id, decision)` while iterating.
 * - `done`: the run reached a terminal status (`completed`, `failed`, `stopped` or `blocked`). The turn ends.
 */
export type ChatEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'message'; item: Item }
  | { type: 'tool'; name: string; status: StepStatus }
  | { type: 'request'; request: Request }
  | { type: 'done'; run: Run };

export interface SendOptions {
  /**
   * Answers the approvals and questions the run raises during this turn. Called once per request; its
   * decision is sent to the server. While it is set, those requests are not yielded as `request` events.
   * Sign-in, computer and secure-input requests are always yielded.
   *
   * If the callback throws (or the decision is refused), the turn rejects with that error. The request
   * stays pending on the server until someone resolves it.
   */
  onApproval?: (request: Request) => Promise<ApprovalDecision>;
}

/** Where a chat lives: the direct chat with an agent (opened or created), or an existing conversation. */
export type ChatTarget = { agentId: string } | { conversationId: string };

export interface JunoOptions {
  /** The server origin, for example `https://juno.example.com`. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token: string;
  /** Custom fetch (tests, or a runtime without a global one). Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

export interface Juno {
  /** Opens the direct chat with an agent (creating it on first use), or resumes a conversation by id. */
  chat(target: ChatTarget): Promise<Chat>;
  /**
   * Subscribes to background task completion: fires once per task when it reaches `completed`, `failed`
   * or `stopped`. Returns an unsubscribe function.
   */
  on(event: 'task.finished', handler: (task: AgentTask) => void): () => void;
  /** Stops the live stream and ends every open turn with a `CLOSED` error. */
  close(): Promise<void>;
}

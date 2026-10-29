import type { Conversation, Request, Run } from '@agent-desktop/client';
import { JunoError, guard } from './errors.js';
import { runTurn, type TurnContext, type TurnState } from './turn.js';
import type { ApprovalDecision, ChatEvent, SendOptions } from './types.js';

/** One conversation with an agent. Obtain it from `juno.chat(...)`. */
export class Chat {
  /** The turn being iterated right now, if any. `stop()` acts on it. */
  private current: TurnState | null = null;

  constructor(
    private readonly ctx: TurnContext,
    /** The conversation as it was when the chat was opened. */
    readonly conversation: Conversation,
  ) {}

  /** The conversation id; pass it to `juno.chat({ conversationId })` to resume later. */
  get id(): string {
    return this.conversation.id;
  }

  /**
   * Sends `text` and iterates the turn until its run finishes. The message is posted when iteration
   * starts. Breaking out of the loop stops listening; the run itself keeps going on the server (use `stop()`).
   */
  send(text: string, options: SendOptions = {}): AsyncGenerator<ChatEvent> {
    const turn: TurnState = { runId: undefined };
    return this.track(turn, runTurn(this.ctx, this.conversation.id, text, options, turn));
  }

  /**
   * Stops the run of the turn being iterated (`POST /v1/runs/:id/stop`). The turn then ends with `done`
   * and status `stopped`. Rejects with `NO_ACTIVE_RUN` when no turn is being iterated, or when its run is not
   * known yet (before the send is answered, or for a room message that woke several agents).
   */
  async stop(): Promise<Run> {
    if (this.current === null) {
      throw new JunoError('NO_ACTIVE_RUN', 'No turn is being iterated on this chat');
    }
    const runId = this.current.runId;
    if (runId === undefined) {
      throw new JunoError('NO_ACTIVE_RUN', 'The turn has no single run to stop (it is not known yet, or the message woke several agents)');
    }
    return guard(this.ctx.api.runs.stop(runId));
  }

  /** Answers a pending approval, question or other request (for example one yielded as a `request` event). */
  resolve(requestId: string, decision: ApprovalDecision): Promise<Request> {
    return guard(this.ctx.api.requests.resolve(requestId, decision));
  }

  /** Marks `turn` as the one `stop()` acts on while it is iterated. */
  private async *track(turn: TurnState, events: AsyncGenerator<ChatEvent>): AsyncGenerator<ChatEvent> {
    this.current = turn;
    try {
      yield* events;
    } finally {
      if (this.current === turn) this.current = null;
    }
  }
}

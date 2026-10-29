import type { AgentEvent, ApiClient, Request, RequestKind, Run, RunStatus } from '@agent-desktop/client';
import { EventType, runSchema } from '@agent-desktop/client';
import { JunoError, guard } from './errors.js';
import type { EventHub } from './hub.js';
import { AsyncQueue } from './queue.js';
import type { ApprovalDecision, ChatEvent, SendOptions } from './types.js';

/** Runs in these statuses have stopped for good; a conversation's other runs may still be busy. */
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'stopped', 'blocked']);
/** Request kinds the `onApproval` callback answers. Sign-in, computer and secure-input requests are yielded. */
const CALLBACK_KINDS: ReadonlySet<RequestKind> = new Set(['approval', 'question']);
/** How many of a conversation's runs are read before a turn, to tell the busy ones from the finished ones. */
const RUN_SNAPSHOT_LIMIT = 100;
const PREVIEW_PREFIX = 'preview_';

/** What a turn needs from its client. */
export interface TurnContext {
  readonly api: ApiClient;
  readonly hub: EventHub;
  /** Registers a turn's failure hook so `close()` can end it. Returns the unregister function. */
  register(fail: (error: unknown) => void): () => void;
  isClosed(): boolean;
}

/** The turn's run, once known. `runId` stays undefined until then, and stays so when no single run is named. */
export interface TurnState {
  runId: string | undefined;
}

interface PreviewAttempt {
  generation: number;
  messageId: string;
  seq: number;
  open: boolean;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function junoMetadata(event: AgentEvent): Record<string, unknown> | undefined {
  if (!('metadata' in event) || !isRecord(event.metadata)) return undefined;
  return isRecord(event.metadata['juno']) ? event.metadata['juno'] : undefined;
}

/**
 * Runs one chat turn through the standard AG-UI run entry.
 *
 * Provisional `TEXT_MESSAGE_CONTENT` deltas are append-only and ordered by `metadata.juno.seq`.
 * The authoritative `item.added` reply is yielded once. A terminal run is read from the durable run
 * row so callers receive the same whole `Run` shape they received before the protocol migration.
 */
export async function* runTurn(
  ctx: TurnContext,
  conversationId: string,
  text: string,
  options: SendOptions,
  turn: TurnState,
): AsyncGenerator<ChatEvent> {
  if (ctx.isClosed()) throw closedError();

  const queue = new AsyncQueue<AgentEvent>();
  const detach = ctx.hub.attach((event) => queue.push(event));
  const unregister = ctx.register((error) => queue.fail(error));
  try {
    const existing = await guard(ctx.api.runs.list({ conversationId, limit: RUN_SNAPSHOT_LIMIT }));
    const known = new Set(existing.items.map((run) => run.id));
    const busyBeforeSend = existing.items.find((run) => !TERMINAL_RUN_STATUSES.has(run.status))?.id;

    const sent = await guard(ctx.api.conversations.send(conversationId, { text }));
    let primary: string | undefined = sent.runId ?? busyBeforeSend;
    turn.runId = primary;

    let attempt: PreviewAttempt | null = null;
    let lastRun: Run | undefined;
    const toolStatus = new Map<string, string>();
    const followRun = (runId: string): void => {
      if (primary === undefined) {
        primary = runId;
        turn.runId = runId;
      }
    };

    for (;;) {
      const event = await queue.next();
      switch (event.type) {
        case EventType.RUN_STARTED: {
          const juno = junoMetadata(event);
          const runId = typeof juno?.['runId'] === 'string' ? juno['runId'] : event.runId;
          if (juno?.['conversationId'] === conversationId && !known.has(runId)) followRun(runId);
          break;
        }
        case EventType.RUN_FINISHED: {
          const juno = junoMetadata(event);
          const runId = typeof juno?.['runId'] === 'string' ? juno['runId'] : event.runId;
          if (!known.has(runId)) followRun(runId);
          if (event.outcome?.type === 'interrupt') break;
          if (runId !== primary) break;
          const run = lastRun?.id === runId && TERMINAL_RUN_STATUSES.has(lastRun.status) ? lastRun : await guard(ctx.api.runs.get(runId));
          yield { type: 'done', run };
          return;
        }
        case EventType.RUN_ERROR: {
          const juno = junoMetadata(event);
          const runId = typeof juno?.['runId'] === 'string' ? juno['runId'] : undefined;
          if (runId === undefined) break;
          followRun(runId);
          if (runId !== primary) break;
          const run = await guard(ctx.api.runs.get(runId));
          yield { type: 'done', run };
          return;
        }
        case EventType.STEP_STARTED:
        case EventType.STEP_FINISHED: {
          const juno = junoMetadata(event);
          const runId = typeof juno?.['runId'] === 'string' ? juno['runId'] : undefined;
          if (primary === undefined || runId !== primary) break;
          const status = event.type === EventType.STEP_STARTED ? 'running' : 'completed';
          const key = String(juno?.['stepId'] ?? event.stepName);
          if (toolStatus.get(key) === status) break;
          toolStatus.set(key, status);
          yield { type: 'tool', name: event.stepName, status };
          break;
        }
        case EventType.TEXT_MESSAGE_START:
        case EventType.TEXT_MESSAGE_CONTENT:
        case EventType.TEXT_MESSAGE_END: {
          if (!event.messageId.startsWith(PREVIEW_PREFIX)) break;
          const juno = junoMetadata(event);
          const runId = typeof juno?.['runId'] === 'string' ? juno['runId'] : undefined;
          if (juno?.['conversationId'] === conversationId && runId !== undefined && !known.has(runId)) followRun(runId);
          if (runId !== primary) break;
          const update = applyPreview(attempt, event, juno);
          if (update === null) break;
          attempt = update.attempt;
          if (update.text) yield { type: 'text-delta', text: update.text };
          break;
        }
        case EventType.CUSTOM: {
          const juno = junoMetadata(event);
          if (event.name === 'juno.run.updated') {
            const parsed = runSchema.safeParse(event.value);
            if (!parsed.success) break;
            if (parsed.data.conversationId === conversationId && !known.has(parsed.data.id)) followRun(parsed.data.id);
            if (parsed.data.id === primary) lastRun = parsed.data;
            break;
          }
          if (event.name === 'juno.preview.closed' || event.name === 'juno.preview.snapshot') {
            const runId = typeof juno?.['runId'] === 'string' ? juno['runId'] : undefined;
            if (runId !== primary) break;
            const update = applyPreview(attempt, event, juno);
            if (update === null) break;
            attempt = update.attempt;
            if (update.text) yield { type: 'text-delta', text: update.text };
          }
          break;
        }
        case 'item.added': {
          if (event.item.conversationId === conversationId && event.item.type !== 'user_message') {
            yield { type: 'message', item: event.item };
          }
          break;
        }
        case 'request.created': {
          const request = event.request;
          const inTurn =
            request.conversationId !== undefined
              ? request.conversationId === conversationId
              : primary !== undefined && request.runId === primary;
          if (!inTurn) break;
          if (options.onApproval && CALLBACK_KINDS.has(request.kind)) {
            answerRequest(ctx, queue, options.onApproval, request);
            break;
          }
          yield { type: 'request', request };
          break;
        }
        default:
          break;
      }
    }
  } finally {
    detach();
    unregister();
  }
}

type PreviewEvent = Extract<AgentEvent, {
  type: EventType.TEXT_MESSAGE_START | EventType.TEXT_MESSAGE_CONTENT | EventType.TEXT_MESSAGE_END;
}> | Extract<AgentEvent, { type: EventType.CUSTOM }>;

function applyPreview(
  current: PreviewAttempt | null,
  event: PreviewEvent,
  juno: Record<string, unknown> | undefined,
): { attempt: PreviewAttempt; text?: string } | null {
  const generation = typeof juno?.['generationId'] === 'number' ? juno['generationId'] : 0;
  const seq = typeof juno?.['seq'] === 'number' ? juno['seq'] : 0;
  if (event.type === EventType.CUSTOM) {
    const value = isRecord(event.value) ? event.value : undefined;
    if (current === null || value === undefined) return null;
    const generationId = typeof value['generationId'] === 'number' ? value['generationId'] : 0;
    if (current.generation > generationId) return null;
    if (event.name === 'juno.preview.snapshot') {
      if (event.value === undefined || !isRecord(event.value)) return null;
      const text = event.value['text'];
      const messageId = event.value['messageId'];
      if (typeof text !== 'string' || typeof messageId !== 'string') return null;
      const snapshotSeq = typeof event.value['seq'] === 'number' ? event.value['seq'] : seq;
      const snapshotGeneration = typeof event.value['generationId'] === 'number' ? event.value['generationId'] : generationId;
      if (snapshotGeneration < current.generation) return null;
      if (current.messageId === messageId && snapshotSeq <= current.seq) return null;
      const accepted = text.startsWith(current.text) ? text.slice(current.text.length) : text;
      return { attempt: { ...current, messageId, generation: snapshotGeneration, seq: snapshotSeq, open: true, text }, ...(accepted ? { text: accepted } : {}) };
    }
    if (current.generation !== generationId) return null;
    const messageId = typeof value['messageId'] === 'string' ? value['messageId'] : current.messageId;
    if (value['scope'] !== 'generation' && messageId !== current.messageId) return null;
    return { attempt: { ...current, open: false } };
  }

  if (current !== null && generation < current.generation) return null;
  const newGeneration = current === null || generation > current.generation;
  const newAttempt = current === null || event.messageId !== current.messageId;
  if (newAttempt && !newGeneration && event.type !== EventType.TEXT_MESSAGE_START) return null;
  const base: PreviewAttempt =
    current !== null && !newGeneration && !newAttempt
      ? current
      : { generation, messageId: event.messageId, seq: -1, open: true, text: '' };
  if (seq <= base.seq) return null;
  if (event.type === EventType.TEXT_MESSAGE_START) return { attempt: { ...base, seq } };
  if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
    if (!base.open) return null;
    return { attempt: { ...base, seq, text: base.text + event.delta }, ...(event.delta ? { text: event.delta } : {}) };
  }
  return { attempt: { ...base, seq, open: false } };
}

function answerRequest(
  ctx: TurnContext,
  queue: AsyncQueue<AgentEvent>,
  onApproval: (request: Request) => Promise<ApprovalDecision>,
  request: Request,
): void {
  void (async () => {
    try {
      const decision = await onApproval(request);
      await guard(ctx.api.requests.resolve(request.id, decision));
    } catch (error) {
      queue.fail(error);
    }
  })();
}

function closedError(): JunoError {
  return new JunoError('CLOSED', 'The Juno client is closed');
}

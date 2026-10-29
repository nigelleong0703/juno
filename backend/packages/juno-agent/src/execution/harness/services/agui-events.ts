import {
  EventType,
  runSchema,
  type AgentEvent,
  type Item,
  type Request,
  type Run,
  type Step,
} from '@agent-desktop/public-contracts';
import { redactText } from './tool-projection.js';

/**
 * The one mapping from durable run/step rows to the standard AG-UI wire
 * (docs/architecture/AGUI-MIGRATION.md). Every run-scoped event carries the durable ids in
 * `metadata.juno`; the wire `threadId` is the durable conversation.
 */

const junoMetadata = (run: { id: string; agentId: string; conversationId?: string; status: string }) => ({
  juno: {
    agentId: run.agentId,
    ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
    runId: run.id,
    // The durable row stays the authority for the run status; the AG-UI outcome only describes
    // the wire segment.
    runStatus: run.status,
    run: runSchema.parse(run),
  },
});

/** Juno attribution shared by the frames of one durable run/step. */
export interface WireScope {
  runId: string;
  conversationId?: string;
  agentId: string;
}

const scopeMetadata = (scope: WireScope): { juno: Record<string, string> } => ({
  juno: {
    agentId: scope.agentId,
    ...(scope.conversationId === undefined ? {} : { conversationId: scope.conversationId }),
    runId: scope.runId,
  },
});

/** Argument keys whose value never rides the event log, whatever the tool intended. */
const SECRET_ARGUMENT_KEY = /(?:pass(?:word|phrase)?|secret|token|api[-_]?key|authorization|cookie|credential|private[-_]?key|session[-_]?key)/i;

function redactArgumentValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactArgumentValue(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 50)) {
    out[key] = SECRET_ARGUMENT_KEY.test(key) ? '[redacted]' : redactArgumentValue(entry, depth + 1);
  }
  return out;
}

const ARGUMENT_TEXT_MAX = 4000;

export interface ToolArgumentsWire {
  /** Always a complete JSON document: a consumer reconstructs the call with JSON.parse. */
  text: string;
  truncated: boolean;
  /** UTF-8 bytes of the complete redacted JSON before any structural limit. */
  originalBytes: number;
}

/**
 * The tool arguments a standard consumer receives: bounded, credential-redacted, and never the raw
 * object a tool happens to hold. Secret-looking keys are masked at every depth. An oversized call
 * keeps whole top-level entries that fit and then a valid-JSON marker; it is never cut mid-value,
 * so a standard consumer's JSON.parse always succeeds.
 */
export function toolArgumentsWire(args: Record<string, unknown>): ToolArgumentsWire {
  const redacted = redactArgumentValue(args, 0);
  const full = redactText(JSON.stringify(redacted) ?? '{}');
  const originalBytes = new TextEncoder().encode(full).length;
  if (full.length <= ARGUMENT_TEXT_MAX) return { text: full, truncated: false, originalBytes };
  const kept: Record<string, unknown> = {};
  let used = 2;
  for (const [key, value] of Object.entries(typeof redacted === 'object' && redacted !== null && !Array.isArray(redacted) ? redacted : {})) {
    const encoded = JSON.stringify(key) + ':' + JSON.stringify(value);
    if (used + encoded.length + 1 > ARGUMENT_TEXT_MAX - 160) break;
    kept[key] = value;
    used += encoded.length + 1;
  }
  const marker = {
    junoTruncated: true,
    originalBytes,
    note: 'The complete arguments exceeded the event limit; the entries kept are whole and redacted.',
  };
  const text = JSON.stringify({ ...kept, ...marker });
  return { text, truncated: true, originalBytes };
}

const threadIdOf = (run: { id: string; conversationId?: string }): string => run.conversationId ?? run.id;

/** Opens the wire run segment of a durable run. */
export function runStartedEvent(run: Run): AgentEvent {
  return { type: EventType.RUN_STARTED, threadId: threadIdOf(run), runId: run.id, metadata: junoMetadata(run) };
}

/** A durable run status patch: a Juno CUSTOM event, because AG-UI has no run-update event. */
export function runUpdatedEvent(run: Run): AgentEvent {
  return { type: EventType.CUSTOM, name: 'juno.run.updated', value: run, metadata: junoMetadata(run) };
}

/** Closes the wire run segment for one durable terminal row. */
export function runTerminalEvent(run: Run): AgentEvent {
  if (run.status === 'failed') {
    return { type: EventType.RUN_ERROR, message: run.error ?? 'run failed', metadata: junoMetadata(run) };
  }
  return {
    type: EventType.RUN_FINISHED,
    threadId: threadIdOf(run),
    runId: run.id,
    outcome: { type: run.status === 'stopped' ? 'cancelled' : 'success' },
    metadata: junoMetadata(run),
  };
}

const stepMetadata = (step: Step) => ({ juno: { runId: step.runId, stepId: step.id, step } });

const stepNameOf = (step: Pick<Step, 'title' | 'verb' | 'target'>): string => step.title ?? `${step.verb} ${step.target}`;

/** A new durable step: the standard step segment opens. */
export function stepAddedEvent(step: Step): AgentEvent {
  return { type: EventType.STEP_STARTED, stepName: stepNameOf(step), metadata: stepMetadata(step) };
}

/** A durable step update (status/summary): the standard step segment closes. */
export function stepUpdatedEvent(step: Step): AgentEvent {
  return { type: EventType.STEP_FINISHED, stepName: stepNameOf(step), metadata: stepMetadata(step) };
}

/**
 * A committed assistant item, as the standard authoritative text message: the full text arrives
 * once, under the item id, so a standard consumer rebuilds the reply without `item.added`
 * (docs/architecture/AGUI-MIGRATION.md). A rewritten streamed bubble re-announces the same id with
 * its final text; clients replace by message id.
 */
export function assistantMessageEvents(item: Extract<Item, { type: 'agent_message' }>): AgentEvent[] {
  const metadata = {
    juno: {
      agentId: item.agentId,
      conversationId: item.conversationId,
      ...(item.runId === undefined ? {} : { runId: item.runId }),
    },
  };
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId: item.id, role: 'assistant', metadata },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: item.id, delta: item.markdown, metadata },
    { type: EventType.TEXT_MESSAGE_END, messageId: item.id, metadata },
  ];
}

/**
 * The wire run segment ends waiting for a durable request. The interrupt id is the request id, so a
 * standard resume entry answers it through the same decision path as the product card.
 */
export function runInterruptedEvent(run: Run, request: Request): AgentEvent {
  return {
    type: EventType.RUN_FINISHED,
    threadId: threadIdOf(run),
    runId: run.id,
    outcome: {
      type: 'interrupt',
      interrupts: [
        {
          id: request.id,
          reason: request.kind,
          message: request.summary === '' ? request.title : request.title + ' — ' + request.summary,
          // The approval card is about one tool call; its id is the durable step the request was raised from.
          ...(request.kind === 'approval' && request.id.startsWith('req_') ? { toolCallId: request.id.slice(4) } : {}),
          metadata: {
            juno: {
              requestId: request.id,
              agentId: run.agentId,
              ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
              runId: run.id,
            },
          },
        },
      ],
    },
    metadata: junoMetadata(run),
  };
}

/** The standard tool-call segment opens when the durable step is created (stable id = step id). */
export function toolCallStartedEvents(scope: WireScope, stepId: string, toolName: string, args: ToolArgumentsWire): AgentEvent[] {
  return [
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: stepId,
      toolCallName: toolName,
      metadata: { juno: { ...scopeMetadata(scope).juno, stepId, ...(args.truncated ? { argumentsTruncated: true } : {}) } },
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: stepId,
      delta: args.text,
      metadata: { juno: { ...scopeMetadata(scope).juno, stepId, ...(args.truncated ? { argumentsTruncated: true } : {}) } },
    },
  ];
}

/** The standard tool-call segment closes with the durable step. */
export function toolCallEndedEvent(scope: WireScope, stepId: string): AgentEvent {
  return {
    type: EventType.TOOL_CALL_END,
    toolCallId: stepId,
    metadata: { juno: { ...scopeMetadata(scope).juno, stepId } },
  };
}

/** The bounded, redacted tool result as a standard tool message (its id is stable per step). */
export function toolCallResultEvent(scope: WireScope, stepId: string, content: string): AgentEvent {
  return {
    type: EventType.TOOL_CALL_RESULT,
    messageId: 'toolresult_' + stepId,
    toolCallId: stepId,
    content,
    role: 'tool',
    metadata: { juno: { ...scopeMetadata(scope).juno, stepId } },
  };
}

/** A delegated child run opens its standard subagent segment. */
export function subagentStartedEvent(run: Run, parentIsSubagent: boolean): AgentEvent {
  return {
    type: EventType.SUBAGENT_STARTED,
    subagentRunId: run.id,
    name: run.title,
    ...(parentIsSubagent && run.parentRunId !== undefined ? { parentSubagentRunId: run.parentRunId } : {}),
    metadata: {
      juno: {
        agentId: run.agentId,
        ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
        ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
      },
    },
  };
}

/** A child run reached a terminal durable status. Stopped/blocked children never report success. */
export function subagentTerminalEvent(run: Run): AgentEvent {
  const metadata = {
    juno: {
      agentId: run.agentId,
      ...(run.conversationId === undefined ? {} : { conversationId: run.conversationId }),
      ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
      runStatus: run.status,
    },
  };
  if (run.status === 'failed') {
    return { type: EventType.SUBAGENT_ERROR, subagentRunId: run.id, message: run.error ?? 'subagent failed', metadata };
  }
  if (run.status === 'stopped' || run.status === 'blocked') {
    return { type: EventType.SUBAGENT_FINISHED, subagentRunId: run.id, outcome: { type: 'suspended' }, metadata };
  }
  const result = run.childResult;
  return {
    type: EventType.SUBAGENT_FINISHED,
    subagentRunId: run.id,
    outcome: { type: 'success' },
    ...(result === undefined || result === '' ? {} : { result: result.length > 2000 ? result.slice(0, 1999) + '…' : result }),
    metadata,
  };
}

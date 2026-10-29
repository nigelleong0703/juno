/**
 * pi-agent-core message and stream adapters.
 *
 * The product Brain performs the real provider call; core only needs a well-formed
 * assistant-message envelope plus an event stream it can iterate and read `.result()`
 * from. These helpers convert one journaled AssistantTurn into that shape. Error and
 * aborted turns are rejected here because the driver resolves them before conversion
 * (terminal vs cancel), so they can never silently become a normal turn.
 */
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonObject,
  type JsonValue,
  type Model,
  type StopReason,
  type TextContent,
  type ToolCall,
  type Usage,
} from '@earendil-works/pi-ai';
import type { AssistantTurn } from '../../../../contracts/index.js';

/** Pi-ai envelope identity for the synthetic assistant message (the provider is the product Brain). */
const CORE_API = 'openai-completions';
const CORE_PROVIDER = 'openai';
const CORE_MODEL = 'pi-core-adapter';

/**
 * The provider-neutral model handle core requires. Core never calls it: the product
 * streamFn owns the provider request, so this is only a well-typed placeholder.
 */
export function coreModel(): Model<'openai-completions'> {
  return {
    api: CORE_API,
    provider: CORE_PROVIDER,
    id: CORE_MODEL,
    name: CORE_MODEL,
    baseUrl: '',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 0,
    maxTokens: 0,
  };
}

/** True for a JSON-serializable value; used to admit tool-call arguments into a JsonObject. */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') return Object.values(value).every(isJsonValue);
  return false;
}

function toJsonObject(args: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    if (!isJsonValue(value)) throw new Error('pi-core: tool argument "' + key + '" is not JSON-serializable');
    out[key] = value;
  }
  return out;
}

function usageOf(usage: AssistantTurn['usage']): Usage {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.costUsd },
  };
}

function contentOf(turn: AssistantTurn): AssistantMessage['content'] {
  const content: AssistantMessage['content'] = [];
  if (turn.text.length > 0) content.push({ type: 'text', text: turn.text });
  for (const call of turn.toolCalls) {
    const toolCall: ToolCall = { type: 'toolCall', id: call.id, name: call.name, arguments: toJsonObject(call.arguments) };
    content.push(toolCall);
  }
  return content;
}

/** The core stop reason for a turn the driver has already resolved as non-error, non-aborted. */
function coreStopReason(stopReason: AssistantTurn['stopReason']): 'stop' | 'length' | 'toolUse' {
  if (stopReason === 'tool_calls') return 'toolUse';
  if (stopReason === 'length') return 'length';
  if (stopReason === 'stop') return 'stop';
  return 'stop';
}

export function assistantMessageOf(turn: AssistantTurn): AssistantMessage {
  if (turn.stopReason === 'error' || turn.stopReason === 'aborted') {
    throw new Error('pi-core: a ' + turn.stopReason + ' turn must be resolved before message conversion');
  }
  const stopReason: StopReason = coreStopReason(turn.stopReason);
  return {
    role: 'assistant',
    content: contentOf(turn),
    api: CORE_API,
    provider: CORE_PROVIDER,
    model: CORE_MODEL,
    usage: usageOf(turn.usage),
    stopReason,
    timestamp: Date.now(),
  };
}

/** One completed assistant turn as the event stream core consumes (start, then done). */
export function turnStream(turn: AssistantTurn): AssistantMessageEventStream {
  const message = assistantMessageOf(turn);
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'done', reason: coreStopReason(turn.stopReason), message });
  return stream;
}

/** The visible text of a core assistant message (thinking and tool-call blocks excluded). */
export function textOf(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function toolCallsOf(message: AssistantMessage): ToolCall[] {
  return message.content.filter((block): block is ToolCall => block.type === 'toolCall');
}

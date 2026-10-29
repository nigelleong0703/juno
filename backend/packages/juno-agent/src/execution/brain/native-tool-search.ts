// The provider's own client-mode tool search on the OpenAI Responses wire (mode 'responses-tool-search').
//
// What the request looks like: next to the core function tools it declares `{type:'tool_search', execution:'client'}` and EVERY
// hidden tool as a function with `defer_loading: true`. The array is the same on every request of a conversation, so it stays a
// byte-stable prefix. The model searches by emitting a `tool_search_call` item; we answer with a `tool_search_output` item that
// carries the matching definitions, and it then calls the real tool by name. (Shape verified live on opencode-go for
// Muse Spark and GPT. pi-ai's own synthetic form, `additional_tools` and a function named `tool_search` are NOT used: Muse
// answers 400 to `additional_tools`, and the name `tool_search` is reserved once the native tool is declared.)
//
// pi-ai drops item types it does not know, so this module reads the call out of the stream, and the harness stores it as an
// ordinary tool call named `tool_search` (so it runs through the usual policy, journal and transcript path) marked
// `nativeSearch`. On every later request the pair (call, result) is turned back into the two native items at the same position
// in `input`, so request N stays a byte prefix of request N+1 and no old message is ever rewritten.
import { z } from 'zod';
import type { Message, Tool as PiTool, ToolCall } from '@earendil-works/pi-ai';
import { convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';

/** The name the harness gives a native search call; the same as the proxy-mode function, so the tool and its policy are shared. */
export const SEARCH_CALL_NAME = 'tool_search';

const NATIVE_SEARCH_DESCRIPTION =
  'Find tools that are not in your list yet: connected apps and many other abilities are loaded on demand to keep this prompt small. '
  + 'Call this FIRST when a tool you expect is missing (and the app is connected). Describe what you want to do; '
  + 'the matching tools are added and you then call them by their own name.';

const NATIVE_SEARCH_TOOL = {
  type: 'tool_search',
  execution: 'client',
  description: NATIVE_SEARCH_DESCRIPTION,
  parameters: {
    type: 'object',
    properties: { goal: { type: 'string', description: 'What you want to do, in words; or the exact name of the tool you are looking for.' } },
    required: ['goal'],
    additionalProperties: false,
  },
};

/** pi-ai normalizes a replayed call id this way; storing the id already normalized keeps call and output paired. */
function wireId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return (sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized).replace(/_+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a stored native search call carries beyond an ordinary tool call. */
const searchBlock = z.object({ type: z.literal('toolCall'), id: z.string(), nativeSearch: z.literal(true), itemId: z.string().optional(), arguments: z.object({ query: z.string() }).passthrough() }).passthrough();
const searchResult = z.object({ role: z.literal('toolResult'), toolCallId: z.string(), loadedTools: z.array(z.string()).optional() }).passthrough();

/** The toolCall block that stands for one `tool_search_call` item in the stored assistant message. */
export type SearchCallBlock = ToolCall & { nativeSearch: true; itemId?: string };

export function searchCallBlock(call: { callId: string; itemId?: string; goal: string }): SearchCallBlock {
  return { type: 'toolCall', id: wireId(call.callId), name: SEARCH_CALL_NAME, arguments: { query: call.goal }, nativeSearch: true, ...(call.itemId === undefined ? {} : { itemId: call.itemId }) };
}

/** A hidden tool as it goes on the wire: the protocol name (aliased) with its definition. */
export interface DeferredTool {
  /** The registry name: what a stored search result lists as loaded. */
  name: string;
  tool: PiTool;
}

export interface ToolSearchTap {
  /** `onPayload`: declares the search and the deferred tools, and turns stored search calls back into native items. */
  payload(payload: unknown): unknown;
  /** `onProviderStreamEvent`: collects the `tool_search_call` items of the reply. */
  observe(event: unknown): void;
  /** The search calls of this reply, as the toolCall blocks to store. */
  calls(): SearchCallBlock[];
}

/** A tap for one request that has hidden tools to declare (without them the stored searches stay ordinary function calls). */
export function createToolSearchTap(input: { deferred: readonly DeferredTool[]; messages: readonly Message[]; supportsStrictMode?: boolean }): ToolSearchTap {
  const options = { supportsStrictMode: input.supportsStrictMode ?? false, toolSearchResult: true };
  const byName = new Map(input.deferred.map((entry) => [entry.name, entry.tool]));
  const found: Array<{ callId: string; itemId?: string; goal: string }> = [];

  // The stored searches, by wire call id: the call (goal, item id) and what its result loaded.
  const stored = new Map<string, { goal: string; itemId: string | undefined; loaded: string[] }>();
  for (const message of input.messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        const parsed = searchBlock.safeParse(block);
        if (parsed.success) stored.set(parsed.data.id, { goal: parsed.data.arguments.query, itemId: parsed.data.itemId, loaded: [] });
      }
    } else if (message.role === 'toolResult') {
      const parsed = searchResult.safeParse(message);
      const search = parsed.success ? stored.get(parsed.data.toolCallId) : undefined;
      if (parsed.success && search !== undefined) search.loaded = parsed.data.loadedTools ?? [];
    }
  }

  const callItem = (callId: string, search: { goal: string; itemId: string | undefined }): Record<string, unknown> => ({
    type: 'tool_search_call', ...(search.itemId === undefined ? {} : { id: search.itemId }), call_id: callId, execution: 'client', status: 'completed', arguments: { goal: search.goal },
  });
  const outputItem = (callId: string, loaded: readonly string[]): Record<string, unknown> => ({
    type: 'tool_search_output', call_id: callId, execution: 'client', status: 'completed',
    tools: convertResponsesTools(loaded.flatMap((name) => byName.get(name) ?? []), options),
  });

  return {
    payload(payload) {
      if (!isRecord(payload)) return undefined;
      const tools = Array.isArray(payload['tools']) ? payload['tools'] : [];
      const items: unknown[] = Array.isArray(payload['input']) ? payload['input'] : [];
      const next: Record<string, unknown> = { ...payload, tools: [...tools, NATIVE_SEARCH_TOOL, ...convertResponsesTools(input.deferred.map((entry) => entry.tool), options)] };
      next['input'] = items.map((item) => {
        if (!isRecord(item)) return item;
        const callId = typeof item['call_id'] === 'string' ? item['call_id'] : '';
        const search = stored.get(callId);
        if (search === undefined) return item;
        if (item['type'] === 'function_call') return callItem(callId, search);
        if (item['type'] === 'function_call_output') return outputItem(callId, search.loaded);
        return item;
      });
      return next;
    },
    observe(event) {
      if (!isRecord(event) || event['type'] !== 'response.output_item.done' || !isRecord(event['item'])) return;
      const item = event['item'];
      if (item['type'] !== 'tool_search_call' || item['execution'] === 'server') return;
      const callId = typeof item['call_id'] === 'string' ? item['call_id'] : typeof item['id'] === 'string' ? item['id'] : '';
      if (callId === '' || found.some((entry) => entry.callId === callId)) return;
      found.push({ callId, ...(typeof item['id'] === 'string' ? { itemId: item['id'] } : {}), goal: goalOf(item['arguments']) });
    },
    calls: () => found.map(searchCallBlock),
  };
}

/** The goal of a search call: its arguments arrive as an object, or as a JSON string on some gateways. */
function goalOf(args: unknown): string {
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return '';
    }
  }
  return isRecord(value) && typeof value['goal'] === 'string' ? value['goal'] : '';
}

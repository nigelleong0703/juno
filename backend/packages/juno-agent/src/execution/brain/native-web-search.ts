// The model provider's own web search tool (OpenAI Responses `web_search`, Anthropic `web_search` server tool).
// When a run's model has one, the run offers it INSTEAD of Juno's web_search: the provider runs the search inside the
// model call, so nothing comes back as a tool call. This module decides who can do it, adds the tool to the request
// and reads the searches and their sources back out of the provider's stream (pi-ai ignores those items itself).
import type { WebSearchMode } from '@agent-desktop/public-contracts';
import type { NativeWebSearch, Tool } from '../../contracts/index.js';

/** Our own tool the native one replaces. */
export const JUNO_WEB_SEARCH = 'web_search';

type NativeWire = 'openai-responses' | 'anthropic-messages';

/** The wire a native search runs on, or undefined when this wire has none here. */
export function nativeWireOf(api: string): NativeWire | undefined {
  return api === 'openai-responses' || api === 'anthropic-messages' ? api : undefined;
}

/**
 * Whether the provider behind this endpoint runs web search itself. Judged by the vendor's own host: an OpenAI-compatible
 * proxy or gateway cannot be assumed to forward the tool (a gateway that does says so in its catalog, see `supports_web_search`).
 */
export function endpointHasNativeSearch(wire: string | undefined, baseUrl: string): boolean {
  if (wire === undefined) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  if (wire === 'openai-responses') return host === 'api.openai.com';
  if (wire === 'anthropic-messages') return host === 'api.anthropic.com';
  return false;
}

/** Chosen once when a run starts and frozen on its snapshot: auto uses the provider's search when the model has one. */
export function useNativeWebSearch(mode: WebSearchMode | undefined, capable: boolean): boolean {
  return capable && mode !== 'juno';
}

/** The run's tools with Juno's web_search taken out when the provider's own is offered (never both: the model would have to choose). */
export function withoutJunoSearch(tools: Tool[], native: boolean): Tool[] {
  return native ? tools.filter((tool) => tool.name !== JUNO_WEB_SEARCH) : tools;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Anthropic's server tool; the dated name is the long-stable version that needs no code-execution tool. */
const ANTHROPIC_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 };
const OPENAI_SEARCH_TOOL = { type: 'web_search' };

/** The request with the provider's search tool added, or undefined to keep it as it is. */
function withSearchTool(wire: NativeWire, payload: unknown): unknown {
  if (!isRecord(payload)) return undefined;
  const tools = Array.isArray(payload['tools']) ? payload['tools'] : [];
  if (wire === 'anthropic-messages') return { ...payload, tools: [...tools, ANTHROPIC_SEARCH_TOOL] };
  // The sources of each search are only sent back when asked for.
  const include = Array.isArray(payload['include']) ? payload['include'] : [];
  return { ...payload, tools: [...tools, OPENAI_SEARCH_TOOL], include: [...new Set([...include, 'web_search_call.action.sources'])] };
}

export interface NativeSearchTap {
  /** `onPayload`: adds the search tool to the request. */
  payload(payload: unknown): unknown;
  /** `onProviderStreamEvent`: reads searches, sources and citations out of the stream. */
  observe(event: unknown): void;
  /** The searches of this call, with the pages the reply cites attached to the last one. */
  searches(): NativeWebSearch[];
}

/** A tap for one model call on the given wire. */
export function createNativeSearchTap(wire: NativeWire): NativeSearchTap {
  const searches: NativeWebSearch[] = [];
  const cited = new Map<string, string>();
  // Anthropic: the query of a server tool call is streamed as json; its result arrives as a later block.
  const anthropicCalls = new Map<number, { id: string; json: string }>();
  const anthropicQueries = new Map<string, string>();

  const cite = (url: string | undefined, title: string | undefined): void => {
    if (url !== undefined && (!cited.has(url) || cited.get(url) === hostOf(url))) cited.set(url, title ?? hostOf(url));
  };

  const openaiItem = (item: Record<string, unknown>): void => {
    if (item['type'] === 'web_search_call') {
      const action = item['action'];
      if (!isRecord(action)) return;
      const queries = Array.isArray(action['queries']) ? action['queries'].filter((entry): entry is string => typeof entry === 'string') : [];
      const query = text(action['query']) ?? queries[0];
      if (action['type'] !== 'search' || query === undefined) return;
      const sources = (Array.isArray(action['sources']) ? action['sources'] : []).flatMap((source) => {
        const url = isRecord(source) ? text(source['url']) : undefined;
        return url === undefined ? [] : [{ title: hostOf(url), url }];
      });
      searches.push({ query, sources });
    } else if (item['type'] === 'message' && Array.isArray(item['content'])) {
      for (const part of item['content']) {
        if (!isRecord(part) || !Array.isArray(part['annotations'])) continue;
        for (const note of part['annotations']) {
          if (isRecord(note) && note['type'] === 'url_citation') cite(text(note['url']), text(note['title']));
        }
      }
    }
  };

  const anthropicEvent = (event: Record<string, unknown>): void => {
    const index = typeof event['index'] === 'number' ? event['index'] : -1;
    const block = event['content_block'];
    const delta = event['delta'];
    if (event['type'] === 'content_block_start' && isRecord(block)) {
      if (block['type'] === 'server_tool_use' && block['name'] === 'web_search') {
        anthropicCalls.set(index, { id: text(block['id']) ?? '', json: '' });
      } else if (block['type'] === 'web_search_tool_result') {
        const query = anthropicQueries.get(text(block['tool_use_id']) ?? '') ?? '';
        const results = Array.isArray(block['content']) ? block['content'] : [];
        const sources = results.flatMap((entry) => {
          const url = isRecord(entry) ? text(entry['url']) : undefined;
          return url === undefined || !isRecord(entry) ? [] : [{ title: text(entry['title']) ?? hostOf(url), url }];
        });
        if (query !== '') searches.push({ query, sources });
      }
    } else if (event['type'] === 'content_block_delta' && isRecord(delta)) {
      const call = anthropicCalls.get(index);
      if (delta['type'] === 'input_json_delta' && call !== undefined) call.json += text(delta['partial_json']) ?? '';
      else if (delta['type'] === 'citations_delta' && isRecord(delta['citation'])) cite(text(delta['citation']['url']), text(delta['citation']['title']));
    } else if (event['type'] === 'content_block_stop') {
      const call = anthropicCalls.get(index);
      if (call === undefined) return;
      anthropicCalls.delete(index);
      try {
        const input: unknown = JSON.parse(call.json);
        const query = isRecord(input) ? text(input['query']) : undefined;
        if (query !== undefined) anthropicQueries.set(call.id, query);
      } catch {
        // A query that never parsed leaves its result unnamed, and an unnamed search is not recorded.
      }
    }
  };

  return {
    payload: (payload) => withSearchTool(wire, payload),
    observe(event) {
      if (!isRecord(event)) return;
      if (wire === 'anthropic-messages') {
        anthropicEvent(event);
      } else if (event['type'] === 'response.output_item.done' && isRecord(event['item'])) {
        openaiItem(event['item']);
      }
    },
    searches() {
      if (searches.length === 0) return [];
      // Annotations name the pages the reply cites (with titles); they belong to the call, not to one search.
      const known = new Set(searches.flatMap((search) => search.sources.map((source) => source.url)));
      const extra = [...cited].filter(([url]) => !known.has(url)).map(([url, title]) => ({ title, url }));
      const named = searches.map((search) => ({ ...search, sources: search.sources.map((source) => ({ ...source, title: cited.get(source.url) ?? source.title })) }));
      const tail = named[named.length - 1];
      if (tail !== undefined && extra.length > 0) tail.sources = [...tail.sources, ...extra];
      return named;
    },
  };
}

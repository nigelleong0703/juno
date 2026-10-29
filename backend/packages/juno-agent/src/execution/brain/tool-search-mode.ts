// How a model reaches the tools that are not in its short list. One resolver decides, once per run, and the
// answer is frozen on the model snapshot (like `nativeWebSearch`), so a conversation's tools array never changes shape.
//
//  - 'responses-tool-search': the provider's own client-mode tool search (OpenAI Responses). Every hidden tool is declared with
//    `defer_loading: true` next to a native `tool_search` tool; the model searches, we answer with the matching definitions and
//    it then calls the real tool by name (provider.ts / native-tool-search.ts).
//  - 'proxy': `tool_search` is an ordinary function and a hidden tool runs through the `tool_call {name, arguments}` function,
//    which the provider unwraps into the real call (tool-proxy.ts). Works on every wire.
//
// Anthropic's inline tool additions need a transcript row of added tools that nothing here writes, so Anthropic stays on proxy.

import type { ToolSearchMode } from '../../contracts/index.js';
export type { ToolSearchMode };

/**
 * Models verified live (client-mode tool search on the opencode-go gateway), keyed `provider/model`. Their catalog entries do not
 * say `supportsToolSearch`, so they are listed here; the same key is matched when the id is configured as "provider/model".
 */
const VERIFIED: ReadonlySet<string> = new Set([
  'opencode-go/muse-spark-1.3-contributor',
  'opencode-go/gpt-5.6-luna',
]);

/** The model fields the resolver reads: a pi-ai model, or the pieces of one a snapshot is made from. */
export interface ToolSearchModel {
  api: string;
  provider: string;
  id: string;
  /** The catalog's wire compat flags; only `supportsToolSearch` is read. */
  compat?: object | undefined;
}

export function resolveToolSearchMode(model: ToolSearchModel): ToolSearchMode {
  if (model.api !== 'openai-responses') return 'proxy';
  if (model.compat !== undefined && 'supportsToolSearch' in model.compat && model.compat.supportsToolSearch === true) return 'responses-tool-search';
  const key = model.id.includes('/') ? model.id : model.provider + '/' + model.id;
  return VERIFIED.has(key) ? 'responses-tool-search' : 'proxy';
}

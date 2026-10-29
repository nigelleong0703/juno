import { GOAL_BROWSER_NAMES } from './browserGoals.js';
import { COMPUTER_BATCH_TOOL } from '../computer/batch.js';
/**
 * Compact disclosure: the model sees a small fixed core plus a bounded namespace
 * directory. `tool_search` finds the rest by what the model wants to do (optionally inside one
 * namespace), `tool_load` fetches the complete schemas of tools it already knows by exact name, and
 * `tool_call` runs the chosen canonical name. Deferred tools stay reachable, so a
 * model only carries the definitions it will actually call: the core, a few
 * preselected preparation definitions, and the best matches' complete schemas.
 *
 * The two finders are separate tools so that each has one required argument and no "supply one of"
 * rule that only prose states: `tool_search {query}` (an empty query answers with the directory of
 * what is hidden, never an error) and `tool_load {names}`.
 *
 * `tool_call` never executes anything itself: where the model's reply is received, a `tool_call` is unwrapped
 * into the tool it names (brain/tool-proxy.ts), which then runs through the same policy, approval and audit
 * path as a direct call. A tool that reaches this `execute` was a malformed call, so it fails closed.
 * On a model with native deferred tool loading (ctx.toolSearch === 'responses-tool-search') the search answers
 * with the names it loaded and the provider sends their definitions back to the model (brain/native-tool-search.ts);
 * the model then calls them by their own name; `tool_load` and `tool_call` are not offered.
 *
 * Ranking is the shared bounded semantic ranker (tools/candidateRanking.ts): the deterministic
 * lexical order is the baseline, and one batched System One decision reorders the bounded
 * shortlist — zero-hit candidates included, so cross-language discovery works. A search never
 * executes a candidate; it only returns names, bounded descriptions and the best match's schema.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { createToolNameAliases } from '../../../execution/brain/toolNames.js';
import { invalidArguments } from '../toolArguments.js';
import { scopeQuietExit } from './finishQuietly.js';
import { lexicalHits, rankCandidates } from './candidateRanking.js';
import type { ToolScope } from '../scope.js';
import { toolTurn } from './mcpTools.js';
import { CORE_TOOL_NAMES, disclosureMode, groupNamespaces, isCompactVisible, matchNamespace, renderNamespaceDirectory } from './namespaceDirectory.js';
import { discoveryScopeKey, fingerprintCandidates, readDiscoveryMemo, toolIdentityFingerprint, writeDiscoveryMemo } from './discoveryMemo.js';
import { EXACT_NAMES_CAP, MAX_BEST_DESCRIPTION_CHARS, MAX_SUMMARY_DESCRIPTION_CHARS, findExactTool, formatListEntry, formatSearchEntry, normalizeExactNames, orderByHint, pickSchemaSet, wakeHintText } from './toolSearchResults.js';

export const TOOL_SEARCH = 'tool_search';
export const TOOL_LOAD = 'tool_load';
export const TOOL_CALL = 'tool_call';

/** The three discovery tools: they find and run other tools, so they never appear in each other's results. */
const DISCOVERY_NAMES: readonly string[] = [TOOL_SEARCH, TOOL_LOAD, TOOL_CALL];
export const isDiscoveryTool = (name: string): boolean => DISCOVERY_NAMES.includes(name);

/** How many matches one search returns: enough to choose, few enough to stay cheap. */
const MAX_MATCHES = 6;
/** How many tools a namespace-only listing shows: bounded names and descriptions. */
const NAMESPACE_LIST_CAP = 8;

// `query` is required; an empty (or blank) one is the "show me what is hidden" request, not an error.
const searchSchema = z.object({
  query: z.string().trim().max(200),
  namespace: z.string().trim().min(1).max(80).optional(),
}).strict();

const loadSchema = z.object({
  names: z.array(z.string().trim().min(1).max(120)).min(1).max(EXACT_NAMES_CAP),
}).strict();

const callSchema = z.object({
  name: z.string().trim().min(1).max(120),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).strict();

// Search results carry whole schemas, never truncated mid-JSON: MCP raw schemas are
// bounded at 8k upstream and injected approval text rides along. Oversized tool
// output is bounded downstream by the harness output capture, not here, so an
// exact-named tool always returns the complete schema the proxy call needs.
// Bundle rendering (whole-schema selection, deterministic hint ordering) lives in
// ./toolSearchResults.ts so query and namespace paths share one bounded rule.
export { MAX_BEST_DESCRIPTION_CHARS };

export interface ToolSearchSource {
  /** Every tool the agent could use in this scope, hidden ones included. */
  all(agentId: string, signal?: AbortSignal, scope?: ToolScope, turn?: string): Promise<Tool[]>;
  /** The names the model can already see in this scope, so a search answers with what is new. */
  visible(agentId: string, signal?: AbortSignal, scope?: ToolScope, turn?: string): Promise<Set<string>>;
}

const RUN_WITH_TOOL_CALL = 'Run one with tool_call after choosing the exact canonical name; approval still applies as usual.';

export function createToolSearchTool(source: ToolSearchSource): Tool {
  const tool: Tool = {
    name: TOOL_SEARCH,
    description: '',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '' },
        namespace: { type: 'string', description: '' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = searchSchema.safeParse(args ?? {});
      if (!parsed.success) return invalidArguments(tool.name, args, parsed.error);
      const { query, namespace } = parsed.data;
      const { all, visible } = await scopeQuietExit(ctx, ...(await Promise.all([source.all(ctx.agentId, ctx.signal, ctx.toolScope, toolTurn(ctx)), source.visible(ctx.agentId, ctx.signal, ctx.toolScope, toolTurn(ctx))])));
      const pool = all.filter((entry) => !isDiscoveryTool(entry.name));
      const groups = groupNamespaces(all);
      const native = ctx.toolSearch === 'responses-tool-search';
      let scoped = pool;
      if (namespace !== undefined) {
        const matched = matchNamespace(groups, namespace);
        if (matched.length === 0) {
          const avail = groups.map((group) => group.namespace).slice(0, 20).join(', ');
          return { content: [{ type: 'text', text: 'No namespace matches ' + JSON.stringify(namespace) + '. Available namespaces: ' + (avail === '' ? 'none' : avail) + '. Use the discovery directory or a query instead; nothing is guessed.' }], details: { ranking: 'namespace-list', reason: 'unknown-namespace', semantic: false, examined: 0, omitted: 0, namespace } };
        }
        const wanted = new Set<string>();
        for (const group of matched) for (const entry of group.tools) wanted.add(entry.name);
        scoped = pool.filter((entry) => wanted.has(entry.name));
      }
      // Exact canonical query: params come back directly with no relevance decision and no System One call.
      if (query !== '') {
        const direct = findExactTool(scoped, query);
        if (direct !== undefined && native) return nativeAnswer([direct], visible, { ranking: 'exact-query', reason: 'exact-query', semantic: false, examined: 1, omitted: 0, namespace: namespace === undefined ? null : namespace });
        if (direct !== undefined) {
          const withSchema = pickSchemaSet([direct]).has(direct.name);
          const lines = ['Exact tool ' + direct.name + ':', formatSearchEntry(direct, !visible.has(direct.name), withSchema, true), 'Run one with tool_call: { "name": "<tool>", "arguments": { … } }.'];
          return { content: [{ type: 'text', text: lines.join('\n') }], details: { ranking: 'exact-query', reason: 'exact-query', semantic: false, examined: 1, omitted: 0, namespace: namespace === undefined ? null : namespace } };
        }
      }
      if (query === '' && namespace === undefined) {
        // An empty query is a request to browse: answer with the directory of what is hidden, not an error.
        const directory = renderNamespaceDirectory(groups, native ? createToolNameAliases(all.map((entry) => entry.name)).toProtocol : undefined);
        return { content: [{ type: 'text', text: 'Your query was empty, so nothing was searched. ' + directory + '\nSearch again with query set to what you want to do.' }], details: { ranking: 'overview', reason: 'empty-query', semantic: false, examined: 0, omitted: 0, namespace: null } };
      }
      if (query === '') {
        // Namespace with an empty query: order by the wake payload text before listing, so the current
        // task picks useful tools beyond the first-page fillers. No System One call.
        const ordered = orderByHint(scoped, visible, wakeHintText(ctx));
        const listed = ordered.slice(0, NAMESPACE_LIST_CAP);
        const omitted = ordered.length - listed.length;
        const lines: string[] = ['Tools in ' + (namespace === undefined ? 'scope' : namespace) + ' (' + String(scoped.length) + (scoped.length === 1 ? ' tool' : ' tools') + '):'];
        // One shared bounded selection per listing: computed once, not once per line.
        const schemaSet = pickSchemaSet(listed);
        for (const entry of listed) {
          const withSchema = schemaSet.has(entry.name);
          lines.push(formatListEntry(entry, withSchema, withSchema ? MAX_BEST_DESCRIPTION_CHARS : MAX_SUMMARY_DESCRIPTION_CHARS));
        }
        if (omitted > 0) lines.push('- ' + String(omitted) + ' more tools in this scope; narrow with a query naming the exact tool.');
        lines.push(RUN_WITH_TOOL_CALL);
        return { content: [{ type: 'text', text: lines.join('\n') }], details: { ranking: 'namespace-list', reason: 'namespace-hint', semantic: false, examined: listed.length, omitted, namespace: namespace === undefined ? null : namespace } };
      }
      const candidates = scoped.map((entry) => ({ name: entry.name, description: entry.description, hidden: !visible.has(entry.name) }));
      const fingerprint = fingerprintCandidates(scoped.map((entry) => ({ name: entry.name, description: entry.description, hidden: !visible.has(entry.name), identity: toolIdentityFingerprint(entry) })));
      const memoKey = discoveryScopeKey({ ownerId: ctx.ownerId, agentId: ctx.agentId, runId: ctx.runId, scope: 'tools', fingerprint, query });
      let outcome = memoKey === undefined ? undefined : readDiscoveryMemo(memoKey);
      if (outcome === undefined) {
        outcome = await rankCandidates({ query, candidates, ctx, kind: 'tool' });
        if (memoKey !== undefined) writeDiscoveryMemo(memoKey, outcome);
      }
      const ordered: Tool[] = [];
      for (const candidateIndex of outcome.order) {
        const entry = scoped[candidateIndex];
        if (entry !== undefined) ordered.push(entry);
      }
      const details = { ranking: outcome.semantic ? 'system-one' : 'lexical', reason: outcome.reason, semantic: outcome.semantic, examined: outcome.order.length, omitted: outcome.omitted, namespace: namespace === undefined ? null : namespace };
      // The lexical baseline keeps the old matches: only tools with a word hit are shown. A valid
      // semantic decision instead shows its best-first shortlist, zero-hit candidates included.
      const shown = (outcome.semantic ? ordered : ordered.filter((entry) => lexicalHits(query, entry.name, entry.description) > 0)).slice(0, MAX_MATCHES);
      if (shown.length === 0) {
        // No reliable relevant winner is weaker than a proof that no tool fits; a bounded
        // search and uncertain answers must not imply that the whole catalog was ruled out.
        const caveat = outcome.reason === 'no-relevant-winner'
          ? ' Semantic ranking found no confident relevant match among the examined candidates.'
          : ' Semantic ranking was unavailable (' + outcome.reason + '), so tools described in other words may still fit — phrase the query differently or tell the user what is missing.';
        return { content: [{ type: 'text', text: 'No confident match found for ' + JSON.stringify(query) + ' in this bounded search.' + caveat + ' Do it with the tools you already have, or tell the user what is missing.' }], details };
      }
      if (native) return nativeAnswer(shown, visible, details);
      // Bundled whole schemas (first best never cut) so find-then-refetch loops collapse into one search.
      // On a semantic decision only the promoted relevant prefix earns extra schemas; confident
      // irrelevant rest stays metadata. The lexical fallback keeps its top matches.
      const schemaCandidates = outcome.semantic ? shown.slice(0, Math.max(1, outcome.relevantCount ?? 0)) : shown;
      const schemaSet = pickSchemaSet(schemaCandidates);
      const lines = shown.map((entry, index) => formatSearchEntry(entry, !visible.has(entry.name), schemaSet.has(entry.name), index === 0));
      if (outcome.omitted > 0) {
        lines.push('- ' + String(outcome.omitted) + ' more tools were outside this bounded search; narrow the query if none fits.');
      }
      lines.push('Run one with tool_call: { "name": "<tool>", "arguments": { … } }.');
      return { content: [{ type: 'text', text: lines.join('\n') }], details };
    },
  };
  return tool;
}

/** `tool_load`: the complete schemas of tools the model already knows by exact name; deterministic, no ranking, nothing executes. */
export function createToolLoadTool(source: ToolSearchSource): Tool {
  const tool: Tool = {
    name: TOOL_LOAD,
    description: '',
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: EXACT_NAMES_CAP, description: '' },
      },
      required: ['names'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = loadSchema.safeParse(args ?? {});
      if (!parsed.success) return invalidArguments(tool.name, args, parsed.error);
      const { all, visible } = await scopeQuietExit(ctx, ...(await Promise.all([source.all(ctx.agentId, ctx.signal, ctx.toolScope, toolTurn(ctx)), source.visible(ctx.agentId, ctx.signal, ctx.toolScope, toolTurn(ctx))])));
      const pool = all.filter((entry) => !isDiscoveryTool(entry.name));
      // Exact canonical names: deterministic whole-schema fetch with no ranking and no System One call.
      // Unknown names are reported honestly; nothing executes here and nothing is guessed.
      const wanted = normalizeExactNames(parsed.data.names);
      const found: Tool[] = [];
      const missing: string[] = [];
      for (const name of wanted) {
        const entry = findExactTool(pool, name);
        if (entry === undefined) missing.push(name);
        else found.push(entry);
      }
      const notFound = (name: string): string => '- ' + name + ' — not found; not executed. Check the spelling or use tool_search with a query instead.';
      if (found.length === 0) {
        const lines: string[] = ['Exact tools (0 of ' + String(wanted.length) + ' found):', ...missing.map(notFound), RUN_WITH_TOOL_CALL];
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: true, details: { ranking: 'exact-names', reason: 'unknown-names', semantic: false, examined: 0, omitted: missing.length, namespace: null } };
      }
      const lines: string[] = ['Exact tools (' + String(found.length) + ' of ' + String(wanted.length) + ' found):'];
      // Bounded whole definitions: every requested tool that fits the shared budget carries
      // its complete schema (first never cut); the rest are reported honestly, not silently dropped.
      const schemaSet = pickSchemaSet(found, found.length);
      for (const entry of found) {
        const withSchema = schemaSet.has(entry.name);
        lines.push(formatSearchEntry(entry, !visible.has(entry.name), withSchema, found.indexOf(entry) === 0));
        if (!withSchema) lines.push('- ' + entry.name + ' — schema omitted: whole definition exceeds this bounded reply; request it alone to fetch it.');
      }
      lines.push(...missing.map(notFound), RUN_WITH_TOOL_CALL);
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { ranking: 'exact-names', reason: 'exact-names', semantic: false, examined: found.length, omitted: missing.length + (found.length - schemaSet.size), namespace: null } };
    },
  };
  return tool;
}

/**
 * The answer of a native search. The model is not shown this text: it receives the loaded tools' definitions from the provider
 * (the names in `details.loadedTools`), so the text is for the run's step view and for compaction. A match the model already
 * has in its list is not loaded again.
 */
function nativeAnswer(matches: readonly Tool[], visible: ReadonlySet<string>, details: Record<string, unknown>): ToolResult {
  const loaded = matches.filter((tool) => !visible.has(tool.name)).map((tool) => tool.name);
  const had = matches.filter((tool) => visible.has(tool.name)).map((tool) => tool.name);
  const lines = [
    ...(loaded.length === 0 ? [] : ['Loaded ' + String(loaded.length) + (loaded.length === 1 ? ' tool' : ' tools') + ': ' + loaded.join(', ') + '. Call them directly by name.']),
    ...(had.length === 0 ? [] : ['Already in your list: ' + had.join(', ') + '.']),
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }], details: { ...details, loadedTools: loaded } };
}

export function createToolCallTool(): Tool {
  return {
    name: TOOL_CALL,
    description: '',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '' },
        arguments: { type: 'object', description: '' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    replay: 'never',
    sideEffect: true,
    async execute(): Promise<ToolResult> {
      // The harness resolves and authorizes the inner call before reaching a tool (run-tools.ts).
      // Reaching this body means it was called outside that path, which must not execute anything.
      return { content: [{ type: 'text', text: 'tool_call must go through the run: name the tool directly instead.' }], isError: true };
    },
  };
}

/** The validation schema the harness uses when it resolves a proxy call. */
export function parseToolCall(args: Record<string, unknown>): { name: string; arguments: Record<string, unknown> } | null {
  const parsed = callSchema.safeParse(args);
  if (!parsed.success) return null;
  return { name: parsed.data.name, arguments: parsed.data.arguments ?? {} };
}

/** Connected-app tools kept visible before the rest move behind tool_search. */
export const MCP_VISIBLE_BUDGET = 24;

// What the model is shown. Default (and on) is the compact core: 8 fixed tools,
// every other production builtin deferred via deferLoading and every MCP tool
// deferred by default, all reachable through tool_search, tool_load and tool_call. Custom
// stubs without a marker stay visible. legacy reproduces the old full-builtins
// plus first-24-MCP cap for A/B; off shows every tool directly with no proxies.
// forAgent and get keep the full list, so a hidden tool still faces policy,
// approval, and the proxy path.
export function presentForModel(tools: readonly Tool[], env: Record<string, string | undefined> = process.env, options: ModelToolOptions = {}): Tool[] {
  return splitForModel(tools, env, options).shown;
}

export interface ModelToolOptions {
  /** The chat takes reactions (and the react tool would accept it): `react` is then one of the core tools. */
  reactions?: boolean;
  /** The run nobody is waiting on (`offersQuietExit`): `finish_quietly` is then shown with the core tools. It is filtered out of every other run before this (`discoverTools`). */
  quietExit?: boolean;
}

/**
 * The tools a run hands to the model call, in one list: the shown ones first, then the hidden ones marked `deferLoading`.
 * The provider declares the shown tools as functions and, on a model with native deferred loading, the hidden ones behind
 * its tool search; the harness validates and runs a call against the whole list, so a hidden tool is called by its own name.
 */
export function toolsForModel(tools: readonly Tool[], env: Record<string, string | undefined> = process.env, options: ModelToolOptions = {}): Tool[] {
  const { shown, hidden } = splitForModel(tools, env, options);
  return [...shown, ...hidden.map((tool) => ({ ...tool, deferLoading: true }))];
}

function splitForModel(tools: readonly Tool[], env: Record<string, string | undefined>, options: ModelToolOptions): { shown: Tool[]; hidden: Tool[] } {
  const mode = disclosureMode(env);
  if (mode === 'off') return { shown: tools.filter((tool) => !isDiscoveryTool(tool.name)), hidden: [] };
  if (mode === 'legacy') {
    const mcp = tools.filter((tool) => tool.mcp === true);
    if (mcp.length <= MCP_VISIBLE_BUDGET) return { shown: tools.filter((tool) => !isDiscoveryTool(tool.name)), hidden: [] };
    const within = new Set(mcp.slice(0, MCP_VISIBLE_BUDGET).map((tool) => tool.name));
    return { shown: tools.filter((tool) => tool.mcp !== true || within.has(tool.name)), hidden: [] };
  }
  const goalMode = env['BROWSER_INTERFACE'] === 'goal' || (env['BROWSER_INTERFACE'] !== 'direct' && tools.some(tool => tool.name === 'browser.do' && tool.deferLoading === false));
  // The batch is made of the per-action browser tools: goal mode hides those, so it hides the batch too.
  tools = tools.filter(tool => goalMode ? (tool.name !== COMPUTER_BATCH_TOOL && (!tool.name.startsWith('browser.') || GOAL_BROWSER_NAMES.some(name => name === tool.name))) : !GOAL_BROWSER_NAMES.some(name => name === tool.name));
  if (goalMode) tools = tools.map(tool => GOAL_BROWSER_NAMES.some(name => name === tool.name) ? { ...tool, deferLoading: false } : tool);
  if (options.reactions === true) tools = tools.map(tool => tool.name === 'react' ? { ...tool, deferLoading: false } : tool);
  if (options.quietExit === true) tools = tools.map(tool => tool.unattendedOnly === true ? { ...tool, deferLoading: false } : tool);
  // Fixed harness schemas precede discovered tools, independent of registry refresh order.
  const fixed = [...CORE_TOOL_NAMES, ...GOAL_BROWSER_NAMES];
  const rank = new Map(fixed.map((name, index) => [name, index]));
  return {
    shown: tools.filter((tool) => isCompactVisible(tool)).sort((left, right) =>
      (rank.get(left.name) ?? fixed.length) - (rank.get(right.name) ?? fixed.length)),
    hidden: tools.filter((tool) => !isCompactVisible(tool)),
  };
}

import type { Tool, ToolContext } from '../../../contracts/index.js';
import { lexicalOrder } from './candidateRanking.js';

/** How many complete schemas one bundle carries: enough to stop find-then-refetch, few enough to stay cheap. */
export const BUNDLE_SCHEMAS = 3;
/** Whole-definition budget for bundled schemas: whole JSON only, never cut mid-JSON. First best is always included. */
export const BUNDLE_SCHEMA_CHAR_BUDGET = 20000;
/** Exact names lookup bound: how many canonical names one call fetches. */
export const EXACT_NAMES_CAP = 10;
/** Wake hint bound for namespace-only lexical ordering. */
export const MAX_HINT_CHARS = 2000;
/** Best-match description cap: fits an MCP description (1000) plus separate guidance (500 + label) and any plugin/internal text. */
export const MAX_BEST_DESCRIPTION_CHARS = 2000;
/** Summary description cap for the rest of a bundle. */
export const MAX_SUMMARY_DESCRIPTION_CHARS = 200;

/** One line per parameter: the model sees what to pass before it spends a call on the schema. */
export function parameterHint(parameters: Tool['parameters']): string {
  const properties = parameters['properties'];
  if (typeof properties !== 'object' || properties === null) return '';
  const required = new Set(Array.isArray(parameters['required']) ? parameters['required'].filter((name): name is string => typeof name === 'string') : []);
  const names = Object.keys(properties);
  if (names.length === 0) return '';
  return names.slice(0, 12).map((name) => (required.has(name) ? name : name + '?')).join(', ');
}

/** The app a connected tool belongs to, so a match reads as "Notes \u00b7 search_notes" rather than a prefixed name. */
export function appOf(tool: Tool): string | undefined {
  const name = tool.origin?.connectionName;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/** Deterministic lexical hint from the current wake payload text; empty when absent. */
export function wakeHintText(ctx: ToolContext): string {
  const raw = ctx.wake.payload['text'];
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MAX_HINT_CHARS);
}

/** Exact canonical lookup by full tool name; no ranking, no guessing. */
export function findExactTool(tools: readonly Tool[], name: string): Tool | undefined {
  const want = name.trim();
  if (want === '') return undefined;
  for (const tool of tools) {
    if (tool.name === want) return tool;
  }
  return undefined;
}

/** Deduplicated exact names in request order, bounded by EXACT_NAMES_CAP. */
export function normalizeExactNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of names) {
    const want = entry.trim();
    if (want === '' || seen.has(want)) continue;
    seen.add(want);
    out.push(want);
    if (out.length >= EXACT_NAMES_CAP) break;
  }
  return out;
}

/** Deterministic lexical order for namespace-only listing; no System One call. */
export function orderByHint(tools: readonly Tool[], visible: ReadonlySet<string>, hint: string): Tool[] {
  const trimmed = hint.trim();
  if (trimmed === '') return [...tools];
  const order = lexicalOrder(
    trimmed,
    tools.map((tool) => ({ name: tool.name, description: tool.description, hidden: !visible.has(tool.name) })),
  );
  const ordered: Tool[] = [];
  for (const index of order) {
    const tool = tools[index];
    if (tool !== undefined) ordered.push(tool);
  }
  return ordered;
}

/** Whole schemas to bundle: first always included, rest only when the whole fits the budget, up to max (default BUNDLE_SCHEMAS). */
export function pickSchemaSet(ordered: readonly Tool[], max: number = BUNDLE_SCHEMAS): Set<string> {
  const picked = new Set<string>();
  let total = 0;
  for (const tool of ordered) {
    if (picked.size >= max) break;
    const length = JSON.stringify(tool.parameters).length;
    if (picked.size === 0) {
      picked.add(tool.name);
      total += length;
      continue;
    }
    if (total + length > BUNDLE_SCHEMA_CHAR_BUDGET) continue;
    picked.add(tool.name);
    total += length;
  }
  return picked;
}

/** Namespace list entry: bounded description plus the whole schema when selected. */
export function formatListEntry(tool: Tool, withSchema: boolean, descriptionCap: number): string {
  const app = appOf(tool);
  const hint = parameterHint(tool.parameters);
  const head = '- ' + tool.name + (app === undefined ? '' : ' (app: ' + app + ')') + (hint === '' ? '' : ' \u2014 arguments: ' + hint);
  const body = head + ' \u2014 ' + tool.description.slice(0, descriptionCap);
  if (!withSchema) return body;
  return body + '\n  tool_call target (copy name exactly): ' + JSON.stringify({ name: tool.name }) + '\n  schema: ' + JSON.stringify(tool.parameters);
}

/** Query match entry: hidden marker, bounded description, whole schema when selected. */
export function formatSearchEntry(tool: Tool, hidden: boolean, withSchema: boolean, isBest: boolean): string {
  const app = appOf(tool);
  const hint = parameterHint(tool.parameters);
  const head = '- ' + tool.name
    + (app === undefined ? '' : ' (app: ' + app + ')')
    + (hidden ? ' [hidden until now]' : '')
    + (hint === '' ? '' : ' \u2014 arguments: ' + hint);
  const cap = isBest ? 2000 : 200;
  const body = head + ' \u2014 ' + tool.description.slice(0, cap);
  if (!withSchema) return body;
  return body + '\n  tool_call target (copy name exactly): ' + JSON.stringify({ name: tool.name }) + '\n  schema: ' + JSON.stringify(tool.parameters);
}

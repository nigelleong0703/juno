// Adapter that exposes discovered MCP tools to the agent registry. A tool is named for people and for the model:
// `<connector>_<tool>` (`youtube_search`, `gmail_search_threads`), inside OpenAI's function-name charset and 64
// characters. Server annotations are metadata, not authority: every MCP tool is mutating and non-replayable, the
// binding is validated against the calling ctx (owner + agent), and the call is re-resolved through the manager
// on a fresh owner-scoped store so a cached tool never runs with the privileges it was built under.
import { createHash } from 'node:crypto';
import type { Tool, ToolContext, ToolResult } from '../../contracts/index.js';
import type { McpManager } from './manager.js';
import type { McpTool } from './protocol.js';
import type { ToolAccess } from './tool-access.js';
import { AppAccessError } from './access-error.js';

function sanitize(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned === '' ? 'unnamed' : cleaned;
}

/** Model-facing names must fit OpenAI's 64-char function name (`^[a-zA-Z0-9_-]{1,64}$`). */
const MAX_NAME_CHARS = 64;
const MAX_ACCOUNT_SLUG_CHARS = 16;
const MAX_DESCRIPTION_CHARS = 1000;
/** Server usage guidance from initialize.instructions: bounded on its own so a long tool text never swallows it. */
export const MAX_SERVER_INSTRUCTIONS_CHARS = 500;
const MAX_SCHEMA_BYTES = 8_000;

function hash(value: string, length: number): string {
  return createHash('sha1').update(value).digest('hex').slice(0, length);
}

/** What names a connection: its catalog entry, or (a custom URL) its own name; the account tells two of one connector apart. */
export interface McpNameSubject {
  id: string;
  name: string;
  catalogId?: string;
  account?: string;
}

function baseSlug(subject: McpNameSubject): string {
  return sanitize(subject.catalogId ?? subject.name);
}

/**
 * The tool-name prefix of each connection of one agent. The connector slug alone, unless the same agent has two
 * connections of one connector: then each adds its account label (and, if those still collide, a short hash of
 * the connection id). A prefix depends only on the connections of the same connector, never on unrelated ones.
 */
export function mcpConnectionPrefixes(subjects: readonly McpNameSubject[]): Map<string, string> {
  const groups = new Map<string, McpNameSubject[]>();
  for (const subject of subjects) groups.set(baseSlug(subject), [...(groups.get(baseSlug(subject)) ?? []), subject]);
  const prefixes = new Map<string, string>();
  for (const [slug, group] of groups) {
    if (group.length === 1) {
      prefixes.set(group[0]!.id, slug);
      continue;
    }
    const labelled = group.map((subject) => ({ id: subject.id, prefix: slug + '_' + sanitize(subject.account ?? subject.name).slice(0, MAX_ACCOUNT_SLUG_CHARS).replace(/_+$/, '') }));
    for (const entry of labelled) {
      const clash = labelled.filter((other) => other.prefix === entry.prefix).length > 1;
      prefixes.set(entry.id, clash ? entry.prefix + '_' + hash(entry.id, 4) : entry.prefix);
    }
  }
  return prefixes;
}

/** `<prefix>_<tool>`, cut to the model's limit with a hash of the tool name when it is too long. */
export function mcpToolName(prefix: string, toolName: string): string {
  const name = prefix + '_' + sanitize(toolName);
  if (name.length <= MAX_NAME_CHARS) return name;
  return name.slice(0, MAX_NAME_CHARS - 7) + '_' + hash(toolName, 6);
}

/**
 * The model-facing names of one connection's tools. Tools whose names sanitize alike (or cut alike) would share
 * a name, so all of them carry a hash of the server's own name and stay distinct.
 */
export function mcpToolNames(prefix: string, toolNames: readonly string[]): Map<string, string> {
  const plain = new Map(toolNames.map((toolName) => [toolName, mcpToolName(prefix, toolName)] as const));
  const counts = new Map<string, number>();
  for (const name of plain.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Map([...plain].map(([toolName, name]) => {
    if ((counts.get(name) ?? 0) < 2) return [toolName, name] as const;
    return [toolName, name.slice(0, MAX_NAME_CHARS - 7) + '_' + hash(toolName, 6)] as const;
  }));
}

function boundedInstructions(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_SERVER_INSTRUCTIONS_CHARS
    ? trimmed.slice(0, MAX_SERVER_INSTRUCTIONS_CHARS) + '…'
    : trimmed;
}

function boundedDescription(base: string, serverInstructions?: string): string {
  const truncatedBase = base.length > MAX_DESCRIPTION_CHARS ? base.slice(0, MAX_DESCRIPTION_CHARS) + '…' : base;
  if (serverInstructions === undefined) return truncatedBase;
  const trimmed = serverInstructions.trim();
  if (trimmed === '') return truncatedBase;
  return truncatedBase + '\n\nServer usage guidance: ' + boundedInstructions(trimmed);
}

/** Whether the server schema fits; an oversized one is skipped rather than faked as permissive. */
export function isSchemaWithinBound(tool: McpTool): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(tool.inputSchema ?? {}), 'utf8') <= MAX_SCHEMA_BYTES;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(name: string, text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true, details: { mcp: true, tool: name, unavailable: true } };
}

export interface McpToolBinding {
  /** The owner and agent this binding was built for; re-validated against ctx at execute time. */
  ownerId: string;
  agentId: string;
  connectionId: string;
  connectionName: string;
  tool: McpTool;
  /** True when discovery stopped at a bound, so the description says the catalog is incomplete. */
  catalogTruncated: boolean;
  manager: McpManager;
  /** The tool's class (tool-access.ts, with the app's curated table applied): the policy lets a read run and asks about an action by the app's policy. */
  access: ToolAccess;
  /** The agent's Actions policy for this app, when it is not the default `ask`. */
  actions?: 'ask' | 'allow';
  /** The tool is new, or its annotations changed, since the owner last looked (tool-ledger.ts): it is a change and asks first until reviewed. */
  needsReview?: true;
  /** Set when the connection was created from the connector catalog. */
  catalogId?: string;
  account?: string;
  /** The model-facing name (see mcpToolNames); the server's own name stays in `tool.name`. */
  name: string;
  /** Live initialize.instructions for this connection; surfaced as labelled, untrusted guidance in the description. */
  serverInstructions?: string;
}

export function createMcpTool(binding: McpToolBinding): Tool {
  const { ownerId, agentId, connectionId, connectionName, tool, catalogTruncated, manager, access, actions, needsReview, catalogId, account, name, serverInstructions } = binding;
  const title = tool.title ?? (typeof tool.annotations?.['title'] === 'string' ? tool.annotations['title'] : undefined);
  const base = tool.description ?? 'MCP tool ' + tool.name;
  const described = catalogTruncated ? base + ' (from a truncated ' + connectionName + ' catalog)' : base;
  return {
    name,
    description: boundedDescription(described, serverInstructions),
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    // A tool classified `read` (the app's table, else the server's readOnlyHint; unmarked is a change) changes nothing: it is safe to
    // redo and several of one reply run at once (run-tools.ts supportsParallel). A change runs alone, in order, and is never replayed.
    replay: access === 'read' ? 'safe' : 'never',
    sideEffect: access !== 'read',
    mcp: true,
    origin: {
      connectionId,
      connectionName,
      toolName: tool.name,
      ...(title === undefined || title === '' ? {} : { title }),
      access,
      ...(actions === undefined ? {} : { actions }),
      ...(needsReview === true ? { needsReview } : {}),
      ...(catalogId === undefined ? {} : { catalogId }),
      ...(account === undefined ? {} : { account }),
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (ctx.agentId !== agentId || ctx.ownerId !== ownerId) {
        return unavailable(name, 'MCP tool ' + name + ' is not available for this agent (bound to a different owner or agent)');
      }
      const store = ctx.store.forOwner?.(ownerId) ?? ctx.store;
      try {
        const outcome = await manager.callTool({
          ownerId,
          store,
          agentId: ctx.agentId,
          connectionId,
          toolName: tool.name,
          args: isRecord(args) ? args : {},
          signal: ctx.signal,
        });
        const content: ToolResult['content'] = [];
        for (const part of outcome.parts) {
          if (part.type === 'text') content.push({ type: 'text', text: part.text });
          else if (part.type === 'image') content.push({ type: 'image', mimeType: part.mimeType, data: part.data });
          else content.push({ type: 'text', text: '[resource ' + part.uri + ']' + (part.text === '' ? '' : ': ' + part.text) });
        }
        if (!content.some((item) => item.type === 'text') && outcome.text !== '') content.push({ type: 'text', text: outcome.text });
        if (outcome.truncated) content.push({ type: 'text', text: '[display truncated; the full result is available to the run artifact capture]' });
        if (content.length === 0) content.push({ type: 'text', text: 'MCP tool returned no usable content.' });
        const result: ToolResult = {
          content,
          details: {
            mcp: true,
            connectionId,
            tool: tool.name,
            truncated: outcome.truncated,
            ...(outcome.structured === undefined ? {} : { structured: true }),
            ...(outcome.unsupported.length === 0 ? {} : { unsupported: outcome.unsupported }),
            ...(outcome.fullText === undefined ? {} : { fullContent: outcome.fullText }),
          },
        };
        const nothingUsable = outcome.parts.length === 0 && outcome.structured === undefined;
        if (outcome.isError || nothingUsable) result.isError = true;
        return result;
      } catch (error) {
        const refused = unavailable(name, error instanceof Error ? error.message : String(error));
        // The state that refused the call travels with the result, next to the sentence the model reads.
        return error instanceof AppAccessError ? { ...refused, details: { ...refused.details, access: error.access } } : refused;
      }
    },
  };
}

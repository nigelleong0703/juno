// The tool list an owner last accepted for one connected app, and what changed since (BACKEND 10.18.1). A server can add a tool, or change what
// its annotations say about a tool, at any time; the owner added the app seeing the list it had. A tool that is new, or whose annotations
// changed, is a change (never a read, whatever the server now says) and is flagged `needs_review` until the owner marks it reviewed; a tool
// that is gone leaves the ledger and the plugin's per-tool permissions. The first list of a connection is the baseline: nothing is new yet.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { patchWhen, type Store } from '../../contracts/index.js';
import type { StoredMcpConnection } from './connections.js';
import type { McpTool } from './protocol.js';
import { classifyTool, type CuratedAccess, type ToolAccess } from './tool-access.js';

/** Per tool (the server's own name): a hash of the annotations that say what the tool does, and whether the owner has seen this version of it. */
export const toolLedgerSchema = z.record(z.string(), z.object({ hash: z.string(), reviewed: z.boolean() }));
export type ToolLedger = z.infer<typeof toolLedgerSchema>;

/** The field of the connection row that holds the ledger. */
const FIELD = 'toolReview';

/** JSON with object keys in a fixed order, so the same schema written in another key order hashes the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, canonical(inner)]));
}

/**
 * What the server says the tool does and takes: the hints that decide read versus change, and the input schema (a new parameter makes it a
 * different tool). A new title or description is not a change. Ledgers written before the schema was hashed were cleared by migration 0067.
 */
export function annotationsHash(tool: Pick<McpTool, 'annotations' | 'inputSchema'>): string {
  const hints = tool.annotations;
  const picked = [hints?.['readOnlyHint'], hints?.['destructiveHint'], hints?.['idempotentHint'], hints?.['openWorldHint'], canonical(tool.inputSchema ?? null)];
  return createHash('sha1').update(JSON.stringify(picked)).digest('hex').slice(0, 12);
}

export function readLedger(doc: object): ToolLedger | undefined {
  const parsed = toolLedgerSchema.safeParse(Reflect.get(doc, FIELD));
  return parsed.success ? parsed.data : undefined;
}

export const needsReview = (ledger: ToolLedger | undefined, toolName: string): boolean => ledger?.[toolName]?.reviewed === false;

/**
 * The tool's class with the ledger applied: an unreviewed tool is a change, even in an app we marked read-only and whatever its annotation
 * says. A tool our own table names (`toolAccess`) is our word and is never held back.
 */
export function classifyReviewed(tool: Pick<McpTool, 'name' | 'annotations'>, curated: CuratedAccess | undefined, ledger: ToolLedger | undefined): ToolAccess {
  return needsReview(ledger, tool.name) ? 'action' : classifyTool(tool, curated);
}

export interface LedgerStep {
  ledger: ToolLedger;
  /** Tools the previous ledger had that the server no longer lists. */
  gone: string[];
  changed: boolean;
}

/**
 * The ledger after seeing `tools`. `complete` is false when discovery stopped at a bound: a tool missing from a partial list is not gone.
 * With no previous ledger every tool is the baseline. A tool our curated table names is reviewed by us.
 */
export function nextLedger(prev: ToolLedger | undefined, tools: readonly McpTool[], curated: CuratedAccess | undefined, complete = true): LedgerStep {
  const ledger: ToolLedger = {};
  for (const tool of tools) {
    const hash = annotationsHash(tool);
    const before = prev?.[tool.name];
    const ours = curated?.toolAccess?.[tool.name] !== undefined;
    const reviewed = prev === undefined || ours ? true : before !== undefined && before.hash === hash ? before.reviewed : false;
    ledger[tool.name] = { hash, reviewed };
  }
  const listed = new Set(tools.map((tool) => tool.name));
  const gone = Object.keys(prev ?? {}).filter((name) => !listed.has(name));
  if (!complete) for (const name of gone) ledger[name] = prev?.[name] ?? { hash: '', reviewed: true };
  // No ledger yet always writes one, even an empty list: that first sight is the baseline, and a tool a server adds later is new.
  return { ledger, gone: complete ? gone : [], changed: prev === undefined || JSON.stringify(sorted(ledger)) !== JSON.stringify(sorted(prev)) };
}

const sorted = (ledger: ToolLedger): Array<[string, ToolLedger[string]]> => Object.entries(ledger).sort(([a], [b]) => a.localeCompare(b));

/** Writes `next` as the connection's ledger if nobody changed it since `prev` was read; false when someone did. */
async function writeLedger(store: Store, connectionId: string, prev: ToolLedger | undefined, next: ToolLedger): Promise<boolean> {
  const unchanged = (row: object): boolean => {
    const now = readLedger(row);
    return now === undefined || prev === undefined ? now === prev : JSON.stringify(sorted(now)) === JSON.stringify(sorted(prev));
  };
  return (await patchWhen(store, 'connections', connectionId, unchanged, { [FIELD]: next } as never)) !== undefined;
}

/** A tool that is gone from the server is gone from the plugin's per-tool permissions too (a stale "always allow" must not wait for a tool of the same name to come back). */
async function dropPermissions(store: Store, pluginId: string | undefined, gone: readonly string[]): Promise<void> {
  if (pluginId === undefined || gone.length === 0) return;
  const plugin = await store.get('plugins', pluginId);
  if (plugin === null || !plugin.tools.some((tool) => gone.includes(tool.name))) return;
  await store.patch('plugins', pluginId, { tools: plugin.tools.filter((tool) => !gone.includes(tool.name)) });
}

/**
 * Brings the connection's ledger up to the server's current list and returns it. A concurrent writer (another run seeing the same list, or the
 * owner marking a tool reviewed) is re-read, never overwritten.
 */
export async function syncToolLedger(store: Store, doc: StoredMcpConnection, tools: readonly McpTool[], opts: { complete: boolean; curated?: CuratedAccess }): Promise<ToolLedger> {
  let current: object = doc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prev = readLedger(current);
    const step = nextLedger(prev, tools, opts.curated, opts.complete);
    if (!step.changed) return step.ledger;
    if (await writeLedger(store, doc.id, prev, step.ledger)) {
      await dropPermissions(store, doc.pluginId, step.gone);
      return step.ledger;
    }
    current = (await store.get('connections', doc.id)) ?? current;
  }
  return nextLedger(readLedger(current), tools, opts.curated, opts.complete).ledger;
}

/** The owner has looked at these tools (all the unreviewed ones when `names` is absent): they go back to the normal rules. Returns the names marked. */
export async function markToolsReviewed(store: Store, connectionId: string, names?: readonly string[]): Promise<string[]> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await store.get('connections', connectionId);
    const prev = row === null ? undefined : readLedger(row);
    if (prev === undefined) return [];
    const marked = Object.keys(prev).filter((name) => prev[name]?.reviewed === false && (names === undefined || names.includes(name)));
    if (marked.length === 0) return [];
    const next: ToolLedger = Object.fromEntries(Object.entries(prev).map(([name, entry]) => [name, marked.includes(name) ? { ...entry, reviewed: true } : entry]));
    if (await writeLedger(store, connectionId, prev, next)) return marked;
  }
  return [];
}

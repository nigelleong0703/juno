// Read / change classification of MCP tools (Apps, BACKEND 10.18). A read tool only reads: it runs without asking and belongs to the
// app's "Chat & read" grant. Every other tool changes something and follows the app's Actions policy for the agent (ask first,
// allow, off). The server's annotation is only a hint, so the curated catalog entry overrides it; a tool nobody marked is a change.
import type { McpTool } from './protocol.js';

export type ToolAccess = 'read' | 'action';

/** What the curated catalog table says about an app's tools (CatalogEntry.readOnly / toolAccess). */
export interface CuratedAccess {
  /** Every tool of this server only reads. */
  readOnly?: boolean;
  /** Tool name on the server -> its class; wins over `readOnly` and over the annotation. */
  toolAccess?: Readonly<Record<string, 'read' | 'change'>>;
}

export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

/**
 * The curated table first (a tool named there, then a read-only app), then the annotation (`readOnlyHint` true is read;
 * `readOnlyHint` false or `destructiveHint` true is a change), and a tool with neither mark is a change.
 */
export function classifyTool(tool: Pick<McpTool, 'name' | 'annotations'>, curated?: CuratedAccess): ToolAccess {
  const named = curated?.toolAccess?.[tool.name];
  if (named !== undefined) return named === 'read' ? 'read' : 'action';
  if (curated?.readOnly === true) return 'read';
  const hints = tool.annotations;
  if (hints?.destructiveHint === true || hints?.readOnlyHint === false) return 'action';
  return hints?.readOnlyHint === true ? 'read' : 'action';
}

/** The name the Apps API gives a class: `read` stays, an action is a `change`. */
export const capabilityKind = (access: ToolAccess): 'read' | 'change' => (access === 'read' ? 'read' : 'change');

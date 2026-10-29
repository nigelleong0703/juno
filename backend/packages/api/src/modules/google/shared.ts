/** What the tool sets of the Google and Microsoft MCP servers this gateway hosts (modules/google-mcp.ts) share. */

export type Args = Record<string, unknown>;
export type Query = Record<string, string | undefined>;

/** A request with a body. `contentType` set: `body` is a string sent as is (a file upload), else it is JSON. A path starting `/upload/` is resolved against the API's origin (Drive uploads). */
export interface Send {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  contentType?: string;
}

/** A REST API (Google's, or Microsoft Graph) bound to one base URL and the caller's token. */
export interface Api {
  /** JSON in, JSON out (an empty reply, as DELETE gives, is `{}`); `send` makes it a write. */
  (path: string, query?: Query, send?: Send): Promise<Record<string, unknown>>;
  /** A body read as text (file downloads and exports). */
  text(path: string, query?: Query): Promise<string>;
  /** A body read as bytes (Office files). */
  bytes(path: string, query?: Query): Promise<Buffer>;
}

export interface HostedTool {
  name: string;
  /** The human name of the tool (MCP `title`), shown in the app's records. */
  title: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  /** Changes something (default: reads only); it then follows the connector's level and asks first. */
  writes?: boolean;
  /** A write that cannot be undone (sending mail): advertised as destructiveHint so it is held to the strictest level. */
  destructive?: boolean;
  run(api: Api, args: Args): Promise<unknown>;
}

export const PAGE = {
  maxResults: { type: 'integer', minimum: 1, maximum: 50, description: 'How many results (default 10).' },
  pageToken: { type: 'string', description: 'nextPageToken from a previous call, for the next page.' },
};

export const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** maxResults (1-50, default 10) and pageToken, under the query names an API uses. */
export const page = (args: Args, names: { size?: string } = {}): Query => ({
  [names.size ?? 'maxResults']: String(typeof args.maxResults === 'number' ? Math.min(50, Math.max(1, Math.trunc(args.maxResults))) : 10),
  pageToken: str(args.pageToken),
});

export function itemsOf(body: Record<string, unknown>, key = 'items'): Record<string, unknown>[] {
  const items = body[key];
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : [];
}

export const nextPage = (body: Record<string, unknown>): { nextPageToken?: string } =>
  typeof body.nextPageToken === 'string' ? { nextPageToken: body.nextPageToken } : {};

/** Long bodies are cut so one tool result stays a readable size. */
export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + '\n[… cut at ' + String(limit) + ' characters]';
}

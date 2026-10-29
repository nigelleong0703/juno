// Transport seam shared by the HTTP and sandbox-stdio MCP transports.

export interface McpRequestOptions {
  signal?: AbortSignal;
  /** Extra headers for this request only (the 2026-07-28 Mcp-Param-* mirror of a call's annotated arguments). */
  headers?: Record<string, string>;
}

/** A server notification: its method and params (a notification carries no id). */
export type McpNotificationHandler = (method: string, params: Record<string, unknown>) => void;

export interface McpListenOptions {
  /** The JSON-RPC id of the stream's request (modern subscriptions/listen); unused by the legacy stream. */
  id: number | string;
  /** Modern subscription filter, e.g. `{ toolsListChanged: true }`; absent for the legacy GET stream. */
  subscribe?: Record<string, unknown>;
}

export interface McpTransport {
  readonly kind: 'http' | 'stdio';
  /**
   * The negotiated revision. The modern one adds per-request routing headers and no session; undefined
   * clears it again (a legacy handshake sends no version header before the server has named its own).
   */
  setProtocolVersion?(version: string | undefined): void;
  request(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
    options?: McpRequestOptions,
  ): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
  /**
   * A long-lived notification stream, read until `signal` aborts. Resolves false when the server offers none
   * (or the stream was never opened), true once an opened stream has ended.
   */
  listen?(options: McpListenOptions, onNotification: McpNotificationHandler, signal: AbortSignal): Promise<boolean>;
}

/**
 * Pure origin + CSP helpers for the Electron main process (E5). They import nothing from Electron
 * so the packaged client's connectivity policy can be unit-tested in plain Node.
 *
 * The renderer is only ever allowed to reach `'self'`, the documented default server, and the
 * specific `http(s)` origins the user has chosen — never a blanket `http:`/`https:` scheme.
 */

/**
 * Reduce an arbitrary URL to a bare `scheme://host[:port]` origin, or `null` when it is not a
 * valid http(s) server address. Path, query, fragment and embedded credentials are dropped;
 * non-http(s) schemes (ws, file, javascript, …) are refused so they can never reach the CSP.
 */
export function normalizeServerOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  // `*` is not a forbidden host code point, so `https://*.example.com` parses fine — but in a CSP
  // it is a wildcard subdomain match. Reject any hostname wildcard.
  if (url.hostname.includes("*")) return null;
  return url.origin;
}

/**
 * Reduce a websocket stream URL to a bare `ws://host[:port]` / `wss://host[:port]` origin, or
 * `null` for anything else. This is deliberately strict: a CSP `connect-src` entry is a raw
 * token, so a wildcard or an invalid value must be dropped rather than copied into the policy.
 */
export function normalizeWebSocketOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
  if (url.username || url.password) return null;
  if (url.hostname.includes("*")) return null;
  return url.origin;
}

export interface OriginRegistration {
  /** The normalized origin, or `null` when the value was rejected. */
  origin: string | null;
  /** True when the origin was not already in the allow-list (so it is worth persisting). */
  changed: boolean;
}

/**
 * Validate an IPC-supplied value and report whether it is new. This is the whole trust boundary of
 * the desktop origin-allowance IPC: anything that is not a plain http(s) server URL is ignored.
 */
export function registerServerOrigin(
  known: ReadonlySet<string>,
  value: unknown,
): OriginRegistration {
  if (typeof value !== "string") return { origin: null, changed: false };
  const origin = normalizeServerOrigin(value);
  if (!origin) return { origin: null, changed: false };
  return { origin, changed: !known.has(origin) };
}

/** A registered origin plus whether the document must reload before it can use it. */
export interface AllowedServerOrigin {
  origin: string;
  reloadRequired: boolean;
}

function isAllowedServerOrigin(value: unknown): value is AllowedServerOrigin {
  if (typeof value !== "object" || value === null) return false;
  if (!("origin" in value) || typeof value.origin !== "string") return false;
  if (!("reloadRequired" in value) || typeof value.reloadRequired !== "boolean") return false;
  return true;
}

/**
 * The desktop half of the origin allowance must never hand the renderer the same `null` the web
 * adapter returns for "no-op": a rejected origin has to fail loudly so the app cannot go ready and
 * fetch against a policy that does not include it. Throws on a null or malformed IPC result.
 */
export function requireAllowedServerOrigin(result: unknown): AllowedServerOrigin {
  if (!isAllowedServerOrigin(result)) {
    // Deliberately fixed: the requested value may carry credentials or a query string, which must
    // not end up in an error surfaced to the renderer.
    throw new Error("Desktop shell rejected the server origin");
  }
  return result;
}

export interface ContentSecurityPolicyInput {
  /** Server origins the renderer may fetch / stream from (normalized or raw; bad ones are skipped). */
  serverOrigins: readonly string[];
  /** Extra websocket origins (e.g. `AGENT_DESKTOP_STREAM_ORIGINS`). */
  streamOrigins: readonly string[];
  /** Vite dev-server origins; non-empty only in development. */
  devOrigins: readonly string[];
}

/** The websocket counterpart of an http(s) origin, for SSE-over-ws / streaming transports. */
function webSocketVariant(origin: string): string {
  if (origin.startsWith("https:")) return `wss:${origin.slice("https:".length)}`;
  return `ws:${origin.slice("http:".length)}`;
}

/**
 * Build the authoritative Content-Security-Policy. Every origin is a `scheme://host[:port]` token
 * (or `'self'`), so there is no wildcard to leak the renderer to arbitrary hosts.
 */
export function buildContentSecurityPolicy(input: ContentSecurityPolicyInput): string {
  const script = ["'self'"];
  const style = ["'self'", "'unsafe-inline'"]; // Tailwind injects styles; ui ships no runtime CSS-in-JS
  const img = ["'self'", "data:", "blob:"];
  const connect = new Set<string>(["'self'"]);

  for (const origin of input.devOrigins) {
    if (!origin) continue;
    connect.add(origin);
    script.push("'unsafe-inline'"); // Vite HMR injects inline scripts in dev
  }
  for (const raw of input.serverOrigins) {
    const origin = normalizeServerOrigin(raw);
    if (!origin) continue;
    connect.add(origin);
    connect.add(webSocketVariant(origin));
    img.push(origin);
  }
  for (const raw of input.streamOrigins) {
    const origin = normalizeWebSocketOrigin(raw);
    if (origin) connect.add(origin);
  }

  return [
    `default-src 'self'`,
    `script-src ${script.join(" ")}`,
    `style-src ${style.join(" ")}`,
    `img-src ${img.join(" ")}`,
    `font-src 'self' data:`,
    `connect-src ${[...connect].join(" ")}`,
    `object-src 'none'`,
    // Published interactive pages render in a sandboxed iframe on the server's separate artifact
    // host (an arbitrary registrable domain, or *.localhost in dev); nothing else may be framed.
    `frame-src https: http://*.localhost:*`,
    `base-uri 'self'`,
    `form-action 'none'`,
  ].join("; ");
}

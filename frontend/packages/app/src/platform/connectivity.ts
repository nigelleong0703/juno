import type { PlatformAdapter, ServerOriginAllowance } from "./adapter";

export interface ServerConnectivityTarget {
  serverUrl: string;
}

/** What the renderer must do next before it may build the client and fetch. */
export type ConnectivityStep =
  | { kind: "ready" }
  | { kind: "reload" };

/**
 * Registers the server the app is about to use with the desktop shell **before** any HTTP/SSE call.
 * A document's CSP is fixed once it has loaded, so when the shell reports the origin as
 * `reloadRequired` the caller must reload the document and re-run this step: the reloaded document
 * carries the widened policy and can then connect. The web adapter has no shell CSP (returns
 * `null`), so it never needs a reload.
 */
export async function prepareServerConnectivity(
  target: ServerConnectivityTarget,
  platform: PlatformAdapter,
): Promise<ServerOriginAllowance | null> {
  return (await platform.allowServerOrigin?.(target.serverUrl)) ?? null;
}

/**
 * The renderer's bootstrap decision. Deliberately does not catch: an IPC failure must propagate so
 * the caller can surface it, never let the app mount against an unknown policy.
 */
export async function resolveServerConnectivity(
  target: ServerConnectivityTarget,
  platform: PlatformAdapter,
): Promise<ConnectivityStep> {
  const allowance = await prepareServerConnectivity(target, platform);
  return allowance?.reloadRequired ? { kind: "reload" } : { kind: "ready" };
}

export type ServerConnectivityResolver = (
  target: ServerConnectivityTarget,
) => Promise<ConnectivityStep>;

/**
 * A per-document resolver that caches the in-flight registration for a given server. React
 * StrictMode replays the bootstrap effect on the same mount; without this the second replay would
 * hit the now-populated allow-list, be told "no reload needed", and mount against the stale document
 * CSP. Sharing one promise means every replay sees the same `reload` decision. A rejection is not
 * cached, so a later attempt can genuinely retry.
 */
export function createServerConnectivityResolver(
  platform: PlatformAdapter,
): ServerConnectivityResolver {
  let cached: { key: string; promise: Promise<ConnectivityStep> } | null = null;
  return (target) => {
    const key = target.serverUrl;
    if (cached && cached.key === key) return cached.promise;
    const promise = resolveServerConnectivity(target, platform).catch((error: unknown) => {
      if (cached && cached.promise === promise) cached = null;
      throw error;
    });
    cached = { key, promise };
    return promise;
  };
}

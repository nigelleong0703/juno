import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

/** How long an idle outbound connection stays open. Node's default is 4 s, shorter than the gap between two voice turns. */
export const OUTBOUND_KEEP_ALIVE_MS = 30_000;

/**
 * Keep the sockets of the global `fetch` (the model providers' SDKs use it) open between requests, so a turn seconds after the last one
 * reuses its TLS connection (a handshake is ~0.4 s) and the voice call's prepare request leaves one ready. Idempotent.
 */
export function keepOutboundConnectionsWarm(): void {
  if (getGlobalDispatcher() instanceof Agent) return;
  setGlobalDispatcher(new Agent({ keepAliveTimeout: OUTBOUND_KEEP_ALIVE_MS, keepAliveMaxTimeout: OUTBOUND_KEEP_ALIVE_MS }));
}

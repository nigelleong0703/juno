import type { ScreenStreamTicket } from '../contracts.js';

/**
 * This DTO describes agentd's first-party VNC proxy, never a third-party websocket endpoint.
 * Only absolute ws/wss URLs with the requested screen's exact encoded route are accepted.
 * The issued origin is advisory (an HTTPS tunnel can reach agentd over HTTP); the configured
 * HTTP API origin is authoritative. Even a matching route with a foreign issued host is pinned
 * to that API origin. Unrelated routes, credentials, fragments and malformed URLs fail closed.
 */
export function normalizeScreenStreamTicket(
  ticket: ScreenStreamTicket,
  screenId: string,
  apiBaseUrl: string,
): ScreenStreamTicket {
  const api = new URL(apiBaseUrl);
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password) {
    throw new Error('Screen streaming requires an HTTP or HTTPS API origin without credentials');
  }
  let issued: URL;
  try {
    issued = new URL(ticket.url);
  } catch {
    throw new Error('Invalid screen stream ticket URL');
  }
  const expectedPath = `/v1/screens/${encodeURIComponent(screenId)}/vnc`;
  if (!['ws:', 'wss:'].includes(issued.protocol) || issued.pathname !== expectedPath
    || issued.username || issued.password || issued.hash || /\s/.test(ticket.url)) {
    throw new Error('Screen stream ticket must target the requested agentd VNC route');
  }
  const protocol = api.protocol === 'https:' ? 'wss:' : 'ws:';
  return { ...ticket, url: `${protocol}//${api.host}${issued.pathname}${issued.search}` };
}

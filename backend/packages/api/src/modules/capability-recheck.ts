/**
 * Tells agentd that an owner's connections changed, so routines waiting for an app can start and routines that lost one go
 * on hold (BACKEND §3.6.1). Fire and forget: a failure only delays the change until the routine's next scheduled fire, where
 * the timer checks again; it never fails the connect or disconnect that triggered it.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { createLogger } from '@agent-desktop/log';
import { requestOwner } from '../owner.js';

const log = createLogger({ service: 'api' });

export type ConnectionsChanged = (ownerId: string) => void;

export function createConnectionsChanged(deps: { agentdUrl: string; internalToken: string; fetchFn: typeof fetch; timeoutMs?: number }): ConnectionsChanged {
  const url = deps.agentdUrl.replace(/\/$/, '') + '/v1/capabilities/recheck';
  return (ownerId) => {
    void deps
      .fetchFn(url, { method: 'POST', headers: { authorization: 'Bearer ' + deps.internalToken, 'x-owner-id': ownerId }, redirect: 'manual', signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) })
      .then((response) => response.body?.cancel())
      .catch((error: unknown) => log.warn({ err: error }, 'capability recheck failed'));
  };
}

/** After a successful write under /v1/apps (install, remove an installation, enable an agent in a workspace). */
export function notifyAfterConnectionWrite(changed: ConnectionsChanged): MiddlewareHandler {
  return async (c: Context, next) => {
    await next();
    if (c.req.method !== 'GET' && c.res.status < 300) changed(requestOwner(c));
  };
}

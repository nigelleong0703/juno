// Production MCP manager: sessions are partitioned by owner AND agent, a user disconnect aborts
// in-flight work and closes every session for that owner+connection, and the canonical enabled flag
// is re-read before any status write.
import type { Store, Tool } from '../../contracts/index.js';
import type { Connection } from '@agent-desktop/public-contracts';
import { missingDefaultConnections } from './platform-keys.js';
import type { ConnectorCatalog } from './catalog.js';
import { SecretsError } from '../../contracts/secrets.js';
import { McpClient, McpConnectionError } from './client.js';
import type { McpConnectionStatus, McpToolOutcome } from './client.js';
import { McpAuthError } from './protocol.js';
import { HttpMcpTransport } from './http-transport.js';
import { AppAccessError } from './access-error.js';
import { createCallLimiter, MCP_CALLS_PER_CONNECTION } from './call-limit.js';
import type { McpServerConfig } from './config.js';
import { isConnectionEnabled, storedConfig, type StoredMcpConnection } from './connections.js';
import { createOAuthAuthorizer, McpReauthorizationError } from './oauth-tokens.js';
import { openOAuth } from './oauth.js';
import type { CuratedAccess, ToolAccess } from './tool-access.js';
import { classifyReviewed, needsReview, readLedger, syncToolLedger, type ToolLedger } from './tool-ledger.js';
import { agentAppSettings, appIdOfConnection, settingFor } from '../apps/agent-apps.js';
import {
  authorizeAgent,
  connectBounded,
  DEFAULT_CONCURRENCY,
  loadConnection,
  neverTools,
  persistConnection,
  persistIfEnabled,
  resolveOwner,
  toolsFromSessions,
  transportFor,
  watchRevocation,
  type McpManagerTransportDeps,
  type Session,
} from './manager-support.js';

export interface McpManagerDeps extends McpManagerTransportDeps {
  /** Bounded parallelism for discovery across configured servers. */
  concurrency?: number;
  /** Tool calls in flight to one connection at once (default MCP_CALLS_PER_CONNECTION); more wait their turn. */
  callsPerConnection?: number;
  /**
   * The connectors this deployment offers. A stored connection to a catalog connector outside it (its plugin was turned
   * off) is skipped when tools are listed and refused with a clear error on use; its row stays, so turning the plugin
   * back on restores it. Absent: every stored connection is usable (the gateway's own manager).
   */
  catalog?: ConnectorCatalog;
}

export interface McpManager {
  connect(input: { ownerId?: string; store: Store; connectionId: string; agentId?: string; signal?: AbortSignal }): Promise<McpConnectionStatus>;
  /** `turn` is the run turn asking (`runId:stepId`): a connection re-lists at most once per turn. */
  toolsForAgent(input: { ownerId?: string; store: Store; agentId: string; signal?: AbortSignal; turn?: string }): Promise<Tool[]>;
  callTool(input: { ownerId?: string; store: Store; agentId: string; connectionId: string; toolName: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<McpToolOutcome>;
  /** Every tool one connection provides, labelled read or action (the curated catalog table applied), whatever an agent's policy hides. */
  listTools(input: { ownerId?: string; store: Store; connectionId: string; signal?: AbortSignal }): Promise<Array<{ name: string; title: string; description: string; access: ToolAccess; needsReview: boolean }>>;
  disconnect(input: { ownerId?: string; store: Store; connectionId: string }): Promise<Connection>;
  /**
   * One read-only call with values the owner just typed (an API key), made before anything is stored: `ok`, or the reason in words the owner can
   * act on. Nothing is kept: no session, no row, and the reason never repeats a header value.
   */
  probe(input: { url: string; headers?: Readonly<Record<string, string>>; tool: string; args?: Record<string, unknown>; signal?: AbortSignal }): Promise<{ ok: true } | { ok: false; reason: string }>;
  status(input: { ownerId?: string; store: Store; connectionId: string }): Promise<McpConnectionStatus | undefined>;
  /** Close every open session (stdio children included) and abort pending connects; for runtime teardown. */
  close(): Promise<void>;
}
/** A probe is one quick call; a server that does not answer in this long has not accepted the value. */
const PROBE_TIMEOUT_MS = 15_000;
const boundedReason = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 200);

export function createMcpManager(deps: McpManagerDeps = {}): McpManager {
  const sessions = new Map<string, Session>();
  const inflight = new Map<string, { promise: Promise<Session>; controller: AbortController }>();
  const byGroup = new Map<string, Set<string>>();
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const limiter = createCallLimiter(deps.callsPerConnection ?? MCP_CALLS_PER_CONNECTION);

  const keyFor = (ownerId: string, agentId: string | undefined, connectionId: string): string =>
    ownerId + ':' + (agentId ?? '-') + ':' + connectionId;
  const groupFor = (ownerId: string, connectionId: string): string => ownerId + ':' + connectionId;
  /** A custom server (no catalogId) is always usable; a catalog connector only while the deployment still offers it. */
  const offered = (doc: { catalogId?: string | undefined }): boolean => deps.catalog === undefined || doc.catalogId === undefined || deps.catalog.get(doc.catalogId) !== undefined;
  /** Our own read / change table for a catalog app (tool-access.ts); a custom server has none. */
  const curatedFor = (doc: { catalogId?: string | undefined; toolMarks?: Readonly<Record<string, 'read' | 'change'>> | undefined }): CuratedAccess | undefined =>
    doc.catalogId === undefined ? (doc.toolMarks === undefined ? undefined : { toolAccess: doc.toolMarks }) : deps.catalog?.get(doc.catalogId);

  function track(group: string, key: string): void {
    const set = byGroup.get(group) ?? new Set<string>();
    set.add(key);
    byGroup.set(group, set);
  }

  async function establish(
    ownerId: string,
    agentId: string | undefined,
    store: Store,
    doc: StoredMcpConnection,
    key: string,
    signal: AbortSignal,
  ): Promise<Session> {
    let config: McpServerConfig | null;
    try {
      config = storedConfig(doc);
    } catch (error) {
      if (error instanceof SecretsError) throw new McpConnectionError('MCP connection ' + JSON.stringify(doc.id) + ' has stored credentials that cannot be decrypted: ' + error.message);
      throw error;
    }
    if (config === null) throw new McpConnectionError('MCP connection ' + JSON.stringify(doc.id) + ' has no endpoint');
    // An OAuth-authorized HTTP server gets a Bearer header per request; the token source refreshes it.
    const authorize = config.transport === 'http' && openOAuth(Reflect.get(doc, 'auth')) !== undefined
      ? createOAuthAuthorizer({ store, ownerId, connectionId: doc.id, ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }) })
      : undefined;
    const client = new McpClient(() => transportFor(config, deps, ownerId, agentId, authorize));
    try {
      const status = await client.connect({ signal });
      const discovery = await client.discoverTools({ signal });
      // Canonical state wins: a disconnect during connect must not be written back as connected.
      const fresh = await loadConnection(store, ownerId, doc.id);
      if (fresh === null || !isConnectionEnabled(fresh)) {
        throw new McpConnectionError('MCP connection ' + JSON.stringify(doc.id) + ' was revoked while connecting');
      }
      await persistConnection(store, doc.id, status);
      const session: Session = { client, truncated: discovery.truncated };
      sessions.set(key, session);
      return session;
    } catch (error) {
      const failed = client.getStatus();
      await client.close().catch(() => undefined);
      await persistIfEnabled(store, ownerId, doc.id, failed);
      throw error;
    }
  }

  async function ensureSession(
    ownerId: string,
    agentId: string | undefined,
    store: Store,
    connectionId: string,
    signal: AbortSignal | undefined,
  ): Promise<Session> {
    const doc = await loadConnection(store, ownerId, connectionId);
    if (doc === null) throw new McpConnectionError('MCP connection ' + JSON.stringify(connectionId) + ' is not available');
    if (!isConnectionEnabled(doc)) {
      throw new McpConnectionError('MCP connection ' + JSON.stringify(connectionId) + ' was disconnected by the user');
    }
    if (!offered(doc)) throw new McpConnectionError('connector ' + JSON.stringify(doc.catalogId) + ' is not available on this deployment');
    const key = keyFor(ownerId, agentId, connectionId);
    const ready = sessions.get(key);
    if (ready !== undefined && ready.client.getStatus().state === 'connected') return ready;
    const pending = inflight.get(key);
    if (pending !== undefined) return pending.promise;

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal !== undefined) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const run = establish(ownerId, agentId, store, doc, key, controller.signal).finally(() => {
      inflight.delete(key);
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
    });
    inflight.set(key, { promise: run, controller });
    track(groupFor(ownerId, connectionId), key);
    return run;
  }

  const manager: McpManager = {
    async connect(input) {
      const ownerId = resolveOwner(input.ownerId);
      const session = await ensureSession(ownerId, input.agentId, input.store, input.connectionId, input.signal);
      return session.client.getStatus();
    },

    async toolsForAgent(input) {
      if (input.signal?.aborted) throw new McpConnectionError('MCP discovery was cancelled');
      const ownerId = resolveOwner(input.ownerId);
      const agent = await authorizeAgent(input.store, input.agentId);
      // Only the apps turned on for this agent; an app with no row is on (agent-apps.ts).
      const settings = await agentAppSettings(input.store, input.agentId);
      const candidates: StoredMcpConnection[] = [];
      const all: StoredMcpConnection[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const listed = await input.store.list('connections', cursor === undefined ? { limit: 200 } : { limit: 200, cursor });
        all.push(...listed.items);
        for (const doc of listed.items) {
          if (doc.kind !== 'mcp' || !isConnectionEnabled(doc) || !offered(doc) || !settingFor(settings, appIdOfConnection(doc)).enabled) continue;
          if (doc.pluginId !== undefined && !agent.pluginIds.includes(doc.pluginId)) continue;
          candidates.push(doc);
        }
        cursor = listed.nextCursor;
        if (cursor === undefined) break;
        if (page === 9) throw new McpConnectionError('MCP connection list exceeds the bounded page count; refusing a partial catalog');
      }
      // Keyless servers are connected by default (platform-keys.ts): write the owner's row on first sight.
      for (const doc of missingDefaultConnections(ownerId, all).filter(offered)) {
        const row = await input.store.put('connections', doc) as StoredMcpConnection;
        if (settingFor(settings, appIdOfConnection(row)).enabled) candidates.push(row);
      }
      const connected = await connectBounded(
        candidates,
        concurrency,
        (doc) => ensureSession(ownerId, input.agentId, input.store, doc.id, input.signal),
        input.signal,
      );
      // Freshness is decided per listing: a stale list is re-listed here, at most once per run turn (see McpRefreshOptions).
      // Calls read the list they have; a call to a name it lacks re-lists itself (client.callTool).
      const refresh = { ...(input.signal === undefined ? {} : { signal: input.signal }), ...(input.turn === undefined ? {} : { turn: input.turn }) };
      await Promise.all(connected.map(({ session }) => session.client.refreshIfStale(refresh)));
      // What changed in a list since the owner accepted it (a new tool, other annotations) is held back as a change until reviewed (tool-ledger.ts).
      const ledgers = new Map<string, ToolLedger>();
      for (const { doc, session } of connected) {
        ledgers.set(doc.id, await syncToolLedger(input.store, doc, session.client.discoveredTools(), { complete: !session.client.toolsTruncated(), curated: curatedFor(doc) }));
      }
      return toolsFromSessions(input.store, ownerId, input.agentId, manager, connected, { settings, curatedFor, ledgers });
    },

    async callTool(input) {
      const ownerId = resolveOwner(input.ownerId);
      const doc = await loadConnection(input.store, ownerId, input.connectionId);
      if (doc === null) throw new McpConnectionError('MCP connection ' + JSON.stringify(input.connectionId) + ' is not available');
      const appId = appIdOfConnection(doc);
      // Only a catalog app has an id a Connect card can name; a custom server is fixed on the Apps page.
      const cardable = doc.catalogId !== undefined;
      if (!isConnectionEnabled(doc)) throw new AppAccessError({ appId, state: 'not_added' }, doc.name, undefined, cardable);
      const agent = await authorizeAgent(input.store, input.agentId);
      if (doc.pluginId !== undefined && !agent.pluginIds.includes(doc.pluginId)) {
        throw new McpConnectionError('agent ' + JSON.stringify(input.agentId) + ' is not authorized for this MCP server');
      }
      const denied = await neverTools(input.store, doc.pluginId);
      if (denied.has(input.toolName)) throw new McpConnectionError('MCP tool ' + JSON.stringify(input.toolName) + ' is set to never');
      const session = await ensureSession(ownerId, input.agentId, input.store, input.connectionId, input.signal);
      // Defence in depth, read fresh for this call: a stale tool list never lets an agent use an app that was turned off for it, or an
      // action tool of an app whose Actions policy is Off (a tool the session does not know is an action).
      const setting = settingFor(await agentAppSettings(input.store, input.agentId), appId);
      if (!setting.enabled) throw new AppAccessError({ appId, state: 'not_enabled' }, doc.name, undefined, cardable);
      const named = session.client.discoveredTools().find((candidate) => candidate.name === input.toolName);
      if (setting.actionsPolicy === 'off' && (named === undefined || classifyReviewed(named, curatedFor(doc), readLedger(doc)) === 'action')) {
        throw new AppAccessError({ appId, state: 'not_granted' }, doc.name, input.toolName, cardable);
      }
      const controller = new AbortController();
      const outer = input.signal;
      const onOuterAbort = () => controller.abort(outer?.reason);
      if (outer !== undefined) {
        if (outer.aborted) controller.abort(outer.reason);
        else outer.addEventListener('abort', onOuterAbort, { once: true });
      }
      const stopWatch = watchRevocation(input.store, ownerId, input.connectionId, controller);
      try {
        // At most MCP_CALLS_PER_CONNECTION in flight to one connection (an owner's connection, whichever agent or run calls).
        return await limiter.run(groupFor(ownerId, input.connectionId), () => session.client.callTool(input.toolName, input.args, { signal: controller.signal }), controller.signal);
      } catch (error) {
        if (error instanceof McpAuthError || error instanceof McpReauthorizationError) {
          // The session still reports connected (a failed call does not change the client), so write the
          // real state and drop the session: the next use re-verifies the authorization or fails visibly.
          await persistIfEnabled(input.store, ownerId, input.connectionId, { state: 'error', detail: 'authorization was rejected' });
          // A 403 insufficient_scope names what the sign-in lacks: kept on the row, so signing in again asks for it too (step-up, bounded in startMcpAuthorization).
          if (error instanceof McpAuthError && error.insufficientScope !== undefined && error.insufficientScope !== '') {
            await input.store.patch('connections', input.connectionId, { needsScope: error.insufficientScope } as never).catch(() => undefined);
          }
          const key = keyFor(ownerId, input.agentId, input.connectionId);
          sessions.delete(key);
          await session.client.close().catch(() => undefined);
          // The model gets the access state, not the transport's words: reconnect, no retry.
          const scope = error instanceof McpAuthError ? error.insufficientScope : undefined;
          throw new AppAccessError(scope === undefined ? { appId, state: 'expired' } : { appId, state: 'scope_missing', ...(scope === '' ? {} : { scope }) }, doc.name, undefined, cardable);
        } else {
          await persistIfEnabled(input.store, ownerId, input.connectionId, session.client.getStatus());
        }
        throw error;
      } finally {
        stopWatch();
        if (outer !== undefined) outer.removeEventListener('abort', onOuterAbort);
      }
    },

    async listTools(input) {
      const ownerId = resolveOwner(input.ownerId);
      const session = await ensureSession(ownerId, undefined, input.store, input.connectionId, input.signal);
      // The page shows what the server offers now: a list past its ttl is read again, so a changed tool shows up as needing review.
      await session.client.refreshIfStale(input.signal === undefined ? {} : { signal: input.signal });
      const doc = await loadConnection(input.store, ownerId, input.connectionId);
      const curated = curatedFor(doc ?? {});
      const tools = session.client.discoveredTools();
      const ledger = doc === null ? undefined : await syncToolLedger(input.store, doc, tools, { complete: !session.client.toolsTruncated(), curated });
      return tools.map((tool) => ({
        name: tool.name,
        title: tool.title ?? (typeof tool.annotations?.['title'] === 'string' ? tool.annotations['title'] : tool.name),
        description: tool.description ?? '',
        access: classifyReviewed(tool, curated, ledger),
        needsReview: needsReview(ledger, tool.name),
      }));
    },

    async close() {
      for (const pending of inflight.values()) pending.controller.abort(new Error('MCP manager was closed'));
      const open = [...sessions.values()];
      sessions.clear();
      byGroup.clear();
      await Promise.all(open.map((session) => session.client.close().catch(() => undefined)));
    },

    async disconnect(input) {
      const ownerId = resolveOwner(input.ownerId);
      const doc = await loadConnection(input.store, ownerId, input.connectionId);
      if (doc === null) throw new McpConnectionError('MCP connection ' + JSON.stringify(input.connectionId) + ' is not available');
      // Revoke first: in-flight callers observe the canonical flag before any session is torn down.
      // Revoking also drops the stored OAuth record, so no token outlives the user's disconnect.
      const revoked = await input.store.patch('connections', input.connectionId, { status: 'disconnected', enabled: false, auth: null, headers: null, userConfig: null } as never);
      const group = groupFor(ownerId, input.connectionId);
      for (const key of byGroup.get(group) ?? []) {
        inflight.get(key)?.controller.abort(new Error('MCP connection was disconnected'));
        const session = sessions.get(key);
        if (session !== undefined) {
          await session.client.close().catch(() => undefined);
          sessions.delete(key);
        }
      }
      byGroup.delete(group);
      return revoked;
    },

    async probe(input) {
      const client = new McpClient(() => new HttpMcpTransport({
        url: input.url,
        ...(input.headers === undefined ? {} : { headers: { ...input.headers } }),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      }));
      const signal = input.signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS);
      try {
        await client.connect({ signal });
        const outcome = await client.callTool(input.tool, input.args ?? {}, { signal });
        if (!outcome.isError) return { ok: true };
        return { ok: false, reason: boundedReason(outcome.text) || 'the app answered with an error' };
      } catch (error) {
        if (error instanceof McpAuthError) return { ok: false, reason: 'the app rejected it (HTTP ' + String(error.status) + ')' };
        return { ok: false, reason: boundedReason(error instanceof Error ? error.message : String(error)) || 'the app could not be reached' };
      } finally {
        await client.close().catch(() => undefined);
      }
    },

    async status(input) {
      const ownerId = resolveOwner(input.ownerId);
      const doc = await loadConnection(input.store, ownerId, input.connectionId);
      if (doc === null) return undefined;
      if (!isConnectionEnabled(doc) || doc.status === 'disconnected') return { state: 'disconnected' };
      if (doc.status === 'error') return { state: 'error' };
      let state: McpConnectionStatus | undefined;
      for (const key of byGroup.get(groupFor(ownerId, input.connectionId)) ?? []) {
        const session = sessions.get(key);
        if (session === undefined) continue;
        const status = session.client.getStatus();
        if (state === undefined || status.state === 'connected') state = status;
      }
      return state ?? { state: 'disconnected' };
    },
  };

  return manager;
}

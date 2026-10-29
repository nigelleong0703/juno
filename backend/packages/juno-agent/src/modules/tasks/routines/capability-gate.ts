/**
 * The capability gate of routines (BACKEND §3.6.1). A routine declares what it needs (`requires`). While the owner lacks
 * it the routine is `needs_setup`: it does not fire, and a `connect` request in the agent's chat asks the owner to connect
 * the app. When the connection appears the routine goes back to `active`, the request resolves and the agent is woken to
 * tell the owner; when a connection is lost an active routine goes the other way, once. The agent decides what to say;
 * the server never posts or sends anything for it.
 */
import type { Request, Routine, RoutineMissing } from '@agent-desktop/public-contracts';
import { patchWhen, sessionKey, type Enqueuer, type Store, type WakeEvent } from '../../../contracts/index.js';
import { docOwner } from '../../../execution/execution-owner.js';
import { resolveDeliveryConversation } from '../../../execution/harness/services/routineTimer-delivery.js';
import { emitAgentStatus } from '../../../execution/agent-status.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';
import { listAll } from '../../memory/util.js';
import { agentAppSettings, appProblem, problemsOf, usableApps } from '../../apps/agent-apps.js';
import { newId, nowIso } from '../../tools/util.js';
import { connectedCatalog, connectorOptions, humanize, missingRequirements, optionMet, satisfiedBy, type OwnerCapabilities } from './capabilities.js';
import type { RunCapabilities } from './runNote.js';

export interface GateDeps {
  store: Store;
  enqueuer: Enqueuer;
  /** What the platform itself offers (web search, a computer). */
  capabilities: RunCapabilities;
  /** Whether this agent can use the owner's paired Mac right now (allowed, and its link is up). Absent = no Mac. */
  macUsable?: (agentId: string) => Promise<boolean>;
}

/**
 * What `agentId` can use right now: the apps that are connected and turned on for it, plus the platform's tools and, when the agent
 * may use it, the Mac. Without an agent: the owner's connected apps. An app that is missing says why in `problemOf`.
 */
export async function haveForOwner(deps: Pick<GateDeps, 'store' | 'capabilities' | 'macUsable'>, ownerId: string, agentId?: string): Promise<OwnerCapabilities> {
  const connections = (await listAll(deps.store, 'connections')).filter((connection) => docOwner(connection) === ownerId);
  const mac = agentId !== undefined && deps.macUsable !== undefined && await deps.macUsable(agentId).catch(() => false);
  if (agentId === undefined) return { connectors: connectedCatalog(connections), ...deps.capabilities, mac };
  const settings = await agentAppSettings(deps.store, agentId);
  return { connectors: usableApps(connections, settings), ...deps.capabilities, mac, problemOf: (appId) => appProblem(connections, settings, appId) };
}

const isConnectFor = (request: Request, routineId: string): boolean => request.payload.kind === 'connect' && request.payload.routineId === routineId;

async function pendingConnectRequests(store: Store, routine: Routine, ownerId: string): Promise<Request[]> {
  const open = await listAll(store, 'requests', { where: { agentId: routine.agentId, status: 'pending' } });
  return open.filter((request) => request.kind === 'connect' && isConnectFor(request, routine.id) && docOwner(request) === ownerId);
}

/**
 * The card in the agent's chat asking the owner to connect what the routine needs, or undefined when nothing can be
 * connected (web search / a computer are the platform's). One open card per routine: an existing one is returned as is.
 */
export async function raiseConnectRequest(store: Store, routine: Routine, ownerId: string, missing: readonly RoutineMissing[], have?: Pick<OwnerCapabilities, 'problemOf'>): Promise<Request | undefined> {
  const appIds = [...new Set(missing.flatMap((need) => connectorOptions(need.options)))];
  if (appIds.length === 0) return undefined;
  const problems = problemsOf(appIds, have?.problemOf);
  const existing = (await pendingConnectRequests(store, routine, ownerId))[0];
  if (existing !== undefined) return existing;
  const label = [...new Set(missing.map((need) => need.label))].join(' and ');
  const conversationId = await resolveDeliveryConversation(routine, store);
  const request: Request & { ownerId: string } = {
    id: newId('req'),
    kind: 'connect',
    status: 'pending',
    title: `Connect ${label}`,
    summary: `Your routine "${routine.name}" needs ${label} before it can run.`,
    agentId: routine.agentId,
    ...(conversationId === undefined ? {} : { conversationId }),
    payload: { kind: 'connect', appIds, ...(problems === undefined ? {} : { problems }), label: label.slice(0, 160), routineId: routine.id },
    createdAt: nowIso(),
    ownerId,
  };
  await store.put('requests', request, conversationId === undefined ? {} : { conversationId });
  await store.emit({ type: 'request.created', request });
  if (conversationId !== undefined) {
    const item = { id: newId('itm'), conversationId, type: 'request' as const, requestId: request.id, at: nowIso() };
    await store.put('items', item, { conversationId });
    await emitItemAdded(store, conversationId, item);
  }
  await emitAgentStatus(store, routine.agentId);
  return request;
}

/** Closes the routine's open connect card: `approved` when it is satisfied, `expired` when the routine is gone. No wake: the agent is told by the capability wake. */
export async function resolveConnectRequests(store: Store, routine: Routine, ownerId: string, status: 'approved' | 'expired' = 'approved'): Promise<void> {
  for (const request of await pendingConnectRequests(store, routine, ownerId)) {
    const now = nowIso();
    // Only a card still open is closed: the owner may have answered it from the app meanwhile.
    const resolved = await patchWhen(store, 'requests', request.id, (current) => current.status === 'pending', {
      status, resolvedAt: now, decision: { by: 'auto', at: now, mode: 'auto', scope: 'once', note: status === 'approved' ? 'connected' : 'routine removed' },
    });
    if (resolved === undefined) continue;
    await store.emit({ type: 'request.resolved', request: resolved });
  }
  await emitAgentStatus(store, routine.agentId);
}

/** Closes the owner's open Connect cards that no routine owns (raised by the agent in chat) once one of their apps is connected. */
async function resolveChatConnectCards(deps: GateDeps, ownerId: string): Promise<void> {
  const open = (await listAll(deps.store, 'requests', { where: { status: 'pending' } })).filter((request) => request.kind === 'connect' && request.payload.kind === 'connect' && request.payload.routineId === undefined && docOwner(request) === ownerId);
  if (open.length === 0) return;
  for (const request of open) {
    if (request.payload.kind !== 'connect') continue;
    const have = await haveForOwner(deps, ownerId, request.agentId);
    const ready = request.payload.appIds.filter((id) => optionMet(id, have));
    if (ready.length === 0) continue;
    const now = nowIso();
    const resolved = await patchWhen(deps.store, 'requests', request.id, (current) => current.status === 'pending', { status: 'approved', resolvedAt: now, decision: { by: 'auto', at: now, mode: 'auto', scope: 'once', note: 'connected' } });
    if (resolved === undefined) continue;
    await deps.store.emit({ type: 'request.resolved', request: resolved });
    await emitAgentStatus(deps.store, request.agentId);
    await wakeForCard(deps, resolved, ownerId, ready.map((id) => have.connectors.get(id) ?? humanize(id)).join(' and '));
  }
}

/** Tells the agent in the card's chat that what it asked for is now available; it carries on with the owner's request. */
async function wakeForCard(deps: GateDeps, request: Request, ownerId: string, what: string): Promise<void> {
  if (request.conversationId === undefined) return;
  const at = nowIso();
  const wake: WakeEvent = {
    id: `wake_capability_ready_${request.id}`,
    ownerId,
    agentId: request.agentId,
    sessionKey: sessionKey(request.agentId, request.conversationId),
    conversationId: request.conversationId,
    kind: 'capability_ready',
    origin: { type: 'system', id: request.id, label: 'Connect card' },
    trusted: true,
    priority: 'background',
    payload: { connector: what, text: `${what} is now connected, as you asked in the Connect card. Carry on with what the user wanted; if you were waiting on it, continue now.` },
    at,
    status: 'accepted',
  };
  await deps.enqueuer.enqueue(wake).catch(() => undefined);
}

/** The system wake that tells the agent its routine became runnable or lost what it needs; a final reply is posted to the chat. */
async function wakeAgent(deps: GateDeps, routine: Routine, ownerId: string, kind: 'capability_ready' | 'capability_lost', connector: string): Promise<void> {
  const conversationId = await resolveDeliveryConversation(routine, deps.store);
  if (conversationId === undefined) return;
  const name = routine.name.replace(/\s+/g, ' ').trim();
  const text = kind === 'capability_ready'
    ? `${connector} is now connected; your routine '${name}' can run. Verify with one real call, then tell the user it's ready and offer a preview run.`
    : `${connector} is no longer connected, so your routine '${name}' is on hold and will not run until it is connected again. Tell the user in one short message that it needs ${connector}; a Connect card is in this chat. Do not do the routine's work now.`;
  const at = nowIso();
  const wake: WakeEvent = {
    id: `wake_${kind}_${routine.id}_${Date.parse(at)}`,
    ownerId,
    agentId: routine.agentId,
    sessionKey: sessionKey(routine.agentId, conversationId),
    conversationId,
    kind,
    origin: { type: 'system', id: routine.id, label: `Routine: ${name}` },
    trusted: true,
    priority: 'background',
    payload: { routineId: routine.id, connector, text },
    at,
    status: 'accepted',
  };
  await deps.enqueuer.enqueue(wake).catch(() => undefined);
}

export interface ReconcileResult {
  /** Routines that became runnable. */
  ready: string[];
  /** Routines that lost what they need. */
  lost: string[];
}

/**
 * Brings every routine of the owner that declared `requires` in line with what the owner has now (or just `routineId`).
 * `wake: false` (an edit by the owner) changes state and cards but does not wake the agent.
 */
export async function reconcileOwner(deps: GateDeps, ownerId: string, opts: { routineId?: string; wake?: boolean } = {}): Promise<ReconcileResult> {
  const result: ReconcileResult = { ready: [], lost: [] };
  if (opts.routineId === undefined) await resolveChatConnectCards(deps, ownerId);
  const routines = (await listAll(deps.store, 'routines')).filter((routine) => docOwner(routine) === ownerId && routine.enabled && (routine.requires?.length ?? 0) > 0 && (opts.routineId === undefined || routine.id === opts.routineId));
  if (routines.length === 0) return result;
  for (const routine of routines) {
    const have = await haveForOwner(deps, ownerId, routine.agentId);
    const missing = missingRequirements(routine.requires, have);
    if (routine.status === 'needs_setup' && missing.length === 0) {
      const updated = await deps.store.patch('routines', routine.id, { status: 'active', missing: undefined });
      await resolveConnectRequests(deps.store, routine, ownerId);
      await deps.enqueuer.scheduleRoutine(routine.id);
      await deps.store.emit({ type: 'routine.updated', routine: updated });
      if (opts.wake !== false) await wakeAgent(deps, routine, ownerId, 'capability_ready', satisfiedBy(routine.missing ?? [], have).join(' and ') || 'The app');
      result.ready.push(routine.id);
    } else if (routine.status === 'needs_setup' && JSON.stringify(routine.missing) !== JSON.stringify(missing)) {
      await deps.store.emit({ type: 'routine.updated', routine: await deps.store.patch('routines', routine.id, { missing }) });
    } else if (routine.status === 'active' && missing.length > 0) {
      const updated = await deps.store.patch('routines', routine.id, { status: 'needs_setup', missing });
      await raiseConnectRequest(deps.store, updated, ownerId, missing, have);
      await deps.enqueuer.scheduleRoutine(routine.id);
      await deps.store.emit({ type: 'routine.updated', routine: updated });
      if (opts.wake !== false) await wakeAgent(deps, routine, ownerId, 'capability_lost', missing.map((need) => need.label).join(' and '));
      result.lost.push(routine.id);
    }
  }
  return result;
}

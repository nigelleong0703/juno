/**
 * The Apps routes of the owner (BACKEND 10.18):
 *
 * GET    /v1/apps                                                        every app with what the owner added and who may use it
 * GET    /v1/apps/:id                                                    one app: its capability list and installs still being finished
 * POST   /v1/apps/:id/install                                            chat apps: install the Juno bot into a workspace, or add an agent's own bot; web apps: turn it on
 * DELETE /v1/apps/:id/installations/:installationId                      chat apps: remove a workspace or an own bot, or cancel a pending install
 * PUT    /v1/apps/:id/installations/:installationId/agents/:agentId      chat apps: enable or disable one agent in one workspace
 * PUT    /v1/agents/:agentId/apps/:appId                                 work and custom apps: on or off for one agent, and its Actions policy
 *
 * Adding and removing a work or custom app signs in at the provider, which the gateway (packages/api) serves because it owns the OAuth
 * callback: it answers `install` and `DELETE` for those apps itself and passes the chat apps on to this service.
 */
import { type Context, type Hono } from 'hono';
import { reviewAppToolsInputSchema, setAgentAppInputSchema, setWorkspaceAgentInputSchema, type AppInstallation, type InstallAppResponse, type ReviewAppToolsResponse } from '@agent-desktop/public-contracts';
import { jobAgent } from 'juno-agent/modules/memory/jobs/agent';
import { markToolsReviewed } from 'juno-agent/modules/mcp/tool-ledger';
import { setAgentApp } from 'juno-agent/modules/apps/agent-apps';
import { reconcileOwner } from 'juno-agent/modules/tasks/routines/capability-gate';
import { createLogger } from '@agent-desktop/log';
import { getOwnerEmail, getOwnerId } from '../auth.js';
import { NO_APPS } from 'juno-agent/modules/apps/catalog';
import { appDetail, chatInstallations, gatherAppFacts, isReachWebApp, listApps, pendingView, type AppsViewDeps } from '../apps/view.js';
import { addWebApp } from '../apps/web.js';
import { pendingRowId } from '../channels/pending.js';
import { unavailableMessage } from '../channels/registry.js';
import type { AgentdDeps } from './index.js';
import { canMutateAgent, docOwnerId } from './relationships.js';
import { gateDeps } from './routines.js';

const log = createLogger({ service: 'agentd' });

const error = (c: Context, status: 400 | 403 | 404 | 409 | 502, code: string, message: string): Response => c.json({ error: { code, message } }, status);

function viewOf(deps: AgentdDeps): AppsViewDeps {
  return { store: deps.store, channels: deps.channels, catalog: deps.appCatalog ?? NO_APPS, ...(deps.mcp === undefined ? {} : { mcp: deps.mcp }) };
}

/** The catalog row a route names, whatever its status. A chat app's `plugin` is the platform that carries it. */
const appRow = (deps: AgentdDeps, id: string) => (deps.appCatalog ?? NO_APPS).rows().find((candidate) => candidate.appId === id);

/** The owner's agent named by the route, or the refusal. */
async function mutableAgent(c: Context, deps: AgentdDeps, ownerId: string, agentId: string) {
  const agent = await deps.store.get('agents', agentId);
  if (agent === null) return { refusal: error(c, 404, 'AGENT_NOT_FOUND', 'Agent not found') };
  if (!canMutateAgent(agent, ownerId)) return { refusal: error(c, 403, 'AGENT_FORBIDDEN', 'Agent not shared with you') };
  return { agent };
}

/** An installation of a chat app the owner holds: the Juno bot in a workspace, or an agent's own bot. */
async function chatInstallation(deps: AgentdDeps, ownerId: string, kind: string, installationId: string) {
  const shared = await deps.store.get('channelInstallations', installationId);
  if (shared !== null && shared.kind === kind && docOwnerId(shared) === ownerId) return { shared };
  const own = await deps.store.get('channels', installationId);
  if (own !== null && own.kind === kind && own.installationId === undefined && docOwnerId(own) === ownerId) return { own };
  return {};
}

export function registerApps(app: Hono, deps: AgentdDeps): void {
  app.get('/v1/apps', async (c) => c.json({ items: await listApps(viewOf(deps), getOwnerId(c)) }));

  app.get('/v1/apps/:id', async (c) => {
    const detail = await appDetail(viewOf(deps), getOwnerId(c), c.req.param('id'));
    return detail === undefined ? error(c, 404, 'APP_NOT_FOUND', 'No such app') : c.json(detail);
  });

  // The owner has looked at the tools this app added or changed since they last did (the flagged capabilities): they go back to the normal rules.
  app.post('/v1/apps/:id/tools/review', async (c) => {
    const ownerId = getOwnerId(c);
    const parsed = reviewAppToolsInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return error(c, 400, 'VALIDATION_ERROR', 'The body must be {"tools"?: string[]}');
    const target = (await listApps(viewOf(deps), ownerId)).find((candidate) => candidate.id === c.req.param('id'));
    if (target === undefined) return error(c, 404, 'APP_NOT_FOUND', 'No such app');
    if (target.category === 'chat' || target.category === 'web') return error(c, 400, 'NO_TOOLS', target.name + ' has no tools to review');
    const reviewed = new Set<string>();
    for (const installation of target.installations) for (const name of await markToolsReviewed(deps.store, installation.id, parsed.data.tools)) reviewed.add(name);
    return c.json<ReviewAppToolsResponse>({ reviewed: [...reviewed] });
  });

  // A work or custom app, for one agent. Removing the last use of an app a routine needs holds that routine (the capability gate).
  app.put('/v1/agents/:agentId/apps/:appId', async (c) => {
    const ownerId = getOwnerId(c);
    const parsed = setAgentAppInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, 'VALIDATION_ERROR', 'The body must be {"enabled": boolean, "actionsPolicy"?: "ask" | "allow" | "off"}');
    const { agent, refusal } = await mutableAgent(c, deps, ownerId, c.req.param('agentId'));
    if (agent === undefined) return refusal;
    const target = (await listApps(viewOf(deps), ownerId)).find((candidate) => candidate.id === c.req.param('appId'));
    if (target === undefined) return error(c, 404, 'APP_NOT_FOUND', 'No such app');
    if (target.category === 'chat') return error(c, 400, 'CHAT_APP', 'A chat app is enabled per workspace: PUT /v1/apps/' + target.id + '/installations/:installationId/agents/' + agent.id);
    if (target.installations.length === 0) return error(c, 409, 'APP_NOT_ADDED', 'Add ' + target.name + ' on the Apps page first');
    const row = await setAgentApp(deps.store, { ownerId, agentId: agent.id, appId: target.id, enabled: parsed.data.enabled, ...(parsed.data.actionsPolicy === undefined ? {} : { actionsPolicy: parsed.data.actionsPolicy }) });
    await reconcileOwner(gateDeps(deps), ownerId).catch((err: unknown) => log.warn({ err }, 'capability recheck after an app change failed'));
    return c.json({ agentId: row.agentId, appId: row.appId, enabled: row.enabled, actionsPolicy: row.actionsPolicy });
  });

  app.post('/v1/apps/:id/install', async (c) => {
    const ownerId = getOwnerId(c);
    const appId = c.req.param('id');
    const chat = appRow(deps, appId);
    // An app that is hidden or retired is not offered to new installs any more.
    if (chat === undefined || chat.status !== 'listed') return error(c, 404, 'APP_NOT_FOUND', 'No such app');
    if (chat.category === 'web') {
      // Adding a web app only turns it on; a sign-in the app needs is asked for on the agent's computer when a read needs it.
      if (!isReachWebApp(chat)) return error(c, 400, 'APP_NOT_SUPPORTED_YET', chat.interface.displayName + ' cannot be added yet');
      const installation = await addWebApp(deps.store, ownerId, chat);
      await reconcileOwner(gateDeps(deps), ownerId).catch((err: unknown) => log.warn({ err }, 'capability recheck after an app change failed'));
      return c.json<InstallAppResponse>({ appId: chat.appId, installation, pending: null, openUrl: null }, 201);
    }
    if (chat.category !== 'chat') return error(c, 400, 'NOT_A_CHAT_APP', 'Only the chat apps are added through this service; ' + appId + ' is added through the gateway');
    const kind = chat.binding?.plugin ?? chat.appId;
    const registration = deps.channels.get(kind);
    if (registration === undefined) return error(c, 400, 'UNSUPPORTED_CHANNEL', unavailableMessage(kind));
    const body: unknown = await c.req.json().catch(() => null);
    const record: Record<string, unknown> = typeof body === 'object' && body !== null && !Array.isArray(body) ? { ...body } : {};
    const named = typeof record['agentId'] === 'string' ? record['agentId'] : undefined;
    delete record['agentId'];
    const workspace = record['mode'] === 'oauth';
    // The Juno bot goes into a workspace for the owner, with their main agent enabled first; an agent's own bot belongs to the agent named.
    const agentId = named ?? (workspace ? (await jobAgent(deps.store, ownerId))?.agent.id : undefined);
    if (agentId === undefined) return error(c, 400, workspace ? 'NO_AGENT' : 'AGENT_REQUIRED', workspace ? 'Create an agent first' : 'agentId is required for an agent\'s own bot');
    const { refusal } = await mutableAgent(c, deps, ownerId, agentId);
    if (refusal !== undefined) return refusal;
    const email = getOwnerEmail(c);
    const outcome = await registration.connector.connect({ deps, ownerId, agentId, body: record, ...(email === undefined ? {} : { ownerEmail: email }) });
    if (!outcome.ok) return error(c, outcome.status, outcome.code, outcome.message);
    const facts = await gatherAppFacts(viewOf(deps), ownerId);
    const installed = (row: { id: string }): AppInstallation | null => chatInstallations(facts, kind, chat.interface.displayName, chat.appId).find((installation) => installation.id === row.id) ?? null;
    if ('pending' in outcome) {
      return c.json<InstallAppResponse>({ appId: chat.appId, installation: null, pending: pendingView(outcome.pending) ?? null, openUrl: outcome.installUrl ?? outcome.createUrl ?? outcome.verificationUrl ?? null }, 202);
    }
    return c.json<InstallAppResponse>({
      appId: chat.appId,
      installation: installed(outcome.row),
      pending: null,
      openUrl: outcome.openUrl ?? outcome.installUrl ?? null,
    }, 201);
  });

  app.delete('/v1/apps/:id/installations/:installationId', async (c) => {
    const ownerId = getOwnerId(c);
    const appId = c.req.param('id');
    const installationId = c.req.param('installationId');
    const chat = appRow(deps, appId);
    if (chat?.category !== 'chat') return error(c, 400, 'NOT_A_CHAT_APP', 'Only the chat apps are removed through this service; ' + appId + ' is removed through the gateway');
    const kind = chat.binding?.plugin ?? chat.appId;
    const registration = deps.channels.get(kind);
    // A request Juno was still finishing: cancelling it is deleting it.
    const waiting = await deps.store.get('channels', pendingRowId(installationId));
    if (waiting !== null && docOwnerId(waiting) === ownerId && waiting.pending?.platform === kind) {
      await deps.store.delete('channels', waiting.id);
      return c.body(null, 204);
    }
    const found = await chatInstallation(deps, ownerId, kind, installationId);
    if (found.shared === undefined && found.own === undefined) return error(c, 404, 'INSTALLATION_NOT_FOUND', 'No such installation');
    // With the platform's plugin off there is no connector to clean up with; the rows are still removed.
    if (found.own !== undefined) {
      await registration?.connector.disconnect(deps, found.own);
      await deps.store.delete('channels', found.own.id);
      return c.body(null, 204);
    }
    const bindings = (await deps.store.list('channels', { where: { kind }, limit: 500 })).items.filter((row) => row.installationId === found.shared?.id);
    for (const row of bindings) {
      await registration?.connector.disconnect(deps, row);
      await deps.store.delete('channels', row.id);
    }
    await deps.store.delete('channelInstallations', installationId);
    return c.body(null, 204);
  });

  app.put('/v1/apps/:id/installations/:installationId/agents/:agentId', async (c) => {
    const ownerId = getOwnerId(c);
    const parsed = setWorkspaceAgentInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, 'VALIDATION_ERROR', 'The body must be {"enabled": boolean}');
    const chat = appRow(deps, c.req.param('id'));
    if (chat?.category !== 'chat' || chat.status === 'retired') return error(c, 400, 'NOT_A_CHAT_APP', c.req.param('id') + ' is not a chat app');
    const kind = chat.binding?.plugin ?? chat.appId;
    const registration = deps.channels.get(kind);
    if (registration === undefined) return error(c, 400, 'UNSUPPORTED_CHANNEL', unavailableMessage(kind));
    const { agent, refusal } = await mutableAgent(c, deps, ownerId, c.req.param('agentId'));
    if (agent === undefined) return refusal;
    const found = await chatInstallation(deps, ownerId, kind, c.req.param('installationId'));
    if (found.own !== undefined) return error(c, 400, 'OWN_BOT', 'This bot belongs to one agent; remove the bot to stop using it');
    const installation = found.shared;
    if (installation === undefined || registration.workspace === undefined) return error(c, 404, 'INSTALLATION_NOT_FOUND', 'No such workspace installation');
    const existing = (await deps.store.list('channels', { where: { agentId: agent.id, kind }, limit: 100 })).items.find((row) => row.installationId === installation.id);
    if (parsed.data.enabled) {
      await registration.workspace.enable(deps, installation, agent);
    } else if (existing !== undefined) {
      await registration.connector.disconnect(deps, existing);
      await deps.store.delete('channels', existing.id);
    }
    const facts = await gatherAppFacts(viewOf(deps), ownerId);
    return c.json({ items: chatInstallations(facts, kind, chat.interface.displayName, chat.appId).find((candidate) => candidate.id === installation.id)?.agents ?? [] });
  });
}

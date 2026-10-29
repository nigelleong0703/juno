/**
 * The shared Juno app of a workspace platform (Slack, Discord): one bot for everyone, installed into a workspace / server once, then
 * enabled agent by agent (`ChannelRegistration.workspace`). The install is the same walk on both: the owner asks for an install link
 * (a pending row carries the `state`), opens it on the platform, and the platform's redirect comes back with that state. This is the
 * part they share; what each platform does with the redirect (the OAuth code exchange, the audit log, the user group or role) stays
 * in its own file.
 */
import type { Context } from 'hono';
import type { ChannelRow } from '@agent-desktop/contracts';
import { getOwnerId } from '../auth.js';
import { docOwnerId } from '../routes/relationships.js';
import type { AgentdDeps } from '../routes/index.js';
import type { ConnectContext, ConnectOutcome } from './connect.js';
import { createPending, loadPending, settlePending } from './pending.js';
import { channelsPublicUrl } from './public-url.js';

const PENDING_TTL_MS = 30 * 60_000;

export const sharedAppPage = (message: string): string =>
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Juno</title>' +
  '<body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem"><p>' + message + '</p></body>';

export interface SharedAppSpec<Config> {
  /** The platform kind of the pending row and the installation. */
  platform: 'slack' | 'discord';
  /** The shared app's credentials from the environment; undefined when it is not set up on this server. */
  config(): Config | undefined;
  notConfiguredMessage: string;
  publicUrlMessage: string;
  /** The link on the platform that installs the app; `state` comes back on the redirect. */
  installUrl(config: Config, publicUrl: string, state: string): string;
}

/** `POST /v1/apps/<platform>/install {mode:'oauth'}`: the link that installs the Juno app into a workspace / server (another one, or a reinstall, is the same call). `agentId` is the agent enabled there first. */
export async function startSharedInstall<Config>({ deps, ownerId, agentId }: ConnectContext, spec: SharedAppSpec<Config>): Promise<ConnectOutcome> {
  const config = spec.config();
  if (config === undefined) return { ok: false, status: 400, code: 'SHARED_APP_NOT_CONFIGURED', message: spec.notConfiguredMessage };
  const agent = await deps.store.get('agents', agentId);
  if (!agent) return { ok: false, status: 400, code: 'AGENT_NOT_FOUND', message: 'Agent not found' };
  const publicUrl = channelsPublicUrl();
  if (publicUrl === undefined) return { ok: false, status: 400, code: 'PUBLIC_URL_REQUIRED', message: spec.publicUrlMessage };
  const pending = await createPending(deps.store, { ownerId, agentId, ttlMs: PENDING_TTL_MS, data: { platform: spec.platform, shared: true } });
  const installUrl = spec.installUrl(config, publicUrl, pending.channelId);
  const withUrl = await deps.store.patch('channels', pending.id, { pending: { ...(pending.pending as NonNullable<ChannelRow['pending']>), installUrl } });
  return { ok: true, pending: withUrl, installUrl };
}

/** The pending install a redirect belongs to (by its `state`), or the page to answer with when it is not valid, expired or already used. */
export async function openSharedInstall(c: Context, deps: AgentdDeps, platform: SharedAppSpec<unknown>['platform']): Promise<{ state: string; request: ChannelRow } | Response> {
  const ownerId = getOwnerId(c);
  const state = c.req.query('state') ?? '';
  const request = await loadPending(deps.store, state);
  if (!request?.pending || request.pending.platform !== platform || request.pending.shared !== true || docOwnerId(request) !== ownerId) {
    return c.html(sharedAppPage('This install link is not valid.'), 404);
  }
  if (request.pending.state !== 'pending') return c.html(sharedAppPage('This install link has expired or was already used.'), 410);
  return { state, request };
}

/** The install failed or was cancelled: the pending row says so and the owner gets a page. */
export async function failSharedInstall(c: Context, deps: AgentdDeps, state: string, error: string, message: string, status: 400 | 409 | 500 | 502): Promise<Response> {
  await settlePending(deps.store, state, { state: 'failed', error });
  return c.html(sharedAppPage(message), status);
}

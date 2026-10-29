/**
 * Platform channel ingress (CH1): the agent's own identity on a messaging platform.
 *
 * POST /v1/channels/:kind/:channelId/events is the only /v1 channel route open to callers
 * without a login session (Telegram's update webhook). It is registered before the session
 * middleware and is the single place the platform secret is verified: the channel row is loaded,
 * the presented secret is compared with the stored hash, and only then is the request forwarded
 * to agentd as the channel's owner. An unknown channel, a missing secret and a wrong secret all
 * answer the same 401.
 */
import type { Context, Hono } from 'hono';
import { channelRowId, type Store } from '@agent-desktop/contracts';
import { docOwnerId } from '@agent-desktop/db';
import { forwardToAgentd, type ForwardDeps } from '../proxy.js';
import { channelSecretMatches, presentedChannelSecret, sharedSlackVerifier } from '../modules/channels.js';

async function forwardToInstallation(c: Context, deps: { store: Store; forward: ForwardDeps }, teamId: unknown): Promise<Response | undefined> {
  const installation = typeof teamId === 'string' ? await deps.store.get('channelInstallations', 'slack:' + teamId) : null;
  const ownerId = docOwnerId(installation);
  return ownerId === undefined ? undefined : forwardToAgentd(c, ownerId, deps.forward);
}

export function registerChannelIngress(app: Hono, deps: { store: Store; forward: ForwardDeps }): void {
  // Slack's install redirect (CH7) is a browser visit with no session. The unguessable `state` names the
  // pending request Juno created, and with it the owner the call is forwarded as; anything else is a 404.
  app.get('/v1/channels/slack/oauth/callback', async (c) => {
    const row = await deps.store.get('channels', channelRowId('pending', c.req.query('state') ?? ''));
    const ownerId = docOwnerId(row);
    if (!row || ownerId === undefined || row.pending?.platform !== 'slack') {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown install link' } }, 404);
    }
    return forwardToAgentd(c, ownerId, deps.forward);
  });

  // The shared Juno Slack app: one events URL for every workspace, signed with the app's own secret. The workspace in the body
  // names the installation, and with it the owner the call is forwarded as. Unknown workspaces get the same 401 as a bad signature.
  app.get('/v1/channels/discord/oauth/callback', async (c) => {
    const row = await deps.store.get('channels', channelRowId('pending', c.req.query('state') ?? ''));
    const ownerId = docOwnerId(row);
    if (!row || ownerId === undefined || row.pending?.platform !== 'discord') {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown install link' } }, 404);
    }
    return forwardToAgentd(c, ownerId, deps.forward);
  });

  app.post('/v1/channels/slack/events', async (c) => {
    const unauthorized = c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing channel secret' } }, 401);
    if (!(await sharedSlackVerifier(c))) return unauthorized;
    const body: unknown = await c.req.raw.clone().json().catch(() => null);
    const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (record['type'] === 'url_verification') return c.json({ challenge: record['challenge'] }, 200);
    return (await forwardToInstallation(c, deps, record['team_id'])) ?? unauthorized;
  });

  app.post('/v1/channels/slack/interactions', async (c) => {
    const unauthorized = c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing channel secret' } }, 401);
    if (!(await sharedSlackVerifier(c))) return unauthorized;
    const form = new URLSearchParams(await c.req.raw.clone().text());
    let team: unknown;
    try {
      const payload: unknown = JSON.parse(form.get('payload') ?? '{}');
      const teamField = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)['team'] : undefined;
      team = typeof teamField === 'object' && teamField !== null ? (teamField as Record<string, unknown>)['id'] : undefined;
    } catch {
      team = undefined;
    }
    return (await forwardToInstallation(c, deps, team)) ?? unauthorized;
  });

  app.post('/v1/channels/:kind/:channelId/events', async (c) => {
    const kind = c.req.param('kind');
    const row = await deps.store.get('channels', channelRowId(kind, c.req.param('channelId')));
    const ownerId = docOwnerId(row);
    if (!row || ownerId === undefined || !channelSecretMatches(presentedChannelSecret(c.req, c.req.query('key')) ?? '', row.secretHashHex)) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing channel secret' } }, 401);
    }
    return forwardToAgentd(c, ownerId, deps.forward);
  });
}

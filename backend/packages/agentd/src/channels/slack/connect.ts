/**
 * Slack connector: the shared Juno app only (`{mode:'oauth'}`, see shared.ts). Juno has no per-agent Slack apps any more: nobody
 * creates an app, pastes a token or a signing secret.
 */
import type { ChannelConnector } from '../connect.js';
import { startSharedInstall } from '../shared-app.js';
import { disconnectSlackShared, slackSharedApp } from './shared.js';

export const slackConnector: ChannelConnector = {
  async connect(ctx) {
    const mode = typeof ctx.body === 'object' && ctx.body !== null ? (ctx.body as Record<string, unknown>)['mode'] : undefined;
    if (mode !== 'oauth') return { ok: false, status: 400, code: 'UNSUPPORTED_CONNECT_MODE', message: "Slack connects through the shared Juno app: send {mode:'oauth'}" };
    return startSharedInstall(ctx, slackSharedApp);
  },

  // On the shared app the agent's user group is switched off.
  async disconnect(deps, row) {
    if (row.installationId !== undefined) await disconnectSlackShared(deps, row);
  },
};

/**
 * Channel connectors (CH2): what a platform needs to connect and disconnect an identity. Each platform plugin registers its
 * own (`ChannelRegistration.connector`); the route finds it through the ChannelRegistry.
 *
 * The route plumbing in routes/apps.ts (`POST /v1/apps/:id/install`: auth, agent ownership, response shape) is shared;
 * a platform adds its own connector in its plugin and nothing else in the route. A connector validates the
 * platform credential, stores the `channels` row (credential sealed, secrets only as hashes) and returns
 * the link the owner opens to bind their platform account.
 */
import type { ChannelRow } from '@agent-desktop/contracts';
import type { AgentdDeps } from '../routes/index.js';

/** What the owner sees when a shared Slack workspace cannot give an agent its own @name (its handle status is `needs_paid_plan`). */
export const FREE_PLAN_MESSAGE = "Free Slack can't give each agent its own @name; upgrade to Pro and it turns on automatically.";

export interface ConnectContext {
  deps: AgentdDeps;
  ownerId: string;
  agentId: string;
  /** The owner's Juno account email, when the gateway knows it; used to find the owner on the platform. */
  ownerEmail?: string;
  body: unknown;
}

export type ConnectOutcome =
  | {
      ok: true;
      row: ChannelRow;
      /** Telegram (manual token): the link the owner taps to open the bot; the bind token rides in it. */
      openUrl?: string;
      /** Where the owner adds the bot to a server / workspace (Discord invite, Slack install). */
      installUrl?: string;
    }
  | {
      ok: true;
      /** An identity Juno is creating (CH7): the owner confirms on the platform, then polls `pending`. */
      pending: ChannelRow;
      createUrl?: string;
      verificationUrl?: string;
      installUrl?: string;
    }
  | { ok: false; status: 400 | 409 | 502; code: string; message: string };

export interface ChannelConnector {
  connect(ctx: ConnectContext): Promise<ConnectOutcome>;
  /** Best-effort platform cleanup before the row is deleted; must not throw. */
  disconnect(deps: AgentdDeps, row: ChannelRow): Promise<void>;
}

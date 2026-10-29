/**
 * Channel runners (CH2): background work a platform needs while agentd is up.
 *
 * A platform's own runners (Telegram's long poll, the Feishu socket, the Discord gateways) come with its plugin
 * (`ChannelRegistration.runners`); boot starts them once all plugins have loaded. The pending-request sweeper belongs to
 * no platform and always runs.
 */
import type { BlobStore, Enqueuer, Store } from '@agent-desktop/contracts';
import type { Identity } from '@agent-desktop/memory-graph/identity';
import type { HomeComputer } from 'juno-agent/computer';
import { pendingSweeper } from './pending.js';
import type { ChannelRegistry } from './registry.js';

export interface ChannelRunnerContext {
  /** The unscoped store: runners read channel rows across owners and admit events as each row's owner. */
  store: Store;
  enqueuer: Enqueuer;
  /** The registered platforms; admission refuses events of a platform that is not among them. */
  channels: ChannelRegistry;
  channelFetch?: typeof fetch;
  /** The blob store platform files are kept in (see channels/files.ts); absent, the files of a message are not stored. */
  blobs?: BlobStore;
  /** The identity graph; absent when there is no Postgres, and speakers are then not recorded. */
  identity?: Identity;
  /** The agents' home files: live meetings append their record there. */
  home?: HomeComputer;
}

export interface ChannelRunner {
  /** Starts the runner (or does nothing when it is not needed) and returns its stop function. */
  start(ctx: ChannelRunnerContext): () => void;
}

export function startChannelRunners(ctx: ChannelRunnerContext): () => void {
  const runners = [...ctx.channels.all().flatMap((registration) => registration.runners ?? []), pendingSweeper];
  const stops = runners.map((runner) => runner.start(ctx));
  return () => {
    for (const stop of stops) stop();
  };
}

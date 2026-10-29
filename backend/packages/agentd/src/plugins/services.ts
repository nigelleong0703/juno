import type { Enqueuer, Store } from '@agent-desktop/contracts';
import type { ComputerClient } from 'juno-agent/computer';
import type { ComputerdClient } from '../computerd.js';
import type { Plugin } from './host.js';

/**
 * The core services agentd boot offers to plugins (boot provides them before any plugin loads). A plugin names the ones
 * it needs in `inject`. `computer` is present always; its value is undefined when no sandbox backend is configured.
 */
export interface Services {
  store: Store;
  enqueuer: Enqueuer;
  computerd: ComputerdClient;
  computer: ComputerClient | undefined;
}

export type AgentdPlugin<C = undefined> = Plugin<Services, C>;

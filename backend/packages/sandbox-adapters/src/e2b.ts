/**
 * The E2B provider (BACKEND §7.1, §7.11): the linked provider over the E2B driver. E2B only creates, pauses, resumes and
 * kills the sandbox; commands, files and the VNC and Spaces byte streams go through the computer link (`juno-link` in the
 * sandbox dials out to computerd), so no E2B public port or `commands`/`files` call is used after boot.
 */
import type { LinkHub } from './link-hub.js';
import { createE2bDriver, type E2bDriverOptions } from './e2b-driver.js';
import { createLinkedProvider, type StartedContext } from './linked-provider.js';
import type { ComputerProvider } from './provider.js';
import type { ComputerStorage } from './storage.js';

export { idleWindowMs } from './driver.js';

export interface E2bProviderOptions extends E2bDriverOptions {
  /** Durable /juno, /workspace and browser profiles (BACKEND 7.10): mounted as root right after the sandbox is created, for this owner. */
  storage?: { ownerId: string; storage: ComputerStorage };
  /** The owner whose computer this is (also used when no storage is configured). */
  ownerId: string;
  hub: LinkHub;
  /** `wss://computerd.example/v1/computer-link`: what the sandbox dials. */
  linkUrl: string;
  onStarted?: (context: StartedContext) => Promise<void>;
  linkWaitMs?: number;
}

export function createE2bProvider(options: E2bProviderOptions): ComputerProvider & { dispose(): void } {
  return createLinkedProvider({
    driver: createE2bDriver(options),
    hub: options.hub,
    linkUrl: options.linkUrl,
    ownerId: options.ownerId,
    image: options.template,
    ...(options.storage ? { storage: options.storage.storage } : {}),
    ...(options.onStarted ? { onStarted: options.onStarted } : {}),
    ...(options.linkWaitMs === undefined ? {} : { linkWaitMs: options.linkWaitMs }),
  });
}

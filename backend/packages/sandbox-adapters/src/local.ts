/**
 * The local Docker provider (development): the linked provider over the Docker driver. The container publishes no port;
 * `juno-link` inside it dials computerd at `host.docker.internal`, and every command, file and stream goes through that link
 * (BACKEND §7.11).
 */
import { DEFAULT_LOCAL_IMAGE, createDockerDriver } from './docker-driver.js';
import type { DockerCli } from './docker-cli.js';
import type { LinkHub } from './link-hub.js';
import { createLinkedProvider, type StartedContext } from './linked-provider.js';
import type { ComputerProvider } from './provider.js';
import type { ComputerStorage } from './storage.js';

export { DEFAULT_LOCAL_IMAGE, IDLE_LABEL, LIFETIME_LABEL } from './docker-driver.js';

export interface LocalProviderOptions {
  ownerId: string;
  /** Container image; defaults to the verified local desktop image. */
  image?: string;
  /** Overridden in tests with an in-memory fake; the real docker CLI otherwise. */
  docker?: DockerCli;
  /** Where /juno, /workspace and browser profiles live (BACKEND 7.10); absent keeps them on the container's own disk. */
  storage?: ComputerStorage;
  /** computerd's link hub and the URL a container dials (`ws://host.docker.internal:<port>/v1/computer-link`). */
  hub: LinkHub;
  linkUrl: string;
  onStarted?: (context: StartedContext) => Promise<void>;
  linkWaitMs?: number;
}

export function createLocalProvider(options: LocalProviderOptions): ComputerProvider & { dispose(): void } {
  return createLinkedProvider({
    driver: createDockerDriver({ ownerId: options.ownerId, ...(options.docker ? { docker: options.docker } : {}), ...(options.storage ? { storage: options.storage } : {}) }),
    hub: options.hub,
    linkUrl: options.linkUrl,
    ownerId: options.ownerId,
    image: options.image ?? DEFAULT_LOCAL_IMAGE,
    ...(options.storage ? { storage: options.storage } : {}),
    ...(options.onStarted ? { onStarted: options.onStarted } : {}),
    ...(options.linkWaitMs === undefined ? {} : { linkWaitMs: options.linkWaitMs }),
  });
}

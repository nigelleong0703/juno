/**
 * The E2B platform as a `LifecycleDriver` (BACKEND §7.11): create, pause (suspend), connect (resume), kill, and the sandbox
 * timeout. It never runs a command or reads a file in the sandbox, and never asks for a public port: commands, files and
 * streams go through the computer link (`juno-link`, started by the template and dialling out to computerd).
 *
 * The one exception is at create. E2B can set environment variables for processes it starts itself but not for the
 * template's start command, and it has no file injection at create, so the driver writes the link config (`/etc/juno/link.json`,
 * as root, in a root-only directory) with one `files.write` right after the sandbox exists. That is the only sandbox
 * call after boot; the daemon waits for the file and re-reads it on every connection attempt.
 *
 * The self-hosted E2B server needs `apiUrl` AND `sandboxUrl` together; with only `sandboxUrl` the SDK silently calls the
 * cloud API, so both are passed on every call.
 */
import { NotFoundError, Sandbox } from '@e2b/desktop';
import type { LifecycleDriver, MachineState } from './driver.js';
import { idleWindowMs } from './driver.js';
import { StaleComputerError, unavailable } from './errors.js';
import { parseResolution } from './types.js';

export { idleWindowMs } from './driver.js';

/** Where the daemon looks for its config when the environment has none (juno-link/src/main.ts). */
export const LINK_CONFIG_FILE = '/etc/juno/link.json';

export interface E2bDriverOptions {
  template: string;
  apiKey: string;
  apiUrl: string;
  sandboxUrl: string;
  /** Hard ceiling for the sandbox lifetime, and the fallback idle window when `idlePauseMinutes` is unset (self-host max is 1h). */
  timeoutMs: number;
  /** Idle window in minutes; the computer is suspended by the provider and, as a net, by E2B's own timeout. 0 keeps the whole `timeoutMs`. */
  idlePauseMinutes?: number;
}

/** The SDK connection options, omitting empty fields so the SDK's own defaults apply. */
export function connectionOptions(opts: Pick<E2bDriverOptions, 'apiKey' | 'apiUrl' | 'sandboxUrl'>) {
  return {
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}),
    ...(opts.sandboxUrl ? { sandboxUrl: opts.sandboxUrl } : {}),
  };
}

export function createE2bDriver(opts: E2bDriverOptions): LifecycleDriver {
  const connection = connectionOptions(opts);
  const defaultWindow = idleWindowMs(opts.idlePauseMinutes, opts.timeoutMs);

  return {
    kind: 'e2b',

    async create(spec) {
      try {
        const { width, height } = parseResolution(spec.host.resolution);
        const window = idleWindowMs(spec.host.idlePauseMinutes ?? opts.idlePauseMinutes, opts.timeoutMs);
        const sandbox = await Sandbox.create(spec.image, {
          ...connection,
          resolution: [width, height],
          timeoutMs: window,
          // E2B pauses the sandbox itself if the provider never does (a computerd that died); it resumes on traffic.
          lifecycle: { onTimeout: 'pause', autoResume: true },
          envs: { ...spec.env },
          metadata: { linkId: spec.link.id },
        });
        try {
          await sandbox.files.write(LINK_CONFIG_FILE, JSON.stringify(spec.link), { user: 'root' });
        } catch (error) {
          await sandbox.kill().catch(() => undefined);
          throw error;
        }
        return { sandboxId: sandbox.sandboxId, template: spec.image };
      } catch (error) {
        throw unavailable(`could not create sandbox: ${message(error)}`);
      }
    },

    async status(binding): Promise<MachineState> {
      try {
        const info = await Sandbox.getInfo(binding.sandboxId, connection);
        return info.state === 'running' ? 'running' : 'suspended';
      } catch (error) {
        // Only "not found" proves the sandbox is gone; an API outage must not make the platform replace a healthy computer.
        if (error instanceof NotFoundError) return 'gone';
        throw unavailable(`could not read sandbox ${binding.sandboxId}: ${message(error)}`);
      }
    },

    async start(binding) {
      // E2B has no "stopped": a killed sandbox is gone, so the only start is resuming a paused one.
      await this.resume?.(binding, new AbortController().signal);
    },

    async resume(binding) {
      try {
        await Sandbox.connect(binding.sandboxId, connection);
      } catch (error) {
        // Expired or killed rather than paused: computerd archives the binding and creates a new one on the same durable storage.
        if (error instanceof NotFoundError) throw new StaleComputerError('gone', `sandbox ${binding.sandboxId} no longer exists`, binding.sandboxId);
        throw unavailable(`could not resume sandbox ${binding.sandboxId}: ${message(error)}`);
      }
    },

    async suspend(binding) {
      try {
        await Sandbox.pause(binding.sandboxId, connection);
      } catch (error) {
        throw unavailable(`could not pause sandbox ${binding.sandboxId}: ${message(error)}`);
      }
    },

    async stop(binding) {
      await Sandbox.kill(binding.sandboxId, connection);
    },

    async destroy(binding) {
      await Sandbox.kill(binding.sandboxId, connection);
    },

    async keepAlive(binding, windowMs) {
      await Sandbox.setTimeout(binding.sandboxId, windowMs || defaultWindow, connection).catch(() => undefined);
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The E2B platform as a `LifecycleDriver` (BACKEND §7.11): create, pause (suspend), connect (resume), kill, and the sandbox
 * timeout. It never runs a command or reads a file in the sandbox, and never asks for a public port: commands, files and
 * streams go through the computer link (`juno-link`, dialling out to computerd).
 *
 * The one exception is at create. The template's start command runs as the template user (`agent`), not root, and E2B can
 * only set environment variables for processes it starts itself, so the driver starts the daemon as root with one
 * background `commands.run` right after the sandbox exists, the link config being that process's environment. That is
 * the only sandbox call after boot.
 *
 * The self-hosted E2B server needs `apiUrl` AND `sandboxUrl` together; with only `sandboxUrl` the SDK silently calls the
 * cloud API, so both are passed on every call.
 */
import { NotFoundError, Sandbox } from '@e2b/desktop';
import type { LifecycleDriver, MachineState } from './driver.js';
import { idleWindowMs } from './driver.js';
import { nativeDenyOut } from './egress.js';
import { StaleComputerError, unavailable } from './errors.js';
import { parseResolution } from './types.js';

export { idleWindowMs } from './driver.js';

/** The daemon binary the template ships (the template does not start it). */
const LINK_DAEMON = "setsid -f sh -c 'exec /usr/local/bin/juno-link >>/var/log/juno-link.log 2>&1' >/dev/null 2>&1 </dev/null";

export interface E2bDriverOptions {
  template: string;
  apiKey: string;
  apiUrl: string;
  sandboxUrl: string;
  /** Hard ceiling for the sandbox lifetime, and the fallback idle window when `idlePauseMinutes` is unset (self-host max is 1h). */
  timeoutMs: number;
  /** Idle window in minutes; the computer is suspended by the provider and, as a net, by E2B's own timeout. 0 keeps the whole `timeoutMs`. */
  idlePauseMinutes?: number;
  /** `wss://computerd.example/v1/computer-link`: what the sandbox dials; its port is where a resumed computer's dead connection is cut. */
  linkUrl: string;
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
  const link = new URL(opts.linkUrl);
  const linkPort = Number(link.port || (link.protocol === 'wss:' ? 443 : 80));
  const defaultWindow = idleWindowMs(opts.idlePauseMinutes, opts.timeoutMs);
  // E2B cloud also filters egress outside the VM, an outer layer on top of the agents' namespaces (BACKEND §7.9a). A self-hosted
  // server (`apiUrl`) is not known to support it.
  const outerFilter = opts.apiUrl === '';
  const network = { denyOut: nativeDenyOut() };
  /**
   * E2B's own timeout is only the net for a computerd that died, so it runs a minute behind the provider's idle timer: the provider's
   * check for background jobs (linked-provider `idleExpired`) must get to answer before E2B pauses the sandbox under a running job.
   */
  const net = (window: number): number => (window < opts.timeoutMs ? Math.min(window + 60_000, opts.timeoutMs) : window);

  return {
    kind: 'e2b',

    async create(spec) {
      try {
        const { width, height } = parseResolution(spec.host.resolution);
        const window = idleWindowMs(spec.host.idlePauseMinutes ?? opts.idlePauseMinutes, opts.timeoutMs);
        const sandbox = await Sandbox.create(spec.image, {
          ...connection,
          resolution: [width, height],
          timeoutMs: net(window),
          // E2B pauses the sandbox itself if the provider never does (a computerd that died); it resumes on traffic.
          lifecycle: { onTimeout: 'pause', autoResume: true },
          metadata: { linkId: spec.link.id },
          ...(outerFilter ? { network } : {}),
        });
        try {
          // The template's start command runs as the template user, not root (proven on E2B cloud: juno-link ran as `agent` and could
          // not read its root-only config), so the daemon is started here, as root, with its link config as its own environment only.
          // Pause and resume keep the process; a cold start is a new create.
          // Detached (setsid -f) on purpose: a daemon that stays a child of the command's stream died when the pause cut that stream (proven on E2B cloud).
          await sandbox.commands.run(LINK_DAEMON, { user: 'root', envs: { ...spec.env } });
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
        const sandbox = await Sandbox.connect(binding.sandboxId, connection);
        // A snapshot restore keeps the daemon but not its network: its link connection is dead and the daemon would only notice after
        // its 50 s silence watchdog (a resume then took ~45 s, measured). Cut the connection now so it dials again within seconds.
        await sandbox.commands.run(`ss -K state established dport = :${linkPort}`, { user: 'root' }).catch(() => undefined);
        // Said again on every resume rather than trusting the pause to have kept it: a computer must never come back open.
        if (outerFilter) await Sandbox.updateNetwork(binding.sandboxId, network, connection);
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
      await Sandbox.setTimeout(binding.sandboxId, net(windowMs || defaultWindow), connection).catch(() => undefined);
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The local Docker platform as a `LifecycleDriver` (BACKEND §7.11): real Linux containers on this machine's Docker, driven
 * only through the docker CLI (an argv array, no shell, no host mounts, no Docker socket mount).
 *
 * The container publishes NO port. `juno-link` (the image's start command, run as root) dials out to computerd at
 * `host.docker.internal`, and everything else travels over that connection. The link token reaches the container as an
 * environment variable whose VALUE comes from the CLI process's own environment (`-e NAME`), so it is never in an argument list.
 *
 * Ownership is verified from hashed labels on every call: a foreign or hand-made container is reported as gone and never
 * touched. Suspend is `docker pause`; stop and start are a real cold boot (files on the container disk and the durable
 * volumes stay).
 */
import { randomUUID } from 'node:crypto';
import type { E2bBinding } from '@agent-desktop/contracts';
import { createLogger } from '@agent-desktop/log';
import { createDockerCli, isDockerDaemonDown, type DockerCli } from './docker-cli.js';
import type { CreateSpec, LifecycleDriver, MachineState } from './driver.js';
import { idleWindowMs } from './driver.js';
import { ComputerdError, StaleComputerError, failed, unavailable } from './errors.js';
import {
  MANAGED_LABEL,
  OWNER_LABEL,
  assertOwned,
  inspectContainer,
  ownerHash,
  pauseContainer,
  readContainerStats,
  resumeContainer,
  shortId,
  type ContainerInfo,
} from './local-container.js';
import type { SandboxRuntime } from './runtime.js';
import type { ComputerStorage } from './storage.js';
import { parseResolution, type ComputerMetrics } from './types.js';

const log = createLogger({ service: 'sandbox-provider' });

/** The local desktop image, built and verified separately (ML1). */
export const DEFAULT_LOCAL_IMAGE = 'juno-desktop:local';

/** Label carrying the configured idle window in minutes (durable across provider restarts). */
export const IDLE_LABEL = 'dev.agent-desktop.idle-minutes';
/** Label carrying the configured sandbox lifetime in ms (durable across provider restarts). */
export const LIFETIME_LABEL = 'dev.agent-desktop.lifetime-ms';
/** Label carrying the computer link id, for whoever inspects the container. */
export const LINK_LABEL = 'dev.agent-desktop.link';

const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_LIFETIME_MS = 3_600_000;
const CREATE_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_S = 10;

export interface DockerDriverOptions {
  ownerId: string;
  /** Overridden in tests with an in-memory fake; the real docker CLI otherwise. */
  docker?: DockerCli;
  /** Where /juno and /workspace live (BACKEND 7.10); absent keeps them on the container's own disk. */
  storage?: ComputerStorage;
}

/** `docker run` arguments for a new computer. No `-p`: nothing is published. Exported so the "no ports" rule has a test. */
export function runArguments(input: { name: string; hash: string; spec: CreateSpec; storageArgs: string[] }): string[] {
  const { name, hash, spec, storageArgs } = input;
  return [
    'run', '-d',
    '--init',
    // If juno-link (the start command) ever exits, Docker starts the computer again; an explicit `docker stop` is respected.
    '--restart', 'unless-stopped',
    '--name', name,
    '--label', `${OWNER_LABEL}=${hash}`,
    '--label', `${MANAGED_LABEL}=1`,
    '--label', `${IDLE_LABEL}=${spec.host.idlePauseMinutes}`,
    '--label', `${LIFETIME_LABEL}=${spec.host.timeoutMs}`,
    '--label', `${LINK_LABEL}=${spec.env.JUNO_LINK_ID}`,
    '--memory', `${spec.host.ramGb}g`,
    '--cpus', String(spec.host.vcpu),
    // juno-link runs as root (the image's start command); the image's own default user is for E2B's sake.
    '--user', 'root',
    // iptables rules that keep one agent off another's browser and VNC ports (BACKEND §7.9). hidepid needs
    // SYS_ADMIN; it is not granted here, so it is skipped (and logged) on local Docker.
    '--cap-add', 'NET_ADMIN',
    // How the container reaches computerd on the host (Docker Desktop has it; Linux needs the mapping).
    '--add-host', 'host.docker.internal:host-gateway',
    '-e', `JUNO_LINK_URL=${spec.env.JUNO_LINK_URL}`,
    '-e', `JUNO_LINK_ID=${spec.env.JUNO_LINK_ID}`,
    '-e', 'JUNO_LINK_TOKEN',
    ...storageArgs,
    spec.image,
  ];
}

export function createDockerDriver(options: DockerDriverOptions): LifecycleDriver {
  const cli = options.docker ?? createDockerCli();
  const hash = ownerHash(options.ownerId);

  /** The owned container, or a `gone` verdict for one that is missing. A foreign container still throws: it must be noticed. */
  async function owned(binding: { sandboxId: string }, signal: AbortSignal): Promise<ContainerInfo> {
    const info = await inspectContainer(cli, binding.sandboxId, signal);
    assertOwned(info, hash);
    return info;
  }

  async function remove(info: ContainerInfo, signal: AbortSignal): Promise<void> {
    const result = await cli.run(['rm', '-f', info.id], { timeoutMs: 60_000, signal });
    if (result.exitCode !== 0) throw failed(`could not remove container ${shortId(info.id)}: ${bound(result.stderr || result.stdout)}`);
  }

  /**
   * The owned container, for a cold boundary (resume or start; a running computer never comes here). One built from an
   * older image than its tag now points to is removed and reported stale, so computerd's normal recovery creates a new one
   * on the same durable volumes. An image that cannot be inspected keeps the container.
   */
  async function upToDate(binding: E2bBinding, signal: AbortSignal): Promise<ContainerInfo> {
    const info = await owned(binding, signal);
    const current = await cli.run(['image', 'inspect', '-f', '{{.Id}}', info.imageName], { timeoutMs: PROBE_TIMEOUT_MS, signal }).catch(() => undefined);
    const currentId = current?.exitCode === 0 ? current.stdout.trim() : '';
    if (currentId === '') {
      log.warn({ image: info.imageName, container: shortId(info.id) }, 'image could not be inspected; keeping the container');
      return info;
    }
    if (currentId === info.image) return info;
    await driver.destroy(binding, signal);
    throw new StaleComputerError('image_outdated', `container ${shortId(info.id)} runs an older ${info.imageName}; replaced on the next start`, binding.sandboxId);
  }

  const driver: LifecycleDriver = {
    kind: 'local',

    async create(spec, signal) {
      try {
        await ensureImage(cli, spec.image, signal);
        parseResolution(spec.host.resolution);
        const name = `agent-local-${hash.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
        const storageArgs = (await options.storage?.dockerArgs(cli, options.ownerId, signal)) ?? [];
        const result = await cli.run(runArguments({ name, hash, spec, storageArgs }), {
          timeoutMs: CREATE_TIMEOUT_MS,
          signal,
          env: { JUNO_LINK_TOKEN: spec.env.JUNO_LINK_TOKEN },
        });
        if (result.exitCode !== 0) throw createFailure(result.stderr || result.stdout);
        const id = result.stdout.trim();
        if (!/^[0-9a-f]+$/i.test(id)) throw failed(`docker run returned an unexpected container id: ${id.slice(0, 80)}`);
        return { sandboxId: id, template: spec.image };
      } catch (error) {
        if (error instanceof ComputerdError) throw error;
        throw unavailable(`could not create container: ${message(error)}`);
      }
    },

    async status(binding, signal): Promise<MachineState> {
      let info: ContainerInfo;
      try {
        info = await owned(binding, signal);
      } catch (error) {
        if (error instanceof StaleComputerError) return 'gone';
        throw error;
      }
      if (info.status === 'running') return 'running';
      return info.status === 'paused' ? 'suspended' : 'stopped';
    },

    async start(binding, signal) {
      await resumeContainer(cli, await upToDate(binding, signal), signal);
    },

    async resume(binding, signal) {
      await resumeContainer(cli, await upToDate(binding, signal), signal);
    },

    async suspend(binding, signal) {
      await pauseContainer(cli, await owned(binding, signal), signal);
    },

    async stop(binding, signal) {
      const info = await owned(binding, signal);
      const result = await cli.run(['stop', '-t', String(STOP_TIMEOUT_S), info.id], { timeoutMs: 60_000, signal });
      if (result.exitCode !== 0) throw failed(`could not stop container ${shortId(info.id)}: ${bound(result.stderr || result.stdout)}`);
    },

    async destroy(binding, signal) {
      await remove(await owned(binding, signal), signal);
    },

    async destroyOwned(signal) {
      const listed = await cli.run(['ps', '-aq', '--no-trunc', '--filter', `label=${OWNER_LABEL}=${hash}`, '--filter', `label=${MANAGED_LABEL}=1`], { timeoutMs: 30_000, signal });
      if (listed.exitCode !== 0) throw failed(`could not list the containers of this owner: ${bound(listed.stderr || listed.stdout)}`);
      let computers = 0;
      for (const id of listed.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
        try {
          await remove(await owned({ sandboxId: id }, signal), signal); // `owned` re-reads the labels first: nothing else is removed
          computers += 1;
        } catch (error) {
          if (!(error instanceof StaleComputerError)) throw error; // already gone
        }
      }
      return { computers, volumes: (await options.storage?.removeVolumes?.(cli, options.ownerId, signal)) ?? [] };
    },

    async idleWindowMs(binding, signal) {
      return idleFromLabels(await owned(binding, signal));
    },

    async metrics(binding, runtime, signal): Promise<ComputerMetrics | null> {
      try {
        const info = await owned(binding, signal);
        if (info.status !== 'running') return null;
        const stats = await readContainerStats(cli, binding.sandboxId, signal);
        const vcpu = await containerVcpus(runtime, info, signal);
        if (vcpu === null) return null;
        const disk = await runtime.run('df -m /', { timeoutMs: PROBE_TIMEOUT_MS, signal });
        if (disk.exitCode !== 0) return null;
        const [diskUsedGb, diskTotalGb] = parseDiskGb(disk.stdout);
        if (diskUsedGb === null || diskTotalGb === null) return null;
        return { memUsedMb: stats.memUsedMb, memTotalMb: stats.memTotalMb, vcpu, cpuPercent: stats.cpuPercent, diskUsedGb, diskTotalGb };
      } catch {
        return null;
      }
    },
  };
  return driver;
}

/** Fail fast when the image is missing or the daemon is down, with an actionable message. */
async function ensureImage(cli: DockerCli, image: string, signal: AbortSignal): Promise<void> {
  const result = await cli.run(['image', 'inspect', image], { timeoutMs: 30_000, signal });
  if (result.exitCode === 0) return;
  const err = result.stderr || result.stdout;
  if (isDockerDaemonDown(err)) {
    throw unavailable(`docker daemon is not reachable (start Docker Desktop and wait until it is running), then retry: ${bound(err)}`);
  }
  if (/no such image/i.test(err)) throw failed(`local image ${image} was not found; build it first, then retry`);
  throw failed(`could not read local image ${image}: ${bound(err)}`);
}

function createFailure(err: string): Error {
  if (isDockerDaemonDown(err)) {
    return unavailable(`docker daemon is not reachable (start Docker Desktop and wait until it is running), then retry: ${bound(err)}`);
  }
  return failed(`docker run failed: ${bound(err, 500)}`);
}

/** Re-read the configured idle window from the container labels (durable across restarts). */
function idleFromLabels(info: ContainerInfo): number {
  const minutes = Number(info.labels[IDLE_LABEL]);
  const lifetime = Number(info.labels[LIFETIME_LABEL]);
  if (!Number.isFinite(minutes) || !Number.isFinite(lifetime) || lifetime <= 0) return idleWindowMs(DEFAULT_IDLE_MINUTES, DEFAULT_LIFETIME_MS);
  return idleWindowMs(minutes, lifetime);
}

/** Parse `df -m /` output (total/used MB columns) into GB; nulls when the shape is unexpected. */
function parseDiskGb(stdout: string): [number | null, number | null] {
  const lines = stdout.trim().split('\n');
  const cells = (lines[1] ?? '').trim().split(/\s+/);
  const total = Number(cells[1]);
  const used = Number(cells[2]);
  if (!Number.isFinite(used) || !Number.isFinite(total)) return [null, null];
  const gb = (mb: number) => Math.round((mb / 1024) * 10) / 10;
  return [gb(used), gb(total)];
}

function bound(text: string, limit = 300): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Container vCPUs: the daemon-persisted NanoCpus quota, else cgroup cpu.max, else nproc. Never the host count when limited. */
async function containerVcpus(runtime: SandboxRuntime, info: ContainerInfo, signal: AbortSignal): Promise<number | null> {
  if (Number.isFinite(info.nanoCpus) && info.nanoCpus > 0) return Math.max(1, Math.round(info.nanoCpus / 1_000_000_000));
  const max = await runtime.run('cat /sys/fs/cgroup/cpu.max', { timeoutMs: PROBE_TIMEOUT_MS, signal });
  if (max.exitCode === 0) {
    const limit = parseCpuMax(max.stdout);
    if (limit === 'max') return nprocVcpus(runtime, signal);
    if (limit !== null) return limit;
  }
  return nprocVcpus(runtime, signal);
}

async function nprocVcpus(runtime: SandboxRuntime, signal: AbortSignal): Promise<number | null> {
  const proc = await runtime.run('nproc', { timeoutMs: PROBE_TIMEOUT_MS, signal });
  if (proc.exitCode !== 0) return null;
  const vcpu = Number.parseInt(proc.stdout.trim(), 10);
  return Number.isFinite(vcpu) && vcpu > 0 ? vcpu : null;
}

function parseCpuMax(stdout: string): number | 'max' | null {
  const parts = stdout.trim().split(/\s+/);
  if (parts[0] === 'max') return 'max';
  const quota = Number(parts[0]);
  const period = Number(parts[1]);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || period <= 0 || quota <= 0) return null;
  return Math.max(1, Math.round(quota / period));
}

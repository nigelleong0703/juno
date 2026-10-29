/**
 * Container-level operations for the local provider: inspect and verify, pause and resume,
 * and resource stats, all over the injected docker CLI.
 *
 * Ownership is verified from hashed labels on EVERY open: a foreign or hand-made container is
 * refused outright and never acted on, and nothing here ever falls back to the host.
 */
import { createHash } from 'node:crypto';
import { isDockerDaemonDown, type DockerCli, type DockerResult } from './docker-cli.js';
import { StaleComputerError, failed, notAllowed, unavailable } from './errors.js';

/** Label carrying the SHA-256 of the owning owner id (hashed, so the label leaks no identity). */
export const OWNER_LABEL = 'dev.agent-desktop.owner';
/** Label marking a container as provider-managed. */
export const MANAGED_LABEL = 'dev.agent-desktop.managed';

export function ownerHash(ownerId: string): string {
  return createHash('sha256').update(ownerId, 'utf8').digest('hex');
}

export function shortId(id: string): string {
  return id.slice(0, 12);
}

export interface ContainerInfo {
  id: string;
  status: string;
  /** Id of the image the container was created from (`sha256:...`). */
  image: string;
  /** The image reference it was created with (Config.Image, e.g. `juno-desktop:local`). */
  imageName: string;
  labels: Record<string, string>;
  /** CPU quota (HostConfig.NanoCpus); 0 means unlimited. */
  nanoCpus: number;
  /** Memory limit in bytes (HostConfig.Memory); 0 means unlimited. */
  memoryBytes: number;
  /** Container start time (State.StartedAt); changes on every (re)start, never on pause. */
  startedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read one container's state and labels; a missing container fails as a gone binding. */
export async function inspectContainer(cli: DockerCli, id: string, signal?: AbortSignal): Promise<ContainerInfo> {
  const result = await cli.run(['inspect', id], { timeoutMs: 30_000, signal });
  if (result.exitCode !== 0) throw missingContainer(id, result);
  return parseInspect(id, result.stdout);
}

function parseInspect(id: string, stdout: string): ContainerInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw failed(`could not read container ${shortId(id)}: docker inspect returned unparsable output`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new StaleComputerError('gone', `container ${shortId(id)} no longer exists (docker inspect returned no object)`, id);
  }
  const entry = parsed[0];
  if (!isRecord(entry)) throw failed(`could not read container ${shortId(id)}: unexpected inspect output`);
  const state = entry['State'];
  const config = entry['Config'];
  const status = isRecord(state) && typeof state['Status'] === 'string' ? state['Status'] : '';
  const image = typeof entry['Image'] === 'string' ? entry['Image'] : '';
  const hostConfig = entry['HostConfig'];
  const nano = isRecord(hostConfig) ? hostConfig['NanoCpus'] : undefined;
  const nanoCpus = typeof nano === 'number' && Number.isFinite(nano) ? nano : 0;
  const mem = isRecord(hostConfig) ? hostConfig['Memory'] : undefined;
  const memoryBytes = typeof mem === 'number' && Number.isFinite(mem) ? mem : 0;
  const labels: Record<string, string> = {};
  const rawLabels = isRecord(config) ? config['Labels'] : undefined;
  if (isRecord(rawLabels)) {
    for (const [key, value] of Object.entries(rawLabels)) {
      if (typeof value === 'string') labels[key] = value;
    }
  }
  if (!status) throw failed(`could not read container ${shortId(id)}: docker inspect has no state`);
  const startedAt = isRecord(state) && typeof state['StartedAt'] === 'string' ? state['StartedAt'] : '';
  const imageName = isRecord(config) && typeof config['Image'] === 'string' ? config['Image'] : '';
  return { id, status, image, imageName, labels, nanoCpus, memoryBytes, startedAt };
}

function missingContainer(id: string, result: DockerResult): Error {
  const err = result.stderr || result.stdout;
  if (isDockerDaemonDown(err)) {
    return unavailable(
      `docker daemon is not reachable (start Docker Desktop and wait until it is running), then retry: ${bound(err)}`,
    );
  }
  // Only "no such object" proves the container is gone; any other docker failure (permissions, a hung daemon) must not
  // make the platform throw a working computer away.
  if (isDockerMissing(err)) return new StaleComputerError('gone', `container ${shortId(id)} no longer exists: ${bound(err)}`, id);
  return unavailable(`could not inspect container ${shortId(id)}: ${bound(err)}`);
}

/** `docker inspect` of a removed container: "Error: No such object: <id>" (or "No such container"). */
export function isDockerMissing(stderr: string): boolean {
  return /no such (object|container)/i.test(stderr);
}

/** Refuse a container that is not this owner's managed container. Never fall back to the host. */
export function assertOwned(info: ContainerInfo, hash: string): void {
  if (info.labels[OWNER_LABEL] !== hash || info.labels[MANAGED_LABEL] !== '1') {
    throw notAllowed(`container ${shortId(info.id)} does not belong to this owner and will not be used`);
  }
}

/** Verify ownership, then resume a paused container or restart a stopped one. Idempotent. */
export async function resumeContainer(
  cli: DockerCli,
  info: ContainerInfo,
  signal?: AbortSignal,
): Promise<void> {
  if (info.status === 'running') return;
  const op = info.status === 'paused' ? 'unpause' : 'start';
  const result = await cli.run([op, info.id], { timeoutMs: 60_000, signal });
  if (result.exitCode !== 0) {
    throw failed(`could not ${op} container ${shortId(info.id)}: ${bound(result.stderr || result.stdout)}`);
  }
}

/** Verify ownership, then freeze a running container (files, processes and windows persist). */
export async function pauseContainer(
  cli: DockerCli,
  info: ContainerInfo,
  signal?: AbortSignal,
): Promise<void> {
  if (info.status !== 'running') return;
  const result = await cli.run(['pause', info.id], { timeoutMs: 60_000, signal });
  if (result.exitCode !== 0) {
    throw failed(`could not pause container ${shortId(info.id)}: ${bound(result.stderr || result.stdout)}`);
  }
}

export interface ContainerStats {
  memUsedMb: number;
  memTotalMb: number;
  cpuPercent: number;
}

/** Live memory and CPU from `docker stats`; a failure here means "no sample", decided upstream. */
export async function readContainerStats(
  cli: DockerCli,
  id: string,
  signal?: AbortSignal,
): Promise<ContainerStats> {
  const result = await cli.run(
    ['stats', '--no-stream', '--format', '{{.MemUsage}}|{{.CPUPerc}}', id],
    { timeoutMs: 30_000, signal },
  );
  if (result.exitCode !== 0) {
    throw failed(`could not read stats for container ${shortId(id)}: ${bound(result.stderr || result.stdout)}`);
  }
  const stats = parseDockerStats(result.stdout);
  if (!stats) throw failed(`could not parse docker stats output: ${bound(result.stdout)}`);
  return stats;
}

/** Parse `12.5MiB / 2GiB|1.25%`; null when the daemon output is not in that shape. */
export function parseDockerStats(stdout: string): ContainerStats | null {
  const line = stdout.trim();
  const [memPart, cpuPart] = line.split('|');
  if (!memPart || !cpuPart) return null;
  const [usedPart, totalPart] = memPart.split('/');
  if (!usedPart || !totalPart) return null;
  const used = parseSizeMb(usedPart.trim());
  const total = parseSizeMb(totalPart.trim());
  const cpu = Number.parseFloat(cpuPart.replace('%', '').trim());
  if (used === null || total === null || !Number.isFinite(cpu)) return null;
  return { memUsedMb: used, memTotalMb: total, cpuPercent: Math.min(100, Math.max(0, cpu)) };
}

function parseSizeMb(text: string): number | null {
  const match = /^([\d.]+)\s*([KMGT]?i?[Bb])$/.exec(text);
  if (!match) return null;
  const value = Number.parseFloat(match[1] ?? '');
  const unit = (match[2] ?? 'B').toUpperCase();
  if (!Number.isFinite(value)) return null;
  const factors: Record<string, number> = {
    B: 1 / (1024 * 1024),
    K: 1 / 1024,
    KB: 1 / 1024,
    KIB: 1 / 1024,
    M: 1,
    MB: 1,
    MIB: 1,
    G: 1024,
    GB: 1024,
    GIB: 1024,
    T: 1024 * 1024,
    TB: 1024 * 1024,
    TIB: 1024 * 1024,
  };
  const factor = factors[unit];
  if (factor === undefined) return null;
  return Math.round(value * factor * 10) / 10;
}

function bound(text: string, limit = 300): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
}

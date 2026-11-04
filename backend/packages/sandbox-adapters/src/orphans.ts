/**
 * Orphaned local containers (BACKEND §7.11, "Orphans"). A computerd that is gone (a test stack, a stopped dev backend) leaves
 * its containers behind, and nothing else ever idles or removes them. The next computerd of the same deployment cleans up:
 *
 *  - a container whose link id is the stored binding's link of an owner is that owner's current computer: `adopt` (the caller arms
 *    the idle timer, so a computerd restart does not leave it running for ever);
 *  - a container that carries OUR deployment label, is not a current computer, and is older than `created + lifetime + grace`
 *    is removed. The deployment label is what keeps one deployment (the owner's dev backend) away from another's (an e2e stack)
 *    that shares the same Docker daemon; a container without the label (made before it existed, or by anything else) is never touched;
 *  - the volumes of a removed container go only when the owner is not an account of this deployment (`accountHashes`) and no
 *    other container of that owner is left; with `accountHashes` null (no account list) volumes are never removed.
 */
import { createHash } from 'node:crypto';
import { createLogger } from '@agent-desktop/log';
import type { DockerCli } from './docker-cli.js';
import { DEPLOYMENT_LABEL, LIFETIME_LABEL, LINK_LABEL } from './docker-driver.js';
import { MANAGED_LABEL, OWNER_LABEL, inspectContainer, shortId, type ContainerInfo } from './local-container.js';
import { StaleComputerError } from './errors.js';

const log = createLogger({ service: 'sandbox-provider' });

/** How long past its lifetime a computer of this deployment may sit before it counts as abandoned. */
export const ORPHAN_GRACE_MS = 24 * 3_600_000;
const DEFAULT_LIFETIME_MS = 3_600_000;
const DOCKER_TIMEOUT_MS = 60_000;

/** Stable id of one deployment: the explicit one when set, else a prefix of the hash of the service secret (never the secret). */
export function deploymentId(explicit: string, secret: string): string {
  if (explicit !== '') return explicit;
  return secret === '' ? '' : createHash('sha256').update(`juno-deployment:${secret}`).digest('hex').slice(0, 16);
}

export type ReapVerdict = 'keep' | 'adopt' | 'remove';

export interface ReapInput {
  labels: Readonly<Record<string, string>>;
  /** Container creation time, ISO. */
  created: string;
  now: number;
  /** This deployment's id; '' means unknown and nothing foreign is ever removed. */
  deployment: string;
  /** Link ids of the stored bindings of every owner of this deployment. */
  boundLinkIds: ReadonlySet<string>;
}

/** What to do with one container. Pure: labels, time and this deployment's bound link ids decide everything. */
export function reapDecision(input: ReapInput): ReapVerdict {
  const { labels } = input;
  if (labels[MANAGED_LABEL] !== '1') return 'keep';
  const link = labels[LINK_LABEL];
  if (link !== undefined && input.boundLinkIds.has(link)) return 'adopt';
  if (input.deployment === '' || labels[DEPLOYMENT_LABEL] !== input.deployment) return 'keep';
  const lifetime = Number(labels[LIFETIME_LABEL]);
  const lifetimeMs = Number.isFinite(lifetime) && lifetime > 0 ? lifetime : DEFAULT_LIFETIME_MS;
  const created = Date.parse(input.created);
  if (Number.isNaN(created)) return 'keep';
  return input.now - created > lifetimeMs + ORPHAN_GRACE_MS ? 'remove' : 'keep';
}

export interface SweepOptions {
  cli: DockerCli;
  deployment: string;
  boundLinkIds: ReadonlySet<string>;
  /** sha256 hashes of the owner ids of every account in this deployment; null when they cannot be listed (volumes then stay). */
  accountHashes: ReadonlySet<string> | null;
  now: number;
  signal: AbortSignal;
}

export interface SweepReport {
  /** Running containers that are some owner's current computer. */
  adopt: ContainerInfo[];
  removed: string[];
  volumes: string[];
}

/** One pass over every managed container on the local Docker daemon. A failure on one container does not stop the pass. */
export async function sweepManagedContainers(options: SweepOptions): Promise<SweepReport> {
  const { cli, signal } = options;
  const listed = await cli.run(['ps', '-aq', '--no-trunc', '--filter', `label=${MANAGED_LABEL}=1`], { timeoutMs: 30_000, signal });
  if (listed.exitCode !== 0) throw new Error(`could not list managed containers: ${(listed.stderr || listed.stdout).trim().slice(0, 300)}`);
  const report: SweepReport = { adopt: [], removed: [], volumes: [] };
  const survivors = new Set<string>();
  const removedOwners = new Set<string>();
  for (const id of listed.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
    let info: ContainerInfo;
    try {
      info = await inspectContainer(cli, id, signal);
    } catch (error) {
      if (!(error instanceof StaleComputerError)) log.warn({ err: error, container: shortId(id) }, 'orphan sweep: could not inspect a container');
      continue;
    }
    const owner = info.labels[OWNER_LABEL] ?? '';
    const verdict = reapDecision({ labels: info.labels, created: info.created, now: options.now, deployment: options.deployment, boundLinkIds: options.boundLinkIds });
    if (verdict === 'remove') {
      const removed = await cli.run(['rm', '-f', info.id], { timeoutMs: DOCKER_TIMEOUT_MS, signal });
      if (removed.exitCode === 0) {
        log.info({ container: shortId(info.id), owner: owner.slice(0, 8), created: info.created }, 'orphan sweep: removed an abandoned computer');
        report.removed.push(info.id);
        removedOwners.add(owner);
        continue;
      }
      log.warn({ container: shortId(info.id), owner: owner.slice(0, 8) }, `orphan sweep: could not remove: ${(removed.stderr || removed.stdout).trim().slice(0, 200)}`);
    }
    survivors.add(owner);
    if (verdict === 'adopt' && info.status === 'running') report.adopt.push(info);
  }
  if (options.accountHashes !== null) {
    for (const owner of removedOwners) {
      if (owner === '' || options.accountHashes.has(owner) || survivors.has(owner)) continue;
      report.volumes.push(...(await removeOwnerVolumes(cli, owner, signal)));
    }
  }
  return report;
}

/** Remove the volumes that carry this owner hash and the managed label (and nothing else). */
async function removeOwnerVolumes(cli: DockerCli, owner: string, signal: AbortSignal): Promise<string[]> {
  const listed = await cli.run(['volume', 'ls', '-q', '--filter', `label=${OWNER_LABEL}=${owner}`, '--filter', `label=${MANAGED_LABEL}=1`], { timeoutMs: 30_000, signal });
  if (listed.exitCode !== 0) return [];
  const removed: string[] = [];
  for (const name of listed.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')) {
    const result = await cli.run(['volume', 'rm', name], { timeoutMs: DOCKER_TIMEOUT_MS, signal });
    if (result.exitCode === 0) removed.push(name);
    else log.warn({ volume: name, owner: owner.slice(0, 8) }, `orphan sweep: could not remove a volume: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
  }
  if (removed.length > 0) log.info({ owner: owner.slice(0, 8), volumes: removed.length }, 'orphan sweep: removed the volumes of an owner that is not an account here');
  return removed;
}

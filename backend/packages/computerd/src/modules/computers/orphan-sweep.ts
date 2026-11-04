import type { DockerCli } from '@agent-desktop/sandbox-adapters';
import { LINK_LABEL, OWNER_LABEL, ownerHash, sweepManagedContainers } from '@agent-desktop/sandbox-adapters';
import type { OwnerComputers } from './owner-computers.js';

export interface OrphanSweepOptions {
  cli: DockerCli;
  computers: OwnerComputers;
  deployment: string;
  /** Owner ids of every account in this deployment's database; null when they cannot be listed (memory store). */
  accountOwners: () => Promise<string[] | null>;
  log: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * One pass of BACKEND §7.11 "Orphans": remove this deployment's abandoned containers (and the volumes of owners that are no
 * account here), and arm the idle timer of every running computer that is an owner's current one but predates this process.
 */
export async function runOrphanSweep(options: OrphanSweepOptions): Promise<void> {
  const signal = AbortSignal.timeout(10 * 60_000);
  const owners = await options.accountOwners();
  const byHash = new Map((owners ?? []).map((owner) => [ownerHash(owner), owner]));
  const report = await sweepManagedContainers({
    cli: options.cli,
    deployment: options.deployment,
    boundLinkIds: options.computers.boundLinkIds(),
    accountHashes: owners === null ? null : new Set(byHash.keys()),
    now: Date.now(),
    signal,
  });
  for (const info of report.adopt) {
    const owner = byHash.get(info.labels[OWNER_LABEL] ?? '');
    if (owner === undefined) continue;
    try {
      const { lifecycle, provider } = options.computers.forOwner(owner);
      const binding = lifecycle.currentBinding();
      if (binding !== null && binding.linkId === info.labels[LINK_LABEL]) await provider.adopt?.(binding, signal);
    } catch (error) {
      options.log({ err: error, container: info.id.slice(0, 12) }, 'orphan sweep: could not adopt a running computer');
    }
  }
  if (report.removed.length > 0 || report.volumes.length > 0) {
    options.log({ containers: report.removed.length, volumes: report.volumes.length }, 'orphan sweep finished');
  }
}

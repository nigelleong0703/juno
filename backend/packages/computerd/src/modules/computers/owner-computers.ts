import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { E2bBinding, Store } from '@agent-desktop/contracts';
import {
  createScreenPool, loadPool, savePool, relaunchSpaces, MAX_LIVE_SCREENS, notAllowed,
  type ComputerHostSpec, type ComputerProvider, type EraseReport, type StartedContext,
} from '@agent-desktop/sandbox-adapters';
import { ARCHIVE_DIR, createComputerStateStore } from '../../infrastructure/computer-state.js';
import { createLifecycle, gatewayKeyFor, type Lifecycle, type LifecycleOptions } from './lifecycle.js';

export interface OwnerComputer {
  lifecycle: Lifecycle;
  provider: ComputerProvider;
}

/** What deleting an owner's computer removed: the platform's report plus the state files computerd itself kept. */
export interface OwnerErasure extends EraseReport {
  files: string[];
}

export interface OwnerComputers {
  forOwner(owner: string): OwnerComputer;
  /**
   * Account deletion (BACKEND §5.2c): remove the owner's computer(s), their durable storage (volumes, or the JuiceFS objects and
   * metadata) and the binding / screen-pool files, then refuse every later use of this owner until computerd restarts. Only
   * what carries this owner's own labels, derived names and hashed state directory is touched. Idempotent, so a failed
   * erase is simply run again.
   */
  erase(owner: string, signal: AbortSignal): Promise<OwnerErasure>;
}

export interface OwnerComputersOptions {
  store: Store;
  legacyOwnerId: string;
  bindingFile: string;
  poolFile: string;
  host: ComputerHostSpec;
  secret: string;
  legacyBinding?: E2bBinding | null;
  /** `onStarted` is what the provider runs after a computer is created or cold-started (Spaces are relaunched). */
  providerForOwner(owner: string, hooks: { onStarted: (context: StartedContext) => Promise<void> }): ComputerProvider;
  recovery?: LifecycleOptions['recovery'];
}

export function createOwnerComputers(options: OwnerComputersOptions): OwnerComputers {
  const owners = new Map<string, OwnerComputer>();
  /** Owners whose account is being deleted: nothing may create a computer for them again (ids are never reused). */
  const erased = new Set<string>();
  const hashOf = (owner: string) => createHash('sha256').update(owner).digest('hex');
  const isLegacy = (owner: string) => options.legacyOwnerId !== '' && owner === options.legacyOwnerId;
  /** Where an owner's state file lives: the unscoped path for the legacy owner, else `<dir>/owners/<sha256 of the owner>/<file>`. */
  const ownerPath = (owner: string, file: string) => isLegacy(owner) ? file : join(dirname(file), 'owners', hashOf(owner), basename(file));

  function open(owner: string): OwnerComputer {
    if (!owner.trim()) throw notAllowed('missing owner');
    const cached = owners.get(owner);
    if (cached) return cached;
    if (!options.store.forOwner) throw notAllowed('owner-scoped store is required');
    const poolFile = ownerPath(owner, options.poolFile);
    const state = createComputerStateStore(ownerPath(owner, options.bindingFile), isLegacy(owner) ? options.legacyBinding ?? null : null);
    const pool = createScreenPool(MAX_LIVE_SCREENS, loadPool(poolFile));
    const store = options.store.forOwner(owner);
    const provider = options.providerForOwner(owner, {
      onStarted: (context) => relaunchSpaces({ store, gatewayKey: (computerId) => gatewayKeyFor(options.secret, computerId) }, context),
    });
    const lifecycle = createLifecycle({
      store, provider, pool, state, ownerId: owner,
      host: options.host, secret: options.secret,
      onPoolChange: () => savePool(poolFile, pool.entries()),
      ...(options.recovery ? { recovery: options.recovery } : {}),
    });
    // Check the stored binding now (not at the first request) so a computer lost while computerd was down is archived early.
    void lifecycle.reconcile();
    const computer = { lifecycle, provider };
    owners.set(owner, computer);
    return computer;
  }

  /** Remove the owner's state files; a directory is only removed when it is exactly `owners/<this owner's hash>`. */
  function removeStateFiles(owner: string): string[] {
    const targets = isLegacy(owner)
      ? [options.bindingFile, options.poolFile, join(dirname(options.bindingFile), ARCHIVE_DIR)]
      : [...new Set([dirname(ownerPath(owner, options.bindingFile)), dirname(ownerPath(owner, options.poolFile))])]
        .filter((dir) => basename(dir) === hashOf(owner) && basename(dirname(dir)) === 'owners');
    const removed: string[] = [];
    for (const target of targets) {
      if (!existsSync(target)) continue;
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
    return removed;
  }

  return {
    forOwner(owner) {
      if (erased.has(owner)) throw notAllowed('this account was deleted');
      return open(owner);
    },

    async erase(owner, signal) {
      const { lifecycle, provider } = open(owner);
      erased.add(owner);
      const binding = lifecycle.currentBinding();
      let report: EraseReport = { computers: 0, removed: [] };
      if (provider.erase) report = await provider.erase(binding, signal);
      else if (binding && provider.destroy) {
        await provider.destroy(binding, signal);
        report = { computers: 1, removed: [] };
      }
      owners.delete(owner);
      return { ...report, files: removeStateFiles(owner) };
    },
  };
}

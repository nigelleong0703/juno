/**
 * Self-healing of a lost computer (BACKEND §7.11, fault tolerance), one per owner.
 *
 * When a call finds the bound computer gone, pre-link, or running without a link, the binding is archived (never silently
 * deleted), the screen pool and screen rows of that computer are dropped, the old computer is destroyed if it still exists, and
 * a new one is created on the same durable storage through the normal create path. Recovery is serialized per owner (callers
 * join the one running recovery) and never gives up: a failed attempt is retried with exponential backoff, forever, with an
 * audit event per attempt and a loud log from the third consecutive failure on.
 */
import type { AuditEntry } from '@agent-desktop/public-contracts';
import type { E2bBinding, Store } from '@agent-desktop/contracts';
import { createLogger } from '@agent-desktop/log';
import { aborted, computerRecovering, type ComputerProvider, type ScreenPool } from '@agent-desktop/sandbox-adapters';
import type { ComputerStateStore } from '../../infrastructure/computer-state.js';
import { ALERT_AFTER_FAILURES, RECOVERY_WAIT_MS, backoffMs } from './recovery-policy.js';

const log = createLogger({ service: 'computerd-recovery' });
const DESTROY_BUDGET_MS = 30_000;

export interface RecoveryOptions {
  store: Store;
  provider: ComputerProvider;
  pool: ScreenPool;
  state: ComputerStateStore;
  ownerId: string;
  /** The normal create path (single-flight): creates and stores the binding when there is none. */
  ensureBinding(signal: AbortSignal): Promise<E2bBinding>;
  onPoolChange?: () => void;
  /** Test seams. */
  sleep?(ms: number): Promise<void>;
  waitMs?: number;
}

export interface Recovery {
  /** Replace the computer `staleId` (a no-op when it is no longer the bound one). Resolves when a working replacement exists, or throws `computer_recovering` after the wait. */
  recover(staleId: string, reason: string, signal: AbortSignal): Promise<void>;
  /** Once per process: archive a stored binding whose computer no longer exists, so the first use creates a fresh one without an error. */
  reconcile(): Promise<void>;
  dispose(): void;
}

export function createRecovery(options: RecoveryOptions): Recovery {
  const { state, pool, store, provider, ownerId } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  const waitMs = options.waitMs ?? RECOVERY_WAIT_MS;
  const stopped = new AbortController();
  let running: Promise<void> | undefined;
  let reconciled: Promise<void> | undefined;

  async function audit(action: string, reason: string, target: string): Promise<void> {
    const entry: AuditEntry = {
      id: `aud-${action}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      actor: 'system',
      action,
      target,
      decision: 'auto_allowed',
      reason,
      initiator: { type: 'system', wakeKind: 'computer_recovery' },
      unattended: true,
    };
    await store.put('audit', entry, { kind: action }).catch((error: unknown) => log.warn({ err: error }, 'could not write the computer audit event'));
  }

  /** Drop the screen pool and screen rows of the old computer. */
  async function dropScreens(computerId: string): Promise<void> {
    for (const entry of pool.entries()) pool.release(entry.agentId);
    options.onPoolChange?.();
    let cursor: string | undefined;
    for (;;) {
      const page = await store.list('screens', { limit: 100, ...(cursor ? { cursor } : {}) });
      for (const screen of page.items) {
        if (screen.ownerId !== ownerId || screen.computerId !== computerId) continue;
        await store.delete('screens', screen.id).catch(() => undefined);
        await store.delete('controls', `screen:${screen.id}`).catch(() => undefined);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }

  /** Archive the binding, drop its screens, best-effort destroy the machine. Returns the archive path. */
  async function retire(binding: E2bBinding, reason: string): Promise<string> {
    const path = state.archive(reason);
    await dropScreens(binding.sandboxId);
    await provider.destroy?.(binding, AbortSignal.timeout(DESTROY_BUDGET_MS)).catch(() => undefined);
    return path;
  }

  async function run(stale: E2bBinding, reason: string): Promise<void> {
    let failures = 0;
    let retired = false;
    for (;;) {
      try {
        if (!retired) {
          const path = await retire(stale, reason);
          retired = true;
          log.warn({ owner: ownerId, old: stale.sandboxId, reason, archive: path }, 'computer lost: binding archived, creating a new one');
        }
        const created = await options.ensureBinding(stopped.signal);
        log.info({ owner: ownerId, old: stale.sandboxId, new: created.sandboxId, reason, attempts: failures + 1 }, 'computer.recreated');
        await audit('computer.recreated', `${reason}; old ${stale.sandboxId}, new ${created.sandboxId}`, created.sandboxId);
        return;
      } catch (error) {
        failures += 1;
        const detail = error instanceof Error ? error.message : String(error);
        const fields = { owner: ownerId, old: stale.sandboxId, reason, consecutiveFailures: failures, err: error };
        if (failures >= ALERT_AFTER_FAILURES) log.error(fields, 'computer recovery keeps failing; an operator needs to look (it keeps retrying)');
        else log.warn(fields, 'computer recovery attempt failed');
        await audit('computer.recreate_failed', `${reason}; attempt ${failures} failed: ${detail}`.slice(0, 500), stale.sandboxId);
        if (stopped.signal.aborted) throw error;
        await sleep(backoffMs(failures));
      }
    }
  }

  async function waitFor(job: Promise<void>, signal: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        job,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(computerRecovering('the computer is being restored and will be ready shortly')), waitMs);
          onAbort = () => reject(aborted('cancelled while the computer was being restored'));
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    async recover(staleId, reason, signal) {
      if (!running) {
        const current = state.get();
        // Already replaced by an earlier recovery: the caller just retries.
        if (!current || current.sandboxId !== staleId) return;
        const job = run(current, reason).finally(() => {
          running = undefined;
        });
        job.catch(() => undefined);
        running = job;
      }
      await waitFor(running, signal);
    },

    reconcile() {
      reconciled ??= (async () => {
        const binding = state.get();
        if (!binding || !provider.probe) return;
        try {
          const verdict = await provider.probe(binding, AbortSignal.timeout(30_000));
          if (verdict === 'ok') return;
          const path = await retire(binding, `startup: ${verdict}`);
          log.warn({ owner: ownerId, old: binding.sandboxId, verdict, archive: path }, 'stored computer binding is stale: archived at startup');
        } catch (error) {
          // Unknown is not gone: an unreachable platform leaves the binding alone.
          log.warn({ owner: ownerId, err: error }, 'could not check the stored computer binding at startup');
        }
      })();
      return reconciled;
    },

    dispose() {
      stopped.abort();
    },
  };
}

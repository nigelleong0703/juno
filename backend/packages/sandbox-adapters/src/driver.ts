/**
 * What a platform has to be able to do for a computer, and nothing else (BACKEND §7.11). Everything that happens INSIDE
 * the computer (commands, files, screens, byte streams) goes through the computer link (`link-hub.ts`), so moving to
 * another vendor means writing one of these (E2B and local Docker are about 100 to 200 lines each).
 *
 * A driver never runs a command in the computer after boot. The one allowed exception is writing the link config at create,
 * for a platform that can neither inject environment variables nor files into a new machine (E2B), and it says so.
 */
import type { E2bBinding } from '@agent-desktop/contracts';
import type { ComputerHostSpec, ComputerMetrics, ProviderKind } from './types.js';
import type { SandboxRuntime } from './runtime.js';

/** What `juno-link` is started with so it can dial computerd. */
export interface LinkEnv {
  /** `wss://computerd.example/v1/computer-link`. */
  JUNO_LINK_URL: string;
  JUNO_LINK_ID: string;
  /** Secret: never put it in an argument list. */
  JUNO_LINK_TOKEN: string;
}

export interface CreateSpec {
  /** Image (Docker) or template (E2B). */
  image: string;
  /** Size, lifetime and idle policy. */
  host: ComputerHostSpec;
  /** The link config, injected as environment (or the platform's nearest equivalent). */
  env: LinkEnv;
  /** The link id and the token, for a platform that has to deliver them as a file instead. */
  link: { url: string; id: string; token: string };
}

/** `suspended` = frozen with memory kept (E2B pause, `docker pause`); `stopped` = off, disk kept, a start is a cold boot. */
export type MachineState = 'running' | 'suspended' | 'stopped' | 'gone';

export interface LifecycleDriver {
  readonly kind: ProviderKind;
  /** Create and start a computer from the image; it dials computerd by itself. */
  create(spec: CreateSpec, signal: AbortSignal): Promise<Pick<E2bBinding, 'sandboxId' | 'template'> & { linkId?: string }>;
  /** (`linkId`: set when an existing computer was adopted; it dials with ITS link id, not the one in `spec`.) */
  /** Passive: reading the state never wakes anything. `gone` also covers a computer that is not this owner's. */
  status(binding: E2bBinding, signal: AbortSignal): Promise<MachineState>;
  /** Cold boot a stopped computer. */
  start(binding: E2bBinding, signal: AbortSignal): Promise<void>;
  stop(binding: E2bBinding, signal: AbortSignal): Promise<void>;
  /** Remove the computer. Durable storage (BACKEND §7.10) is not part of it. */
  destroy(binding: E2bBinding, signal: AbortSignal): Promise<void>;
  /**
   * Account deletion: remove every computer this owner has on the platform, found by the ownership labels rather than the
   * stored binding (one an interrupted recovery left behind included), and, for a platform whose storage is its own volumes,
   * those volumes too. Only objects carrying this owner's labels are touched. Returns what was removed; nothing left is fine.
   * Absent: the binding's computer is all there is (E2B), and the provider removes that one.
   */
  destroyOwned?(signal: AbortSignal): Promise<{ computers: number; volumes: string[] }>;
  /** Freeze with memory kept. Absent: the provider stops instead (and the next use is a cold start). */
  suspend?(binding: E2bBinding, signal: AbortSignal): Promise<void>;
  resume?(binding: E2bBinding, signal: AbortSignal): Promise<void>;
  /** A platform with its own idle timer (E2B) is told the computer is in use. Best effort. */
  keepAlive?(binding: E2bBinding, windowMs: number): Promise<void>;
  /** The idle window the computer was created with (Docker keeps it in a label), so a restarted computerd does not forget it. */
  idleWindowMs?(binding: E2bBinding, signal: AbortSignal): Promise<number | undefined>;
  /** A platform's own resource sample; absent: the provider samples `/proc` through the link. */
  metrics?(binding: E2bBinding, runtime: SandboxRuntime, signal: AbortSignal): Promise<ComputerMetrics | null>;
}

/** Idle window: the requested minutes clamped to [1 min, lifetime]; non-positive means the lifetime. */
export function idleWindowMs(idlePauseMinutes: number | undefined, lifetimeMs: number): number {
  const minute = 60_000;
  const ceiling = Math.max(lifetimeMs, minute);
  const requested = (idlePauseMinutes ?? 30) * minute;
  if (!Number.isFinite(requested) || requested <= 0) return ceiling;
  return Math.min(Math.max(requested, minute), ceiling);
}

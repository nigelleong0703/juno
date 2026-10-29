/**
 * The sandbox seam. Implemented by the linked provider (`createLinkedProvider`: one body over a lifecycle-only driver per
 * platform, BACKEND §7.11) and by `createFakeProvider` (unit tests), so the executor and the route layer are written once.
 *
 * Every method takes a durable \`E2bBinding\` (not a display): the caller never names a display in a
 * provider call other than through the screen registry, which is the component that enforces
 * "one agent, one screen".
 */
import type { E2bBinding } from '@agent-desktop/contracts';
import type { Duplex } from 'node:stream';
import type { ComputerEnvironment } from './environment.js';
import type { TransferSide } from './path-transfer.js';
import type { SandboxRuntime } from './runtime.js';
import type { ListeningPort, SpaceRegistration } from './spaces.js';
import type {
  ComputerMetrics,
  ComputerHostSpec,
  ProviderKind,
  ScreenAction,
  ScreenActionResult,
  ScreenHandle,
  ScreenRequest,
} from './types.js';

/** What `erase` removed. */
export interface EraseReport {
  /** Computers removed (the stored one and any other the platform still held for this owner). */
  computers: number;
  /** Volumes, object folders and metadata schemas removed from durable storage, in words. */
  removed: string[];
}

export interface ComputerProvider {
  readonly kind: ProviderKind;
  /** Create the sandbox for a new binding and wait until its `juno-link` has dialled in; it suspends itself after the idle timeout. */
  create(host: ComputerHostSpec, signal: AbortSignal): Promise<E2bBinding>;
  /** Connect to a binding, resuming (or cold-starting) it when it is not running. Idempotent. */
  connect(binding: E2bBinding, signal: AbortSignal): Promise<void>;
  /** Suspend the whole computer (memory kept) where the platform can, else stop it (the next use is a cold start). */
  pause(binding: E2bBinding, signal: AbortSignal): Promise<void>;
  /** Remove the computer (and forget what is known about it). Durable storage is untouched; callers treat a failure as best effort. */
  destroy?(binding: E2bBinding, signal: AbortSignal): Promise<void>;
  /**
   * Account deletion (BACKEND §5.2c): remove this owner's computer(s) AND everything they keep on durable storage (`/juno`,
   * `/workspace`, browser profiles: local volumes, or the JuiceFS objects and metadata). `binding` is the stored one or null.
   * Only objects carrying this owner's own labels or derived names are touched. Idempotent: what is already gone is fine,
   * so a failed run is simply run again.
   */
  erase?(binding: E2bBinding | null, signal: AbortSignal): Promise<EraseReport>;
  /** Passive check of a stored binding (never starts anything): usable, removed, or from before the computer link existed. */
  probe?(binding: E2bBinding, signal: AbortSignal): Promise<'ok' | 'gone' | 'unlinked'>;
  /** Allocate-and-start, or return, one agent's display. */
  ensureScreen(binding: E2bBinding, request: ScreenRequest, signal: AbortSignal): Promise<ScreenHandle>;
  /** Forget that a display is booted, so the next `ensureScreen` re-runs its idempotent boot (relaunches a dead Chromium). */
  invalidateScreen(binding: E2bBinding, displayNo: number): void;
  /** Tear one display down (idle reap, or freeing a slot for a newer agent). */
  stopScreen(binding: E2bBinding, displayNo: number, signal: AbortSignal): Promise<void>;
  /** Run one screen action against an already-allocated display (agentId keys the browser profile). */
  act(binding: E2bBinding, agentId: string, displayNo: number, action: ScreenAction, signal: AbortSignal): Promise<ScreenActionResult>;
  /**
   * Run `fn` against the binding's shell and files, resuming a paused VM first. Needs no display: this is how
   * the user's `/juno` home is read and written (home.ts) without a screen or agent control. The runtime is always root (the
   * link's daemon is); `user: 'root'` also first migrates the computer to per-agent users when that has not happened yet.
   */
  withRuntime<T>(binding: E2bBinding, signal: AbortSignal, fn: (runtime: SandboxRuntime) => Promise<T>, options?: { user?: 'root' }): Promise<T>;
  /**
   * `computer_copy`: run `fn` against this agent's side of a copy (files and folders it may read and write as its own Linux
   * user). Counts as activity, needs no display.
   */
  withTransfer<T>(binding: E2bBinding, agentId: string, signal: AbortSignal, fn: (side: TransferSide) => Promise<T>): Promise<T>;
  /** A real sample of the VM's CPU/memory/disk, or null when the sandbox cannot be reached. */
  metrics(binding: E2bBinding, signal: AbortSignal): Promise<ComputerMetrics | null>;
  /**
   * Read-only view of the bound computer: the remote OS/user/home/cwd plus the
   * provider-derived workingDirectory. Never starts a sandbox, never allocates, never
   * falls back to the local machine; an unreachable binding fails truthfully. With `agentId` the
   * user, home and cwd are that agent's own Linux user's (BACKEND §7.9).
   */
  environment(binding: E2bBinding, signal: AbortSignal, agentId?: string): Promise<ComputerEnvironment>;
  /**
   * A byte stream to the noVNC bridge (websockify) of one display, through the computer link; the caller speaks WebSocket over it.
   * `control` picks the read-write or read-only listener. Only the server calls this; nothing of it reaches a client.
   */
  screenStream(binding: E2bBinding, displayNo: number, control: boolean, signal: AbortSignal): Promise<Duplex>;
  /** Spaces (BACKEND 5.12), root in the computer. Every listening TCP port with its owner uid (resumes a paused computer). */
  listeningPorts(binding: E2bBinding, signal: AbortSignal): Promise<ListeningPort[]>;
  /** Verify the app listens on `port` as this agent's user (from the kernel's table), wire its gateway route and firewall rule. Throws `failed` with the reason. */
  registerSpace(binding: E2bBinding, input: SpaceRegistration, signal: AbortSignal): Promise<void>;
  /** Install the gateway key (root-only in the computer) and start the in-computer gateway when it does not answer. */
  ensureSpaceGateway(binding: E2bBinding, gatewayKey: string, signal: AbortSignal): Promise<void>;
  /**
   * A byte stream to the in-computer Spaces gateway (port 7090), through the computer link; the gateway key still guards it.
   * Resumes a suspended computer and counts as activity, unless `passive`: then it neither resumes nor renews, and fails when the computer is not running.
   */
  gatewayStream(binding: E2bBinding, signal: AbortSignal, options?: { passive?: boolean }): Promise<Duplex>;
}

/**
 * The computerd executor facade. It owns the public operations and the small set of policies that
 * are not allocation: user take-over, pause/resume, screenshot bookkeeping and the VNC secrets.
 * The durable binding and the display lease live in \`allocator.ts\`.
 */
import { createHmac } from 'node:crypto';
import type { Store, E2bBinding, ScreenDoc, ControlActor, HandBack, SurfaceRef } from '@agent-desktop/contracts';
import { toScreenResponse, type ScreenResponse } from '@agent-desktop/contracts';
import type { ComputerEnvironment, ComputerHostSpec, ComputerProvider, ScreenPool } from '@agent-desktop/sandbox-adapters';
import { computerRecovering, noScreen, unavailable, userControlStartCommand, userControlStopCommand } from '@agent-desktop/sandbox-adapters';
import type { ComputerStateStore } from '../../infrastructure/computer-state.js';
import { createControlGateway, type AdmitOptions, type ControlGateway } from '../control/gateway.js';
import { attachAdmission } from '../control/request-scope.js';
import { createAllocator, type Allocator } from './allocator.js';
import { createRecovery, type RecoveryOptions } from './recovery.js';
import { MAX_RECOVERIES_PER_REQUEST, staleOf } from './recovery-policy.js';
import { diffSnapshots, snapshotBrowser } from './takeover.js';

export type { HandBack };

export interface LifecycleOptions {
  store: Store;
  provider: ComputerProvider;
  pool: ScreenPool;
  state: ComputerStateStore;
  ownerId: string;
  host: ComputerHostSpec;
  /** Service secret; per-agent VNC passwords are derived from it. */
  secret: string;
  onPoolChange?: () => void;
  /** Timing seams for tests (the real values are in recovery-policy.ts). */
  recovery?: Pick<RecoveryOptions, 'sleep' | 'waitMs'>;
  /** Test seam: how long a take-over waits for the agent's in-flight actions (the real value is the gateway's). */
  drainMs?: number;
}

export interface ScreenVncSecrets {
  controlPassword: string;
  viewPassword: string;
}

export interface ResolvedScreen {
  binding: E2bBinding;
  screen: ScreenDoc;
}

export interface Lifecycle {
  /**
   * Run one request. When it finds the bound computer lost (gone, pre-link, link never connected) the computer is replaced on
   * the same durable storage and the request runs again; `recreated` tells the caller that happened. Waits for a running
   * recovery; after the wait it throws `computer_recovering`.
   */
  recovering<T>(run: () => Promise<T>, signal: AbortSignal): Promise<{ value: T; recreated: boolean }>;
  /** Check a stored binding once per process and archive it when its computer no longer exists (first use then creates a new one). */
  reconcile(): Promise<void>;
  ensureComputer(signal: AbortSignal): Promise<E2bBinding>;
  /** The current binding, or null when this owner has no computer yet. Creates and resumes nothing. */
  currentBinding(): E2bBinding | null;
  /** The computer's gateway key (256 bits, hex): derived from the service secret and the computer id, so it needs no storage and changes with either. Never leaves computerd, the API and the computer's root-only file. */
  gatewayKey(computerId: string): string;
  /**
   * Read-only environment for one agent: the agent row must name this owner and a binding
   * plus screen must already exist. Nothing is created, leased, pinned or resumed on purpose;
   * a missing binding or screen fails truthfully so callers never invent a directory.
   */
  readEnvironment(agentId: string, signal: AbortSignal): Promise<ComputerEnvironment>;
  listScreens(): Promise<ScreenResponse[]>;
  getScreen(agentId: string): Promise<ScreenResponse | null>;
  ensureScreen(agentId: string, signal: AbortSignal): Promise<ScreenResponse>;
  /** The single source of control state for this owner's surfaces (BACKEND 7.8b). */
  readonly control: ControlGateway;
  /** `changed` is true only for the call that moved control from the agent to the user (a double tap is `false`). */
  takeOver(agentId: string, actor: ControlActor, expectEpoch?: number): Promise<ScreenResponse & { changed: boolean }>;
  /** `changed` and `handBack` are present only for the call that actually moved control back to the agent. */
  returnControl(agentId: string, actor: ControlActor, expectEpoch?: number): Promise<ScreenResponse & { changed: boolean; handBack?: HandBack }>;
  pause(signal: AbortSignal): Promise<void>;
  resume(signal: AbortSignal): Promise<void>;
  requireScreen(agentId: string, signal: AbortSignal): Promise<ResolvedScreen>;
  /**
   * Like `requireScreen` but admitted through the control gateway (agent tools path): refused while the user holds or has stopped the
   * surface, and after a hand-back until the agent has looked. The admission is tied to the request `signal` (see request-scope.ts).
   */
  requireAgentControl(agentId: string, signal: AbortSignal, options?: AdmitOptions): Promise<ResolvedScreen>;
  /** The agent's existing screen whoever controls it; never allocates or boots (reads during a takeover). */
  existingScreen(agentId: string): Promise<ResolvedScreen>;
  /** Look up a screen by its own id (the stream ticket carries the id, not the agent). */
  findById(screenId: string): Promise<ScreenDoc | null>;
  /** The same lookup as the client-visible screen (with who holds it). */
  screenById(screenId: string): Promise<ScreenResponse | null>;
  recordScreenshot(screen: ScreenDoc, ref: string): Promise<void>;
  vncSecrets(screen: ScreenDoc): ScreenVncSecrets;
}

/** The per-computer gateway key, derived from the service secret and the computer id (nothing is stored). */
export const gatewayKeyFor = (secret: string, computerId: string) => createHmac('sha256', secret).update(`gateway:${computerId}`).digest('hex');

/** Run a sandbox command without making the caller wait for it; failures are swallowed. */
function background(provider: ComputerProvider, binding: E2bBinding, agentId: string, displayNo: number, command: string): void {
  void provider.act(binding, agentId, displayNo, { kind: 'shell', input: { command, timeoutMs: 15_000 } }, new AbortController().signal).catch(() => undefined);
}

export function createLifecycle(opts: LifecycleOptions): Lifecycle {
  const { store, provider, pool, state, host, secret } = opts;

  const derive = (prefix: string, computerId: string, agentId: string) =>
    createHmac('sha256', secret).update(`${prefix}:${computerId}:${agentId}`).digest('hex').slice(0, 8);

  const secretsFor = (computerId: string, agentId: string): ScreenVncSecrets => ({
    controlPassword: derive('ctl', computerId, agentId),
    viewPassword: derive('view', computerId, agentId),
  });

  const allocator: Allocator = createAllocator({
    store,
    provider,
    pool,
    state,
    ownerId: opts.ownerId,
    host,
    secretsFor,
    ...(opts.onPoolChange ? { onPoolChange: opts.onPoolChange } : {}),
  });

  const recovery = createRecovery({
    store, provider, pool, state, ownerId: opts.ownerId,
    ensureBinding: allocator.ensureBinding,
    ...opts.recovery,
    ...(opts.onPoolChange ? { onPoolChange: opts.onPoolChange } : {}),
  });

  const NO_SIGNAL = new AbortController().signal;
  /** The agent's existing screen and binding without booting anything (a boot can take tens of seconds); first use still allocates. */
  async function existing(agentId: string): Promise<ResolvedScreen> {
    const screen = await allocator.readScreen(agentId);
    const binding = state.get();
    if (screen && binding) return { binding, screen };
    return allocator.resolve(agentId, NO_SIGNAL);
  }

  /** The screen a surface names, with the binding it lives on; undefined when either is gone (the snapshot is then "could not be read"). */
  async function screenOf(surface: SurfaceRef): Promise<{ binding: E2bBinding; screen: ScreenDoc } | undefined> {
    const binding = state.get();
    const screen = surface.kind === 'screen' ? await store.get('screens', surface.screenId) : null;
    return binding && screen ? { binding, screen } : undefined;
  }

  // The cloud screen's effects of a change of holder: the browser before/after (compared at hand-back, never keystrokes) and the
  // watchdog that relaunches a browser the person closed. Mac surfaces have none.
  const control = createControlGateway({
    store,
    ownerId: opts.ownerId,
    ...(opts.drainMs === undefined ? {} : { drainMs: opts.drainMs }),
    effects: {
      async snapshot(surface, signal) {
        const at = await screenOf(surface);
        return at ? snapshotBrowser(provider, at.binding, at.screen.agentId, at.screen.displayNo, signal) : {};
      },
      diff: diffSnapshots,
      taken(surface) {
        void screenOf(surface).then((at) => {
          if (!at) return;
          pool.pin(at.screen.agentId);
          background(provider, at.binding, at.screen.agentId, at.screen.displayNo, userControlStartCommand(at.screen.agentId, at.screen.displayNo));
        });
      },
      released(surface) {
        void screenOf(surface).then((at) => {
          if (!at) return;
          background(provider, at.binding, at.screen.agentId, at.screen.displayNo, userControlStopCommand(at.screen.displayNo));
          pool.unpin(at.screen.agentId);
        });
      },
    },
  });
  const screenSurface = (screen: ScreenDoc): SurfaceRef => ({ kind: 'screen', screenId: screen.id });
  /** The client-visible screen: its row plus who holds it now. */
  const view = async (screen: ScreenDoc): Promise<ScreenResponse> => toScreenResponse(screen, await control.get(screenSurface(screen), screen.agentId));

  return {
    control,
    reconcile: () => recovery.reconcile(),
    async recovering(run, signal) {
      await recovery.reconcile();
      let recreated = false;
      for (let replaced = 0; ; replaced += 1) {
        try {
          return { value: await run(), recreated };
        } catch (error) {
          const stale = staleOf(error);
          if (!stale) throw error;
          if (replaced >= MAX_RECOVERIES_PER_REQUEST) throw computerRecovering('the computer is being restored and will be ready shortly');
          await recovery.recover(stale.computerId, stale.reason, signal);
          recreated = true;
        }
      }
    },
    ensureComputer: (signal) => allocator.ensureBinding(signal),
    currentBinding: () => state.get(),
    gatewayKey: (computerId) => gatewayKeyFor(secret, computerId),
    async readEnvironment(agentId, signal) {
      const assigned = await allocator.readAssigned(agentId);
      if (!assigned.binding) throw unavailable('no computer is bound for this owner yet');
      if (!assigned.screen) throw noScreen(`agent ${agentId} has no screen yet`);
      return provider.environment(assigned.binding, signal, agentId);
    },

    async listScreens() {
      const binding = state.get();
      // Only the active sandbox lists here. Rows from the other provider stay stored untouched
      // (switchback keeps its screen, controller and history) but never appear under this binding.
      // Every page is walked so retired rows cannot crowd the live ones out of a single page.
      if (!binding) return [];
      const live: ScreenDoc[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await store.list('screens', {
          orderBy: 'at',
          order: 'asc',
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const screen of page.items) {
          if (screen.ownerId === opts.ownerId && screen.computerId === binding.sandboxId) live.push(screen);
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return Promise.all(live.map(view));
    },

    async getScreen(agentId) {
      const screen = await allocator.readScreen(agentId);
      return screen ? view(screen) : null;
    },

    async ensureScreen(agentId, signal) {
      const { screen } = await allocator.resolve(agentId, signal);
      await control.ensure(screenSurface(screen), agentId);
      return view(screen);
    },

    async takeOver(agentId, actor, expectEpoch) {
      const { screen } = await existing(agentId);
      const { changed } = await control.take(screenSurface(screen), actor, { agentId, ...(expectEpoch === undefined ? {} : { expectEpoch }) });
      return { ...(await view(screen)), changed };
    },

    async returnControl(agentId, actor, expectEpoch) {
      const screen = await allocator.readScreen(agentId);
      if (!screen) throw noScreen(`no screen for ${agentId}`);
      const { changed, handBack } = await control.release(screenSurface(screen), actor, { agentId, ...(expectEpoch === undefined ? {} : { expectEpoch }) });
      return { ...(await view(screen)), changed, ...(handBack ? { handBack } : {}) };
    },

    async pause(signal) {
      const binding = state.get();
      if (!binding) throw unavailable('no computer to pause');
      await provider.pause(binding, signal);
    },

    async resume(signal) {
      const binding = state.get();
      if (!binding) throw unavailable('no computer to resume');
      await provider.connect(binding, signal);
    },

    async requireScreen(agentId, signal) {
      return allocator.resolve(agentId, signal);
    },

    async requireAgentControl(agentId, signal, options = { mutation: false }) {
      const resolved = await allocator.resolve(agentId, signal);
      pool.touch(agentId);
      // Admission refuses (user_control) while the person holds the screen, and records that the agent was held up so the hand-back continues a run that gave up waiting.
      const admission = await control.admit(screenSurface(resolved.screen), agentId, options);
      if (!attachAdmission(signal, admission)) admission.done();
      return resolved;
    },

    async existingScreen(agentId) {
      const screen = await allocator.readScreen(agentId);
      const binding = state.get();
      if (!screen || !binding) throw noScreen(`agent ${agentId} has no screen yet`);
      return { binding, screen };
    },

    async findById(id) {
      // A stream ticket names a screen id, not a binding: only the active sandbox resolves here.
      // A retired binding's id stays stored (switchback keeps working) but never resolves under
      // another binding, and nothing resolves without a binding at all.
      const binding = state.get();
      if (!binding) return null;
      const screen = await store.get('screens', id);
      return screen?.ownerId === opts.ownerId && screen.computerId === binding.sandboxId ? screen : null;
    },

    async screenById(id) {
      const screen = await this.findById(id);
      return screen ? view(screen) : null;
    },

    async recordScreenshot(screen, ref) {
      await store.patch('screens', screen.id, { screenshotRef: ref }).catch(() => undefined);
    },

    vncSecrets(screen) {
      return secretsFor(screen.computerId, screen.agentId);
    },
  };
}

export type { ScreenResponse, ComputerHostSpec };

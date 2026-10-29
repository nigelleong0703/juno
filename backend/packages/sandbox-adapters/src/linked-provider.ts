/**
 * The computer provider every platform shares (BACKEND §7.11). A `LifecycleDriver` only creates, starts, stops, suspends and
 * destroys machines; everything INSIDE the machine (commands as root, files, screens, byte streams to VNC and the Spaces
 * gateway) goes through the computer link (`juno-link` dialling out to computerd), so this file knows no vendor.
 *
 * One computer per owner, one X display per agent, via the shared screen helpers. Ownership checks live in the driver.
 *
 *  - Idle: a real unref'd timer per computer, renewed by active use (create, connect, ensureScreen, acting, writable streams)
 *    and never by passive reads. When it fires the computer is suspended (memory kept) when the platform can, else stopped
 *    (a cold start later: files are on durable storage, only running processes are lost).
 *  - Generation: every start of the daemon has a `bootId`. A different one than we last saw is a cold start: display file state
 *    of the dead generation is dropped (never killed), browser singleton locks are cleared at the next boot of each display, the
 *    durable storage is mounted again, and `onStarted` runs (Spaces are relaunched). A suspend/resume keeps the id and the screens.
 *  - Passive reads (`environment`, `metrics`, the status gateway stream) never resume, start or renew anything.
 */
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { E2bBinding } from '@agent-desktop/contracts';
import { createLogger } from '@agent-desktop/log';
import { idleWindowMs, type CreateSpec, type LifecycleDriver } from './driver.js';
import { isIdempotentAction } from './action-policy.js';
import { ComputerdError, StaleComputerError, failed, noScreen, unavailable } from './errors.js';
import { ENVIRONMENT_COMMAND, parseEnvironmentOutput } from './environment.js';
import { agentRuntime, prepareComputer, prepareForAgent, prepareScreen } from './isolation.js';
import { createSandboxSide } from './path-transfer.js';
import type { LinkConnection, LinkHub } from './link-hub.js';
import { LINK_WAIT_MS, createLinkRuntime } from './link-runtime.js';
import { readMetrics } from './metrics.js';
import { FIRST_SCREEN_DISPLAY, MAX_LIVE_SCREENS, screenPorts } from './ports.js';
import type { ComputerProvider } from './provider.js';
import type { SandboxRuntime } from './runtime.js';
import { cleanChromiumSingletons, cleanDisplayState, displayXvfbLive } from './screen-cleanup.js';
import { bootScreen, screenHandle, shq, stopScreenCommand } from './screen-boot.js';
import { createScreenFile } from './screen-file.js';
import { runScreenAction } from './screen-actions.js';
import { GATEWAY_PORT, spaceMethods } from './spaces.js';
import type { ComputerStorage } from './storage.js';
import type { ComputerHostSpec, ScreenAction, ScreenRequest } from './types.js';
import { parseResolution } from './types.js';

const log = createLogger({ service: 'sandbox-provider' });

/** Root-only file recording the daemon generation the platform last prepared this computer for. */
export const BOOT_MARKER = '/run/juno/boot-id';
const MARKER_MISSING = 'MARKER-MISSING-9f2';
const ENV_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 4_000;
const ON_STARTED_BUDGET_MS = 120_000;

/** What the platform needs to get a computer back to its working state after a create or a cold start. */
export interface StartedContext {
  binding: E2bBinding;
  reason: 'created' | 'restarted';
  /** Root in the computer. */
  root: SandboxRuntime;
  /** Make sure the agent has its Linux user, then a runtime that acts as that user. */
  asAgent(agentId: string): Promise<SandboxRuntime>;
  signal: AbortSignal;
}

export interface LinkedProviderOptions {
  driver: LifecycleDriver;
  hub: LinkHub;
  /** What a new computer dials: `wss://computerd.example/v1/computer-link`, or `ws://host.docker.internal:<port>/...` for local Docker. */
  linkUrl: string;
  ownerId: string;
  /** Used when the host spec names no template. */
  image: string;
  /** Where /juno, /workspace and browser profiles live (BACKEND 7.10); absent keeps them on the computer's own disk. */
  storage?: ComputerStorage;
  /** Idle window when neither the host spec nor the driver knows one. */
  defaultIdleMs?: number;
  /** After a computer is created or cold-started (and its storage mounted): relaunch what lived only in memory. */
  onStarted?: (context: StartedContext) => Promise<void>;
  /** How long a call waits for a link that is not up yet. */
  linkWaitMs?: number;
}

interface ComputerState {
  screens: Set<number>;
  idleMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The daemon generation this process last prepared the computer for. */
  bootId: string | undefined;
  /** Displays whose Chromium singleton locks still need clearing (consumed only by a successful boot). */
  restartPending: Set<number>;
}

export function createLinkedProvider(options: LinkedProviderOptions): ComputerProvider & { dispose(): void } {
  const { driver, hub } = options;
  const files = createScreenFile();
  const states = new Map<string, ComputerState>();
  const waitMs = options.linkWaitMs ?? LINK_WAIT_MS;
  const defaultIdleMs = options.defaultIdleMs ?? 30 * 60_000;

  function stateFor(id: string, idleMs: number): ComputerState {
    const existing = states.get(id);
    if (existing) return existing;
    const created: ComputerState = { screens: new Set(), idleMs, timer: undefined, bootId: undefined, restartPending: new Set() };
    states.set(id, created);
    return created;
  }

  const linkIdOf = (binding: E2bBinding): string => {
    if (binding.linkId === undefined) {
      throw new StaleComputerError('unlinked', `computer ${short(binding)} was created before the computer link existed`, binding.sandboxId);
    }
    return binding.linkId;
  };

  /** The platform's own runtime in the computer: root, over the link. The per-call signal is the default, so a cancelled run reaches the process group. */
  function rootRuntime(binding: E2bBinding, signal: AbortSignal): SandboxRuntime {
    return createLinkRuntime({ hub, linkId: linkIdOf(binding), signal, waitMs });
  }

  function touch(binding: E2bBinding, state: ComputerState): void {
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    void driver.keepAlive?.(binding, state.idleMs).catch(() => undefined);
    if (state.idleMs <= 0) return;
    const timer = setTimeout(() => {
      state.timer = undefined;
      void idleSuspend(binding).catch(() => undefined);
    }, state.idleMs);
    timer.unref();
    state.timer = timer;
  }

  /** Suspend when the platform can (memory kept), else stop: files are on durable storage either way. */
  async function suspendOrStop(binding: E2bBinding, signal: AbortSignal): Promise<void> {
    if ((await driver.status(binding, signal)) !== 'running') return;
    if (driver.suspend) await driver.suspend(binding, signal);
    else await driver.stop(binding, signal);
  }

  async function idleSuspend(binding: E2bBinding): Promise<void> {
    try {
      await suspendOrStop(binding, new AbortController().signal);
    } catch {
      // Best effort: a gone or foreign computer simply stays as it is.
    }
  }

  /**
   * The computer's link, with the computer running. `active` resumes a suspended computer and starts a stopped one
   * (and renews the idle timer); passive callers fail instead of waking anything.
   */
  async function ready(binding: E2bBinding, active: boolean, signal: AbortSignal): Promise<LinkConnection> {
    const linkId = linkIdOf(binding);
    const status = await driver.status(binding, signal);
    if (status === 'gone') {
      throw new StaleComputerError('gone', `computer ${short(binding)} no longer exists`, binding.sandboxId);
    }
    let resumed = false;
    if (status !== 'running') {
      if (!active) throw failed(`computer ${short(binding)} is ${status}; reconnect to resume it`);
      if (status === 'suspended' && driver.resume) await driver.resume(binding, signal);
      else await driver.start(binding, signal);
      resumed = true;
    }
    let link = await waitForLink(binding, signal);
    // After a resume the old socket may be dead (a frozen VM keeps no timers): prove the link, or make the daemon dial again.
    if (resumed) {
      const alive = await link.health(AbortSignal.any([signal, AbortSignal.timeout(HEALTH_TIMEOUT_MS)])).then(() => true, () => false);
      if (!alive) {
        hub.drop(linkId);
        link = await waitForLink(binding, signal);
      }
    }
    const state = states.get(binding.sandboxId) ?? stateFor(binding.sandboxId, (await driver.idleWindowMs?.(binding, signal)) ?? defaultIdleMs);
    if (active) {
      await syncGeneration(binding, state, link, signal);
      touch(binding, state);
    }
    return link;
  }

  /** A link that does not come up within the bounded wait means the computer is unusable: stale, so computerd replaces it. */
  async function waitForLink(binding: E2bBinding, signal: AbortSignal): Promise<LinkConnection> {
    try {
      return await hub.waitFor(linkIdOf(binding), waitMs, signal);
    } catch (error) {
      if (error instanceof ComputerdError && error.code === 'unavailable') {
        throw new StaleComputerError('link_timeout', `computer ${short(binding)} is running but its link did not connect within ${Math.round(waitMs / 1000)}s`, binding.sandboxId);
      }
      throw error;
    }
  }

  /** Every display may hold a stale Chromium singleton (profiles outlive computers); each is cleared once, at its next successful boot. */
  function markRestartPending(state: ComputerState): void {
    for (let displayNo = FIRST_SCREEN_DISPLAY; displayNo < FIRST_SCREEN_DISPLAY + MAX_LIVE_SCREENS; displayNo += 1) state.restartPending.add(displayNo);
  }

  /** Detect a cold start from the daemon's boot id and put the computer back in order (see the file header). */
  async function syncGeneration(binding: E2bBinding, state: ComputerState, link: LinkConnection, signal: AbortSignal): Promise<void> {
    if (state.bootId === link.bootId) return;
    const root = rootRuntime(binding, signal);
    if (state.bootId === undefined) {
      // Our first look after a computerd start: the marker the last preparation left decides whether the computer restarted since.
      const marker = await readMarker(root, signal);
      if (marker === link.bootId) {
        state.bootId = link.bootId;
        return;
      }
      if (marker === undefined) {
        // A computer this platform never marked: drop only what a failed Xvfb probe proves dead, adopt anything live.
        for (const displayNo of [...state.screens]) {
          if (!(await displayXvfbLive(root, displayNo, signal))) {
            await cleanDisplayState(root, displayNo, signal);
            state.screens.delete(displayNo);
          }
        }
        await writeMarker(root, link.bootId);
        state.bootId = link.bootId;
        return;
      }
    }
    // A different generation than the one prepared: every process of the old one is dead, so its pid files (possibly recycled
    // pids) are dropped without killing, and the mounts a cold start loses are made again.
    for (const displayNo of state.screens) await cleanDisplayState(root, displayNo, signal);
    state.screens.clear();
    markRestartPending(state);
    await options.storage?.attach(root, options.ownerId, signal);
    await writeMarker(root, link.bootId);
    state.bootId = link.bootId;
    log.info({ computer: short(binding) }, 'computer cold-started: display state dropped, storage mounted');
    await started(binding, 'restarted', root);
  }

  async function started(binding: E2bBinding, reason: StartedContext['reason'], root: SandboxRuntime): Promise<void> {
    if (!options.onStarted) return;
    const signal = AbortSignal.timeout(ON_STARTED_BUDGET_MS);
    const context: StartedContext = {
      binding,
      reason,
      root,
      signal,
      async asAgent(agentId) {
        await prepareForAgent(root, binding.sandboxId, agentId);
        return agentRuntime(root, binding.sandboxId, agentId);
      },
    };
    try {
      await options.onStarted(context);
    } catch (error) {
      // Relaunching is a convenience: a failure must not make the computer unusable.
      log.warn({ err: error, computer: short(binding), reason }, 'post-start recovery failed');
    }
  }

  async function readMarker(root: SandboxRuntime, signal: AbortSignal): Promise<string | undefined> {
    const result = await root.run(`cat ${shq(BOOT_MARKER)} 2>/dev/null || echo ${MARKER_MISSING}`, { timeoutMs: 30_000, signal });
    const text = result.stdout.trim();
    return text === '' || text === MARKER_MISSING ? undefined : text;
  }

  async function writeMarker(root: SandboxRuntime, bootId: string): Promise<void> {
    try {
      await root.writeText(BOOT_MARKER, bootId + '\n');
    } catch (error) {
      throw failed(`could not record the computer's start marker: ${message(error)}`);
    }
  }

  /** Serialize mutating operations per computer so cleanup and boot cannot interleave. */
  const locks = new Map<string, Promise<void>>();
  async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(id);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    locks.set(id, gate);
    if (prev) await prev;
    try {
      return await fn();
    } finally {
      if (locks.get(id) === gate) locks.delete(id);
      release();
    }
  }

  async function destroyBound(binding: E2bBinding, signal: AbortSignal): Promise<void> {
    const state = states.get(binding.sandboxId);
    if (state?.timer) clearTimeout(state.timer);
    states.delete(binding.sandboxId);
    await driver.destroy(binding, signal);
    if (binding.linkId !== undefined) hub.drop(binding.linkId);
  }

  const provider: ComputerProvider & { dispose(): void } = {
    kind: driver.kind,

    async create(host: ComputerHostSpec, signal: AbortSignal): Promise<E2bBinding> {
      parseResolution(host.resolution);
      const linkId = randomUUID();
      const token = hub.tokenFor(linkId);
      const spec: CreateSpec = {
        image: host.template || options.image,
        host,
        env: { JUNO_LINK_URL: options.linkUrl, JUNO_LINK_ID: linkId, JUNO_LINK_TOKEN: token },
        link: { url: options.linkUrl, id: linkId, token },
      };
      const made = await driver.create(spec, signal);
      const binding: E2bBinding = { ...made, linkId: made.linkId ?? linkId };
      try {
        // The computer boots, juno-link dials in; only then can anything be done inside it.
        const link = await hub.waitFor(binding.linkId as string, waitMs, signal);
        const root = rootRuntime(binding, signal);
        await options.storage?.attach(root, options.ownerId, signal);
        await writeMarker(root, link.bootId);
        const state = stateFor(binding.sandboxId, idleWindowMs(host.idlePauseMinutes, host.timeoutMs));
        state.bootId = link.bootId;
        // A browser profile on durable storage may carry the lock of a browser that ran in a computer that no longer exists.
        markRestartPending(state);
        touch(binding, state);
        await started(binding, 'created', root);
      } catch (error) {
        await driver.destroy(binding, new AbortController().signal).catch(() => undefined);
        if (error instanceof ComputerdError) throw error;
        throw unavailable(`could not create computer: ${message(error)}`);
      }
      return binding;
    },

    async connect(binding, signal) {
      return withLock(binding.sandboxId, async () => {
        await ready(binding, true, signal);
      });
    },

    async pause(binding, signal) {
      return withLock(binding.sandboxId, async () => {
        await suspendOrStop(binding, signal);
        const state = states.get(binding.sandboxId);
        if (state?.timer) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
      });
    },

    async ensureScreen(binding, request: ScreenRequest, signal) {
      return withLock(binding.sandboxId, async () => {
        await ready(binding, true, signal);
        const state = states.get(binding.sandboxId);
        if (!state) throw failed(`computer ${short(binding)} has no local state after connect`);
        if (!state.screens.has(request.displayNo)) {
          const root = rootRuntime(binding, signal);
          // First, so a migration stops the old-style screens by their pid files before anything below cleans those away.
          // It stopped every screen, whatever this process remembered.
          if (await prepareScreen(root, binding.sandboxId, request.agentId, request.displayNo)) state.screens.clear();
          const pending = state.restartPending.has(request.displayNo);
          if (!(await displayXvfbLive(root, request.displayNo, signal))) await cleanDisplayState(root, request.displayNo, signal);
          if (pending) await cleanChromiumSingletons(root, request.agentId, signal);
          await bootScreen(root, request);
          state.screens.add(request.displayNo);
          state.restartPending.delete(request.displayNo);
        }
        touch(binding, state);
        return screenHandle(request);
      });
    },

    invalidateScreen(binding, displayNo) {
      states.get(binding.sandboxId)?.screens.delete(displayNo);
    },

    async stopScreen(binding, displayNo, signal) {
      return withLock(binding.sandboxId, async () => {
        try {
          await ready(binding, true, signal);
        } catch (error) {
          if (error instanceof StaleComputerError) {
            states.get(binding.sandboxId)?.screens.delete(displayNo);
            return;
          }
          throw error;
        }
        const root = rootRuntime(binding, signal);
        const state = states.get(binding.sandboxId);
        const known = state?.screens.has(displayNo) ?? false;
        // Killing works off pidfiles: only run it against processes known live -- either we booted this display in this
        // generation, or the display answers (eviction after a provider restart). Anything else is stale file state from a dead
        // generation, dropped without killing since a recycled pid would belong to an unrelated process.
        if (!known && !(await displayXvfbLive(root, displayNo, signal))) {
          await cleanDisplayState(root, displayNo, signal);
          state?.screens.delete(displayNo);
          return;
        }
        const result = await root.run(stopScreenCommand(displayNo), { timeoutMs: STOP_TIMEOUT_MS, signal });
        if (result.exitCode !== 0) throw failed(`could not stop screen :${displayNo}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
        state?.screens.delete(displayNo);
      });
    },

    async act(binding, agentId, displayNo, action: ScreenAction, signal) {
      return withLock(binding.sandboxId, async () => {
        const attempt = async () => {
          await ready(binding, true, signal);
          const root = rootRuntime(binding, signal);
          return runScreenAction(files, agentRuntime(root, binding.sandboxId, agentId), root, agentId, displayNo, action, signal);
        };
        try {
          return await attempt();
        } catch (error) {
          // The link dropped under a pure read: wait for it to come back (bounded) and read again, once. Never for an action that may have acted.
          const linkDropped = error instanceof ComputerdError && error.code === 'unavailable' && !(error instanceof StaleComputerError);
          if (!linkDropped || !isIdempotentAction(action) || signal.aborted) throw error;
          return attempt();
        }
      });
    },

    destroy: destroyBound,

    async erase(binding, signal) {
      let computers = 0;
      if (binding) {
        try {
          await destroyBound(binding, signal);
          computers += 1;
        } catch (error) {
          // Gone already is fine. A computer that is not this owner's (a damaged binding) is refused by the driver and left alone.
          if (error instanceof ComputerdError && error.code === 'not_allowed') log.warn({ computer: short(binding) }, 'the stored computer is not this owner\'s: left alone');
          else if (!(error instanceof StaleComputerError)) throw error;
        }
      }
      const owned = (await driver.destroyOwned?.(signal)) ?? { computers: 0, volumes: [] };
      const purged = (await options.storage?.purge?.(options.ownerId, signal)) ?? [];
      return { computers: computers + owned.computers, removed: [...owned.volumes.map((name) => `volume ${name}`), ...purged] };
    },

    async probe(binding, signal) {
      if (binding.linkId === undefined) return 'unlinked';
      return (await driver.status(binding, signal)) === 'gone' ? 'gone' : 'ok';
    },

    async withRuntime<T>(binding: E2bBinding, signal: AbortSignal, fn: (runtime: SandboxRuntime) => Promise<T>, runOptions?: { user?: 'root' }): Promise<T> {
      return withLock(binding.sandboxId, async () => {
        await ready(binding, true, signal);
        const root = rootRuntime(binding, signal);
        if (runOptions?.user === 'root' && (await prepareComputer(root, binding.sandboxId))) states.get(binding.sandboxId)?.screens.clear();
        return fn(root);
      });
    },

    async withTransfer(binding, agentId, signal, fn) {
      return withLock(binding.sandboxId, async () => {
        await ready(binding, true, signal);
        const root = rootRuntime(binding, signal);
        if (await prepareForAgent(root, binding.sandboxId, agentId)) states.get(binding.sandboxId)?.screens.clear();
        return fn(createSandboxSide(root, agentRuntime(root, binding.sandboxId, agentId)));
      });
    },

    async environment(binding, signal, agentId) {
      // Passive: never resume a suspended computer and never renew the idle timer; it fails truthfully instead.
      await ready(binding, false, signal);
      const root = rootRuntime(binding, signal);
      if (agentId !== undefined && (await prepareForAgent(root, binding.sandboxId, agentId))) states.get(binding.sandboxId)?.screens.clear();
      const runtime = agentId === undefined ? root : agentRuntime(root, binding.sandboxId, agentId);
      const result = await runtime.run(ENVIRONMENT_COMMAND, { timeoutMs: ENV_TIMEOUT_MS, signal });
      if (result.exitCode !== 0) throw failed(`could not read the computer environment: ${result.stderr || result.stdout}`);
      try {
        return parseEnvironmentOutput(result.stdout);
      } catch (error) {
        throw failed(`could not read the computer environment: ${message(error)}`);
      }
    },

    async metrics(binding, signal) {
      // Passive: never connect, resume or renew. A suspended, stopped or unlinked computer has no live sample.
      try {
        if ((await driver.status(binding, signal)) !== 'running' || hub.get(linkIdOf(binding)) === undefined) return null;
        const runtime = rootRuntime(binding, signal);
        return driver.metrics ? await driver.metrics(binding, runtime, signal) : await readMetrics(runtime);
      } catch {
        return null;
      }
    },

    async screenStream(binding, displayNo, control, signal): Promise<Duplex> {
      // Only a writable stream (the user holds control) renews; a read-only watch must not keep the computer awake.
      const link = await ready(binding, control, signal);
      if (!states.get(binding.sandboxId)?.screens.has(displayNo)) throw noScreen(`screen :${displayNo} is not allocated on this connection`);
      const ports = screenPorts(displayNo);
      return link.openStream(control ? ports.web : ports.readOnlyWeb, signal);
    },

    ...spaceMethods((binding, signal, fn) => provider.withRuntime(binding, signal, fn, { user: 'root' })),

    async gatewayStream(binding, signal, streamOptions): Promise<Duplex> {
      const link = await ready(binding, streamOptions?.passive !== true, signal);
      return link.openStream(GATEWAY_PORT, signal);
    },

    dispose(): void {
      for (const state of states.values()) if (state.timer) clearTimeout(state.timer);
      states.clear();
    },
  };
  return provider;
}

const short = (binding: { sandboxId: string }) => binding.sandboxId.slice(0, 12);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

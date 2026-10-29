/**
 * The owner's Mac as a computer (My Mac). It is reached over the same computer link as a sandbox, but it is not managed by
 * the platform: nothing is created, paused or recovered, and when the link is down the answer is a plain "your Mac is
 * offline" (never a silent fallback to the sandbox). The Mac's daemon limits itself to ~/Juno; what may run at all is
 * decided by the tool policy (approvals), not here.
 *
 * Shell, files and background processes run through the generic `SandboxRuntime` over the link, so they behave exactly as in
 * the sandbox; background-process scratch lives in `~/Juno/.juno/proc` because that is the only place the daemon lets us write.
 */
import { createLinkRuntime, createMacSide, createSandboxProcesses, failed, notAllowed, parseEnvironment, unavailable } from '@agent-desktop/sandbox-adapters';
import type { ComputerEnvironment, LinkConnection, LinkHub, SandboxProcesses, ShellInput, ShellOutput, FileContent, FileWriteRequest, FileWriteResult, TransferSide } from '@agent-desktop/sandbox-adapters';
import type { DesktopAction, DesktopRequest, DeviceAction, DeviceDeclaration, HealthResult } from 'juno-link/protocol';
import type { ControlActor, SurfaceRef } from '@agent-desktop/contracts';
import { browserAdmission, LOOK, MUTATE } from '../control/classify.js';
import { CONTROL_CHANGED_NOTE, ControlRefusal, type AdmitOptions, type ControlGateway } from '../control/gateway.js';
import type { MacLink, MacRegistry } from './registry.js';

export const MAC_OFFLINE = 'Your Mac was offline before the action was sent. Open Juno on your Mac (and keep it awake) and ask again; nothing was run.';
export const MAC_OFFLINE_AFTER_DISPATCH = 'The connection to your Mac dropped after the action was sent. It may have run, so inspect the current state on the Mac before deciding whether to retry. Do not repeat an input or browser action automatically.';
export const MAC_DESKTOP_UNAVAILABLE = 'This Mac is connected but its desktop helper is unavailable. Update or restart Juno on the Mac; the sandbox was not used.';
const NOT_PAIRED = 'Your Mac is not connected: no Mac is paired with this account (it may have been unpaired). Pair it again in Juno on your Mac (Settings > My Mac); nothing was run.';
/** A connected Mac that declared nothing: the hub refuses such a Mac's HELLO, so this only guards a link that slipped past it. */
export const MAC_UNDECLARED = 'This Mac has not said what it can do. Update Juno on the Mac and reconnect; nothing was run.';
/** How long a call waits for a Mac whose link is just reconnecting. */
const RECONNECT_WAIT_MS = 2_500;

/** What the agent is told when the Mac did not declare an action: what is missing and what the owner can do about it. */
const NOT_DECLARED: Record<DeviceAction, string> = {
  files: 'This Mac does not share files with Juno right now. Ask the owner to reconnect My Mac in Juno on the Mac; nothing was run.',
  shell: 'This Mac does not run commands for Juno right now. Ask the owner to reconnect My Mac in Juno on the Mac; nothing was run.',
  desktop: "The Mac can't work other apps for Juno right now: its desktop driver isn't running, or Juno doesn't have Screen Recording and Accessibility. Ask the owner to check My Mac in Juno on the Mac (and System Settings > Privacy & Security), then try again; nothing was run.",
  browser: "Chrome isn't connected to Juno on the Mac: the Juno Chrome extension isn't installed or enabled. Ask the owner to set up Chrome in Juno on the Mac (Settings > My Mac), then try again; nothing was run.",
  audio: "The Mac can't record system audio for Juno right now (the permission isn't granted). Ask the owner to allow Juno in System Settings > Privacy & Security > Screen & System Audio Recording, then try again; nothing was run.",
  apps: "Mail, Calendar and Reminders aren't available through Juno on this Mac right now. Ask the owner to check My Mac in Juno on the Mac, then try again; nothing was run.",
};

/** The declared action a desktop action needs; `permissions` is owner-only and `audio_stop` must always work to end a recording. */
const DESKTOP_NEEDS: Partial<Record<DesktopAction, DeviceAction>> = {
  snapshot: 'desktop',
  act: 'desktop',
  verify: 'desktop',
  browser: 'browser',
  audio_start: 'audio',
  mac_apps: 'apps',
};

/** Refuse an action the Mac did not declare. */
function requireDeclared(device: DeviceDeclaration | undefined, action: DeviceAction | undefined): void {
  if (action === undefined) return;
  if (device === undefined) throw failed(MAC_UNDECLARED);
  if (!device.actions.includes(action)) throw notAllowed(NOT_DECLARED[action]);
}

export interface MacStatus {
  paired: boolean;
  name?: string;
  pairedAt?: string;
  online: boolean;
  /** What the connected Mac declared it can do right now (absent while offline). */
  device?: DeviceDeclaration;
  user?: string;
  home?: string;
  /** The folder the agent works in on the Mac (`~/Juno`). */
  folder?: string;
  /** Present while the person has Stopped the Mac (BACKEND 7.8b). */
  stopped?: { since: string; epoch: number };
}

export interface MacComputer {
  status(): Promise<MacStatus>;
  environment(signal: AbortSignal): Promise<ComputerEnvironment>;
  shell(input: ShellInput, signal: AbortSignal): Promise<ShellOutput>;
  readFile(path: string, signal: AbortSignal): Promise<FileContent>;
  writeFile(input: FileWriteRequest, signal: AbortSignal): Promise<FileWriteResult>;
  processes: SandboxProcesses;
  /** `computer_copy`: run `fn` against the Mac's side of a copy (its files and folders, inside the shared folder). */
  withTransfer<T>(signal: AbortSignal, fn: (side: TransferSide) => Promise<T>): Promise<T>;
  /** Optional desktop host RPC. The action and input are the link protocol's exact data shapes. */
  desktop(agentId: string, action: DesktopAction, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  /** Create the Mac's control row (at pairing, so the first Stop has a row to lock). */
  ensureControl(): Promise<void>;
  /** Stop all agent access to the Mac, from any client; the Mac cancels what runs. Resuming happens only on the Mac itself. */
  stop(actor: ControlActor): Promise<MacStatus>;
}

export interface MacComputers {
  forOwner(owner: string): MacComputer;
}

export interface MacComputersOptions {
  hub: LinkHub;
  registry: MacRegistry;
  /** The owner's control gateway: the one place that says whether the person has Stopped the Mac. */
  control(owner: string): ControlGateway;
  waitMs?: number;
}

export function createMacComputers(options: MacComputersOptions): MacComputers {
  return {
    forOwner(owner) {
      const paired = (): MacLink => {
        const link = options.registry.get(owner);
        if (!link) throw notAllowed(NOT_PAIRED);
        return link;
      };
      /** The Mac's host facts, from its daemon (a live link is also the proof that it is online). */
      const host = async (link: MacLink, signal?: AbortSignal): Promise<NonNullable<HealthResult['host']> & { folder: string; device: DeviceDeclaration | undefined }> => {
        const connection = await options.hub.waitFor(link.id, options.waitMs ?? RECONNECT_WAIT_MS, signal);
        const info = (await connection.health(signal)).host;
        const folder = info?.roots?.[0];
        if (!info || !folder) throw failed('This Mac did not say which folder it shares; update Juno on the Mac.');
        return { ...info, folder, device: connection.device() };
      };
      const offline = (error: unknown): never => {
        if (error instanceof Error && 'code' in error && error.code === 'unavailable') throw failed(MAC_OFFLINE);
        throw error;
      };
      const control = options.control(owner);
      const surface = (link: MacLink): SurfaceRef => ({ kind: 'mac', macId: link.id });
      /**
       * Run one agent operation through the control gateway (BACKEND 7.8b): refused (`user_control`, holder `stopped`) while the person has
       * Stopped the Mac or after a resume until the agent has looked, and aborted if a Stop outlives the drain window. The Mac's own daemon
       * enforces the same Stop; this makes it hold even when the Mac is offline or a call has not reached it yet.
       */
      const admitted = async <T>(link: MacLink, agentId: string | undefined, admit: AdmitOptions, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        const admission = await control.admit(surface(link), agentId, admit);
        try {
          return await run(AbortSignal.any([signal, admission.signal]));
        } catch (error) {
          if (admission.signal.aborted && !signal.aborted) throw new ControlRefusal(CONTROL_CHANGED_NOTE, 'mac', 'stopped');
          throw error;
        } finally {
          admission.done();
        }
      };
      const desktopAdmission = (action: DesktopAction, input: Record<string, unknown>): AdmitOptions => {
        if (action === 'snapshot' || action === 'verify') return LOOK;
        if (action === 'act') return MUTATE;
        if (action === 'browser') return browserAdmission(typeof input['action'] === 'string' ? input['action'] : '');
        return { mutation: false };
      };
      const desktop = (agentId: string, action: DesktopAction, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> =>
        admitted(paired(), agentId, desktopAdmission(action, input), signal, (inner) => desktopOnMac(agentId, action, input, inner));
      const desktopOnMac = async (agentId: string, action: DesktopAction, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
        const link = paired();
        let connection: LinkConnection;
        let info: NonNullable<HealthResult['host']>;
        try {
          connection = await options.hub.waitFor(link.id, options.waitMs ?? RECONNECT_WAIT_MS, signal);
          // The Mac's own word comes first: "not granted" is the answer the owner can act on, before any helper check.
          requireDeclared(connection.device(), DESKTOP_NEEDS[action]);
          const health = await connection.health(signal);
          if (!health.host) throw unavailable(MAC_DESKTOP_UNAVAILABLE);
          info = health.host;
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'unavailable') throw unavailable(MAC_OFFLINE);
          throw error;
        }
        if (info.desktop !== true) throw unavailable(MAC_DESKTOP_UNAVAILABLE);
        const request: DesktopRequest = { agentId, action, input };
        try {
          return await connection.desktop(request, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof Error && 'code' in error && error.code === 'unavailable') {
            const predispatch = error.message.startsWith("the Mac is offline: desktop '") && error.message.includes('was not sent and did not run');
            throw unavailable(predispatch ? MAC_OFFLINE : MAC_OFFLINE_AFTER_DISPATCH);
          }
          throw error;
        }
      };
      /** One operation against the Mac: its runtime starts in ~/Juno, and a lost link reads as offline. */
      const withMac = async <T>(signal: AbortSignal, need: DeviceAction | undefined, run: (runtime: ReturnType<typeof createLinkRuntime>, folder: string) => Promise<T>, gate = true): Promise<T> => {
        const link = paired();
        // Ending what the agent started (stop / clean up a background process) must keep working while the Mac is Stopped.
        if (gate) return admitted(link, undefined, { mutation: false }, signal, (inner) => runOnMac(link, inner, need, run));
        return runOnMac(link, signal, need, run);
      };
      const runOnMac = async <T>(link: MacLink, signal: AbortSignal, need: DeviceAction | undefined, run: (runtime: ReturnType<typeof createLinkRuntime>, folder: string) => Promise<T>): Promise<T> => {
        let dispatched = false;
        try {
          const { folder, device } = await host(link, signal);
          requireDeclared(device, need);
          dispatched = true;
          return await run(createLinkRuntime({ hub: options.hub, linkId: link.id, signal, cwd: folder, waitMs: options.waitMs ?? RECONNECT_WAIT_MS }), folder);
        } catch (error) {
          if (dispatched && error instanceof Error && 'code' in error && error.code === 'unavailable') throw unavailable(MAC_OFFLINE_AFTER_DISPATCH);
          return offline(error);
        }
      };
      const processes: SandboxProcesses = {
        start: (agentId, input, signal) => withMac(signal, 'shell', (runtime, folder) => createSandboxProcesses(runtime, `${folder}/.juno/proc`).start(agentId, input, signal)),
        read: (agentId, input, signal) => withMac(signal, 'shell', (runtime, folder) => createSandboxProcesses(runtime, `${folder}/.juno/proc`).read(agentId, input, signal)),
        write: (agentId, input, signal) => withMac(signal, 'shell', (runtime, folder) => createSandboxProcesses(runtime, `${folder}/.juno/proc`).write(agentId, input, signal)),
        // Stopping and cleaning up must keep working after the declaration shrank, so they are not gated.
        stop: (agentId, input, signal) => withMac(signal, undefined, (runtime, folder) => createSandboxProcesses(runtime, `${folder}/.juno/proc`).stop(agentId, input, signal), false),
        cleanup: (agentId, signal) => withMac(signal, undefined, (runtime, folder) => createSandboxProcesses(runtime, `${folder}/.juno/proc`).cleanup(agentId, signal), false),
      };
      return {
        async status() {
          const link = options.registry.get(owner);
          if (!link) return { paired: false, online: false };
          const held = await control.get(surface(link));
          const base = { paired: true, name: link.name, pairedAt: link.pairedAt, ...(held.holder === 'stopped' ? { stopped: { since: held.since, epoch: held.epoch } } : {}) };
          if (!options.hub.get(link.id)) return { ...base, online: false };
          try {
            const info = await host(link);
            return { ...base, online: true, user: info.user, home: info.home, folder: info.folder, ...(info.device === undefined ? {} : { device: info.device }) };
          } catch {
            return { ...base, online: false };
          }
        },
        async ensureControl() {
          await control.ensure(surface(paired()));
        },
        async stop(actor) {
          const link = paired();
          await control.stop(surface(link), actor);
          // A connected Mac cancels what runs and answers with what it cancelled; an offline one learns it when it connects (the hub asks the gateway).
          options.hub.sendStop(link.id);
          return this.status();
        },
        async environment(signal) {
          const link = paired();
          try {
            const info = await host(link, signal);
            return parseEnvironment({
              os: `macOS (Darwin ${info.release}, ${info.arch})`,
              platform: info.platform,
              user: info.user,
              home: info.home,
              workingDirectory: info.folder,
              pathStyle: 'posix',
              kind: 'mac',
              ...(info.device === undefined ? {} : { device: { name: info.device.name, osVersion: info.device.osVersion, actions: info.device.actions } }),
            });
          } catch (error) {
            return offline(error);
          }
        },
        // A Mac has no virtual display: a command is just run in the folder (no DISPLAY).
        shell: (input, signal) => withMac(signal, 'shell', async (runtime, folder) => {
          const result = await runtime.run(input.command, { timeoutMs: input.timeoutMs, cwd: input.cwd ?? folder, signal });
          return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
        }),
        readFile: (path, signal) => withMac(signal, 'files', async (runtime) => {
          const content = await runtime.readText(path);
          return { content, bytes: Buffer.byteLength(content) };
        }),
        writeFile: (input, signal) => withMac(signal, 'files', async (runtime) => {
          await runtime.writeText(input.path, input.content);
          return { path: input.path, bytes: Buffer.byteLength(input.content) };
        }),
        desktop,
        processes,
        withTransfer: (signal, fn) => withMac(signal, 'files', (runtime, folder) => fn(createMacSide(runtime, folder))),
      };
    },
  };
}

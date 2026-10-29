import type { MyMacLinkState } from "@agent-desktop/app";
import { startLinkDaemon, type LinkActivity, type LinkDaemon, type LinkStatus, type DaemonOptions } from "juno-link/daemon";
import type { DeviceAction, DeviceDeclaration } from "juno-link/protocol";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * My Mac: this Mac as a computer for the user's agents. The pairing the server issued (link address, id, token) is kept in the
 * secret store (Keychain through `safeStorage`) and the link daemon runs here, in the main process, as the signed-in macOS user.
 * The daemon is the same `juno-link` every platform computer runs: it dials the server out, so the Mac needs no open port, and
 * it limits itself to one folder (`~/Juno`): files and commands outside it are refused here even when the user approved them
 * on the server. Which actions ask the user first is decided on the server.
 *
 * The Mac also tells the server what it can do (the link's `device` declaration): files and commands always, the rest only
 * once it works (cua-driver running with Screen Recording and Accessibility granted to Juno, the Chrome extension). The declaration is made when the link
 * connects and again whenever it changes; the server refuses what is not declared, so nothing is promised that would fail.
 */

const SECRET_KEY = "my-mac.pairing";
const DEVICE_KEY = "my-mac.device-id";
/** How often the granted permissions are looked at again while linked (the user grants them in System Settings, outside this app). */
const REDECLARE_MS = 10_000;

/** What the desktop host reports about this Mac right now. */
export interface MacAbilities {
  /** cua-driver is running and Juno has both Screen Recording and Accessibility. */
  desktop: boolean;
  audio: boolean;
  chrome: boolean;
}

/** The actions to declare: files and commands always; `apps` (its permission is asked on first use) and the working rest when there is a desktop host. */
export function declaredActions(abilities: MacAbilities | undefined): DeviceAction[] {
  const actions: DeviceAction[] = ["files", "shell"];
  if (abilities === undefined) return actions;
  actions.push("apps");
  if (abilities.desktop) actions.push("desktop");
  if (abilities.chrome) actions.push("browser");
  if (abilities.audio) actions.push("audio");
  return actions;
}

export interface MyMacPairing {
  id: string;
  url: string;
  token: string;
}

export interface MyMacSecrets {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

export interface MyMacOptions {
  /** The folder the agents work in (`~/Juno`); created on first connect. */
  folder: string;
  /** Where the daemon writes the programs it runs (owner-only). */
  scratchDir: string;
  deviceName: string;
  /** e.g. `macOS 15.2`, declared to the server with the name. */
  osVersion: string;
  /** Which optional abilities work now; absent when this app has no desktop host (then only files and commands are declared). */
  abilities?: () => Promise<MacAbilities>;
  secrets: MyMacSecrets;
  /** The daemon's environment: a GUI app starts with a minimal PATH, so the user's tools need adding. */
  childEnv: NodeJS.ProcessEnv;
  startDaemon?: typeof startLinkDaemon;
  desktop?: DaemonOptions["desktop"];
  /** cua-driver's client: the daemon answers snapshot, act and verify through it. */
  cua?: DaemonOptions["cua"];
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface MyMac {
  state(): MyMacLinkState;
  /** The pairing kept from last time (if any) comes back up. */
  restore(): Promise<void>;
  connect(pairing: MyMacPairing): Promise<void>;
  disconnect(): Promise<void>;
  /** Take the link down without forgetting the saved pairing (the app is quitting). */
  suspend(): void;
  setStopped(stopped: boolean): void;
  /** Look at the abilities again now (after the user was sent to grant one) and tell the server if they changed. */
  refreshDeclaration(): Promise<void>;
  onChange(listener: (state: MyMacLinkState) => void): () => void;
}

/** A pairing handed over by the renderer: only a websocket address and plain strings are accepted. */
export function parsePairing(value: unknown): MyMacPairing | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, url, token } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof url !== "string" || typeof token !== "string") return null;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id) || token.length < 16 || token.length > 512) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
  } catch {
    return null;
  }
  return { id, url, token };
}

export function createMyMac(options: MyMacOptions): MyMac {
  const start = options.startDaemon ?? startLinkDaemon;
  const listeners = new Set<(state: MyMacLinkState) => void>();
  let pairing: MyMacPairing | undefined;
  let daemon: LinkDaemon | undefined;
  let status: LinkStatus = "offline";
  let activity: LinkActivity = { running: 0, stopped: false };
  let deviceId: string | undefined;
  let declaration: DeviceDeclaration | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  /** Stable across restarts, so the server can tell this Mac from another with the same name. */
  const identify = async (): Promise<string> => {
    if (deviceId !== undefined) return deviceId;
    const stored = await options.secrets.get(DEVICE_KEY);
    if (typeof stored === "string" && stored !== "") return (deviceId = stored);
    deviceId = randomUUID();
    await options.secrets.set(DEVICE_KEY, deviceId);
    return deviceId;
  };
  const declare = async (): Promise<DeviceDeclaration> => {
    const abilities = options.abilities === undefined ? undefined : await options.abilities().catch(() => undefined);
    return { deviceId: await identify(), name: options.deviceName, osVersion: options.osVersion, actions: declaredActions(abilities) };
  };
  const refresh = async () => {
    const next = await declare();
    const changed = declaration === undefined || next.actions.join() !== declaration.actions.join();
    declaration = next;
    if (changed) daemon?.redeclare();
  };

  const state = (): MyMacLinkState => ({
    paired: pairing !== undefined,
    status,
    running: activity.running,
    ...(activity.command === undefined ? {} : { command: activity.command }),
    stopped: activity.stopped,
    deviceName: options.deviceName,
    folder: options.folder,
  });
  const changed = () => {
    const next = state();
    for (const listener of listeners) listener(next);
  };
  const halt = () => {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = undefined;
    daemon?.stop();
    daemon = undefined;
    activity = { running: 0, stopped: false };
  };
  const run = async (next: MyMacPairing) => {
    // Declared before the first frame goes out: the server refuses a Mac that does not say what it can do.
    const first = await declare();
    halt();
    declaration = first;
    mkdirSync(options.folder, { recursive: true, mode: 0o755 });
    pairing = next;
    status = "connecting";
    daemon = start({
      loadConfig: () => (pairing === undefined ? undefined : { url: pairing.url, id: pairing.id, token: pairing.token }),
      device: () => declaration ?? first,
      roots: [options.folder],
      scratchDir: options.scratchDir,
      shell: "/bin/zsh",
      childEnv: options.childEnv,
      ...(options.desktop === undefined ? {} : { desktop: options.desktop }),
      ...(options.cua === undefined ? {} : { cua: options.cua }),
      ...(options.log === undefined ? {} : { log: options.log }),
      onStatus: (next) => {
        status = next;
        // The server no longer accepts this pairing (revoked, or paired again elsewhere): forget it so the user connects again.
        if (next === "unauthorized") void forget();
        else changed();
      },
      onActivity: (next) => {
        activity = next;
        changed();
      },
    });
    refreshTimer = setInterval(() => void refresh().catch(() => undefined), REDECLARE_MS);
    refreshTimer.unref();
    changed();
  };
  const forget = async () => {
    halt();
    pairing = undefined;
    await options.secrets.delete(SECRET_KEY);
    changed();
  };

  return {
    state,
    async restore() {
      const stored = await options.secrets.get(SECRET_KEY);
      if (stored === null) return;
      let parsed: MyMacPairing | null;
      try {
        parsed = parsePairing(JSON.parse(stored));
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        await options.secrets.delete(SECRET_KEY);
        return;
      }
      await run(parsed);
    },
    async connect(next) {
      await options.secrets.set(SECRET_KEY, JSON.stringify(next));
      await run(next);
    },
    disconnect: forget,
    suspend() {
      halt();
      pairing = undefined;
      changed();
    },
    setStopped(stopped) {
      if (stopped) daemon?.pause();
      else daemon?.resume();
    },
    refreshDeclaration: refresh,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The folder agents work in on this Mac. */
export function junoFolder(home: string): string {
  return join(home, "Juno");
}

/** Where a GUI-launched app finds the user's command line tools (Homebrew, system). */
export function commandPath(current: string | undefined): string {
  const wanted = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const have = (current ?? "").split(":").filter(Boolean);
  return [...have, ...wanted.filter((entry) => !have.includes(entry))].join(":");
}

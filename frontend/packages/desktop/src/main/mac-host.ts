/** Desktop composition: the paired link uses cua-driver for other apps, native audio, and the owner's Chrome bridge. */
import type { MyMacDesktopState } from "@agent-desktop/app";
import { join } from "node:path";
import { createChromeBridge } from "./chrome-bridge";
import { createCuaHost } from "./cua-host";
import { createMacDesktop } from "./mac-desktop";
import type { MacAbilities } from "./my-mac";

interface MacHostOptions {
  userDataDir: string;
  folder: string;
  resourcesRoot: string;
  extensionPath: string;
  chromeHome?: string;
  /** The cua-driver executable; defaults to the one bundled under `resourcesRoot/cua-driver`. */
  cuaBinary?: string;
  /** Juno's bundle id, echoed to cua-driver (the grants are Juno's whatever this says). */
  bundleId: string;
  log(message: string): void;
  /** cua-driver went up or down: the declaration to the server may change. */
  onDesktopChange(): void;
  openSettings(kind: "screen" | "accessibility"): Promise<void>;
  showExtension(path: string): void;
  openChromeExtensions(): Promise<void>;
}

/** The host stays alive across link reconnects; stop cancels work, dispose tears down the app's bridge and cua-driver. */
export function createMacHost(options: MacHostOptions) {
  const chrome = createChromeBridge({
    userDataDir: options.userDataDir,
    extensionPath: options.extensionPath,
    ...(options.chromeHome === undefined ? {} : { chromeHome: options.chromeHome }),
    nativeHostPath: join(options.resourcesRoot, "chrome-bridge", "juno-chrome-host"),
  });
  const cua = createCuaHost({
    binaryPath: options.cuaBinary ?? join(options.resourcesRoot, "cua-driver", "cua-driver"),
    hostBundleId: options.bundleId,
    log: (message) => options.log(message),
    onChange: options.onDesktopChange,
  });
  const native = createMacDesktop({
    folder: options.folder,
    helperPath: join(options.resourcesRoot, "mac-helper", "juno-mac-helper"),
    browser: async (agentId, input, signal) => {
      await setup();
      return chrome.browser(agentId, input, signal);
    },
  });
  // Registration prepares a native-messaging host, never installs an extension or grants access to a tab.
  let ready: Promise<void> | undefined;
  const setup = () => {
    ready ??= chrome.setup().catch((error) => { ready = undefined; throw error; });
    return ready;
  };
  // An installed extension can reconnect after the app restarts; setup failures remain visible on explicit setup.
  void setup().catch(() => undefined);

  // macOS caches a grant per process, so a daemon started before the user granted sees "not granted" until it is replaced.
  // One replacement per grant; if it still disagrees afterwards, the next inspection reports it.
  let restartedForGrant = false;
  const inspect = async (): Promise<{ state: MyMacDesktopState; desktop: boolean }> => {
    const chromeConnected = chrome.connected();
    try {
      const raw = await native.handle({ agentId: "owner", action: "permissions", input: {} }, new AbortController().signal);
      const info = typeof raw === "object" && raw !== null ? raw : {};
      const screen = Reflect.get(info, "screen") === true;
      const accessibility = Reflect.get(info, "accessibility") === true;
      const state: MyMacDesktopState = { screen, accessibility, audio: Reflect.get(info, "audio") === true, chrome: chromeConnected };
      if (!screen || !accessibility) {
        restartedForGrant = false;
        return { state, desktop: false };
      }
      if (!cua.running()) return { state: { ...state, detail: "Desktop control is not running. Juno keeps trying; restart Juno if this stays." }, desktop: false };
      const seen = await cua.permissions().catch(() => undefined);
      if (seen?.host && seen.screen && seen.accessibility) return { state, desktop: true };
      if (seen !== undefined && !seen.host) return { state: { ...state, detail: "Desktop control is not using Juno's permissions." }, desktop: false };
      if (!restartedForGrant) {
        restartedForGrant = true;
        void cua.restart().catch((error) => options.log(`cua-driver restart failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      return { state, desktop: false };
    } catch (error) {
      return { state: { screen: false, accessibility: false, audio: false, chrome: chromeConnected, detail: error instanceof Error ? error.message : "Mac permissions could not be checked" }, desktop: false };
    }
  };

  return {
    /** The client the link daemon uses for snapshot, act and verify. */
    cua: cua.client,
    /** Starts cua-driver (idempotent). The link calls it once a Mac is paired; on failure the Mac just does not declare `desktop`. */
    startDesktop() {
      return cua.start().catch((error) => options.log(`cua-driver did not start: ${error instanceof Error ? error.message : String(error)}`));
    },
    async handle(request: Parameters<typeof native.handle>[0], signal: AbortSignal) {
      // Only the owner's local UI may request a permission prompt.
      return native.handle(request.action === "permissions" ? { ...request, input: {} } : request, signal);
    },
    stop: () => native.stop(),
    async status(): Promise<MyMacDesktopState> {
      return (await inspect()).state;
    },
    /** What to declare to the server: `desktop` only while cua-driver runs with both grants. */
    async abilities(): Promise<MacAbilities> {
      const { state, desktop } = await inspect();
      return { desktop, audio: state.audio, chrome: state.chrome };
    },
    async requestPermission(kind: "screen" | "accessibility") {
      await native.handle({ agentId: "owner", action: "permissions", input: { request: kind } }, new AbortController().signal);
      await options.openSettings(kind);
    },
    async setupChrome() {
      await setup();
      options.showExtension(options.extensionPath);
      await options.openChromeExtensions();
    },
    /** App quit: resolves once cua-driver is gone. */
    async dispose() {
      native.stop();
      chrome.stop();
      await cua.stop();
    },
  };
}
